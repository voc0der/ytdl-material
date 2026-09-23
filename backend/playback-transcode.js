// Playback copies for players that cannot decode what was downloaded, which in practice
// means AV1. A playback link created with `transcode: true` is served an H.264/AAC MP4
// written once to appdata/transcodes, through the same byte-range handling as the
// original. Copies are keyed by file uid, so later links reuse them until the
// delete_old_transcodes task reaps them.
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const transcoding = require('./transcoding');
const logger = require('./logger');

const TRANSCODE_DIR = path.join(__dirname, 'appdata', 'transcodes');

// H.264 players decode 8-bit 4:2:0. A 10-bit AV1 source would otherwise come out as
// High 10 from libx264, or fail outright on the GPU encoders.
const EIGHT_BIT_FILTER = 'format=nv12';

// uid -> {status: 'pending' | 'failed', error}. A finished copy has no entry: the file on
// disk is the record, which is what lets a copy outlive a restart.
const jobs = new Map();

// One encode at a time. Consumer NVENC cards cap concurrent sessions, and the software
// fallback already uses every core it is given.
let queue = Promise.resolve();

// uids come out of the database, so one never becomes part of a path directly
function copyName(uid) {
    return crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 32);
}

function copyPath(uid) {
    return path.join(TRANSCODE_DIR, `${copyName(uid)}.mp4`);
}

function isFresh(uid, source_path) {
    try {
        return fs.statSync(copyPath(uid)).mtimeMs >= fs.statSync(source_path).mtimeMs;
    } catch {
        return false;
    }
}

exports.buildTranscodeArgs = (source_path, output_path, hardware_settings) => {
    const hardware_filters = hardware_settings ? hardware_settings.video_filters : [];
    const filters = hardware_filters.includes(EIGHT_BIT_FILTER) ? hardware_filters : [EIGHT_BIT_FILTER, ...hardware_filters];

    const args = ['-y'];
    if (hardware_settings) args.push(...hardware_settings.input_options);
    // 0:V skips embedded cover art, which is stored as a second video stream
    args.push('-i', source_path, '-map', '0:V:0', '-map', '0:a:0?', '-vf', filters.join(','));
    if (hardware_settings) args.push('-c:v', hardware_settings.video_encoder, ...hardware_settings.quality_options);
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    // faststart puts the index up front, so a player can start before it has the whole file
    args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', output_path);
    return args;
}

async function transcode(uid, source_path) {
    const output_path = copyPath(uid);
    const part_path = `${output_path}.part`;
    await fs.promises.mkdir(TRANSCODE_DIR, {recursive: true});

    // The copy is always MP4, so that, not the source container, decides hardware eligibility.
    const attempts = transcoding.getFfmpegAttempts('.mp4');
    const start_time = Date.now();
    logger.info(`Transcoding '${source_path}' for playback using ${transcoding.describeFfmpegSettings(attempts[0])}. This can take a while for large files.`);

    let error = null;
    for (let i = 0; i < attempts.length; i++) {
        const args = exports.buildTranscodeArgs(source_path, part_path, attempts[i]);
        // the resolved command line is the only definitive record of which encoder ran
        logger.debug(`ffmpeg playback transcode command: ffmpeg ${args.join(' ')}`);
        const result = await transcoding.runFfmpeg(args);
        if (result.success) {
            // Renamed only once ffmpeg has finished, so a copy on disk is always complete.
            await fs.promises.rename(part_path, output_path);
            const elapsed_seconds = ((Date.now() - start_time) / 1000).toFixed(1);
            logger.info(`Transcoded '${source_path}' for playback in ${elapsed_seconds}s using ${transcoding.describeFfmpegSettings(attempts[i])}.`);
            return;
        }
        error = result.error;
        if (i + 1 < attempts.length) {
            logger.warn(`Playback transcode using ${transcoding.describeFfmpegSettings(attempts[i])} failed for '${source_path}': ${error}. Retrying with ${transcoding.describeFfmpegSettings(attempts[i + 1])}.`);
        }
    }

    await fs.promises.rm(part_path, {force: true});
    throw new Error(error || 'ffmpeg failed');
}

/**
 * Queue a playback copy of a library file unless one is already queued, running, or on
 * disk and newer than its source. Synchronous, so two links created for the same file at
 * once cannot both queue it.
 * @returns {boolean} whether the copy is ready to stream now
 */
exports.request = (file) => {
    const {uid, path: source_path} = file;
    const job = jobs.get(uid);
    if (job && job.status === 'pending') return false;
    if (isFresh(uid, source_path)) {
        jobs.delete(uid);
        return true;
    }

    jobs.set(uid, {status: 'pending'});
    queue = queue.then(() => transcode(uid, source_path)).then(
        () => jobs.delete(uid),
        err => {
            jobs.set(uid, {status: 'failed', error: err.message});
            logger.error(`Playback transcode failed for '${source_path}': ${err.message}`);
        }
    );
    return false;
}

/**
 * What the stream route serves for a transcoding link. Never starts work: only creating
 * a link does that.
 * @returns {{status: 'pending' | 'failed' | 'missing'} | {status: 'ready', path: string}}
 */
exports.getCopy = (uid) => {
    const job = jobs.get(uid);
    if (job) return {status: job.status};
    const copy_path = copyPath(uid);
    return fs.existsSync(copy_path) ? {status: 'ready', path: copy_path} : {status: 'missing'};
}

/**
 * Delete copies older than max_age_ms that no queued or running job, and none of the
 * uids in_use_uids() returns, still needs. Half-written copies left by a crash are
 * reaped the same way.
 */
exports.reap = async (max_age_ms, in_use_uids) => {
    const now = Date.now();
    let entries = [];
    try {
        entries = await fs.promises.readdir(TRANSCODE_DIR);
    } catch (err) {
        if (err.code !== 'ENOENT') logger.error(`Could not list playback transcodes in '${TRANSCODE_DIR}': ${err.message}`);
    }

    const old_entries = [];
    for (const entry of entries) {
        try {
            const {mtimeMs} = await fs.promises.stat(path.join(TRANSCODE_DIR, entry));
            if (now - mtimeMs > max_age_ms) old_entries.push(entry);
        } catch {
            // removed since the listing
        }
    }

    // Nothing is awaited from here on, so no link can be created or job queued between
    // deciding that a copy is unused and deleting it.
    const pending_uids = [...jobs].filter(([, job]) => job.status === 'pending').map(([uid]) => uid);
    const in_use = new Set([...in_use_uids(), ...pending_uids].map(copyName));
    let removed = 0;
    for (const entry of old_entries) {
        if (in_use.has(entry.split('.')[0])) continue;
        try {
            fs.rmSync(path.join(TRANSCODE_DIR, entry), {recursive: true, force: true});
            removed++;
        } catch (err) {
            logger.error(`Could not delete playback transcode '${entry}': ${err.message}`);
        }
    }

    logger.info(`Deleted ${removed} old playback transcode${removed === 1 ? '' : 's'}, kept ${entries.length - removed}.`);
    return {removed, kept: entries.length - removed};
}
