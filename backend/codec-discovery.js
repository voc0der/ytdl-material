// The Codec discovery task. Every run records the codecs of files whose records have none.
// With ytdl_preferred_codec set, and the task's convert_to_preferred option left on, it then
// converts every other video to that codec: downloaded again from the source when the source
// offers it at the same resolution, transcoded otherwise. One file at a time, so a GPU's
// session limit is never the question.
const fs = require('fs-extra');
const path = require('path');
const { statfs } = require('fs').promises;

const codecs = require('./codecs');
const transcoding = require('./transcoding');
const config_api = require('./config');
const db_api = require('./db');
const downloader_api = require('./downloader');
const youtubedl_api = require('./youtube-dl');
const files_api = require('./files');
const utils = require('./utils');
const logger = require('./logger');

const TASK_KEY = 'codec_discovery';

// A converted file is written beside its original under this suffix and renamed into place
// only once it has been checked. No media extension, so a library scan never imports one.
const PART_SUFFIX = '.codec-part';

// How often a long transcode says how far along it is.
const PROGRESS_LOG_INTERVAL_MS = 60 * 1000;

let work_dir = path.join(__dirname, 'appdata', 'codec-work');
let active_run = null;
let last_lookup_at = 0;

exports.TASK_KEY = TASK_KEY;
exports.PART_SUFFIX = PART_SUFFIX;

// Tests point this at a throwaway directory.
exports.setWorkDir = (dir) => {
    work_dir = dir;
}

function journalPath() {
    return path.join(work_dir, 'job.json');
}

function downloadDir() {
    return path.join(work_dir, 'download');
}

/*************************************************
 * The journal: which file is being converted, and
 * every path the conversion may create.
 *
 * Written before the first of those paths exists
 * and removed after the last is settled, so a
 * journal on disk at startup always means a
 * conversion was cut off, and says exactly what
 * to clean up.
 *
 * Written to a temporary name and renamed, so a
 * crash mid-write leaves the old journal or the
 * new one, never half of one.
 ************************************************/
async function writeJournal(job) {
    await fs.ensureDir(work_dir);
    const temporary_path = `${journalPath()}.tmp`;
    await fs.writeJSON(temporary_path, job);
    await fs.rename(temporary_path, journalPath());
}

async function readJournal() {
    try {
        return await fs.readJSON(journalPath());
    } catch {
        return null;
    }
}

async function clearWork() {
    await fs.remove(journalPath());
    await fs.remove(`${journalPath()}.tmp`);
    await fs.remove(downloadDir());
}

// A path only counts as ours if the conversion could have made it: the right suffix, or
// written after the job started.
async function createdSince(file_path, started_at) {
    try {
        const stats = await fs.stat(file_path);
        return stats.mtimeMs >= started_at - 1000;
    } catch {
        return false;
    }
}

async function refreshRecord(uid, file_path, type = 'video') {
    const update = await files_api.readFileCodecs(file_path, type);
    try {
        update.size = (await fs.stat(file_path)).size;
    } catch {
        // gone; the missing files check deals with that
    }
    if (Object.keys(update).length > 0) await db_api.updateRecord('files', {uid}, update);
}

/*************************************************
 * Undo a conversion the process stopped in the
 * middle of, whether a container was torn down or
 * the server crashed.
 *
 * The database record is the commit point. A file
 * that changes container is renamed into place
 * first and its record repointed after, so:
 * record already on the new path -- the original
 * only still needs deleting; record on the old
 * path -- the new file is thrown away and the
 * original stands. A file keeping its container is
 * swapped in by a single rename, so it is either
 * the original or the finished conversion, and its
 * record is re-read from whichever it is.
 *
 * Nothing resumes. The task is left idle, and the
 * next run picks the file up again from scratch.
 ************************************************/
exports.recoverInterruptedWork = async () => {
    const job = await readJournal();
    if (job && job.uid && job.source_path && job.final_path && job.part_path) {
        const record = await db_api.getRecord('files', {uid: job.uid});
        const moves_file = job.final_path !== job.source_path;
        const committed = moves_file && !!record && record.path === job.final_path;

        if (job.part_path.endsWith(PART_SUFFIX)) await fs.remove(job.part_path);
        if (moves_file && committed) {
            await fs.remove(job.source_path);
        } else if (moves_file && await createdSince(job.final_path, job.started_at)) {
            await fs.remove(job.final_path);
        }

        if (record) await refreshRecord(record.uid, record.path, record.isAudio ? 'audio' : 'video');
        logger.warn(`Codec discovery was interrupted while converting '${job.source_path}' to ${codecs.describeCodec(job.codec)}. `
            + (committed
                ? 'The conversion had already been saved, so only the original was left to delete.'
                : 'The unfinished conversion was discarded and the original kept. The next run will try it again.'));
    }
    await clearWork();
}

/*************************************************
 * Run the task. A second run started while one is
 * going joins it rather than converting the same
 * files alongside it.
 ************************************************/
exports.run = async () => {
    if (!active_run) {
        active_run = runTask().finally(() => {
            active_run = null;
        });
    }
    return await active_run;
}

async function runTask() {
    const task = await db_api.getRecord('tasks', {key: TASK_KEY});
    const options = (task && task.options) || {};

    await exports.recoverInterruptedWork();

    const summary = {
        discovered: 0,
        unreadable: 0,
        converted: 0,
        reacquired: 0,
        transcoded: 0,
        already: 0,
        failed: 0,
        skipped: 0,
        remaining: 0,
        stopped: null
    };

    const files = (await db_api.getRecords('files')) || [];
    await discoverCodecs(files, summary);

    const preferred_codec = codecs.normalizePreferredCodec(config_api.getConfigItem('ytdl_preferred_codec'));
    if (!preferred_codec) {
        logger.verbose('Codec discovery is not converting anything: no preferred codec is set.');
    } else if (options.convert_to_preferred === false) {
        logger.info(`Codec discovery is not converting anything: its "Convert to the preferred codec" option is off.`);
    } else {
        const max_conversions = Math.max(0, Math.floor(Number(options.max_conversions) || 0));
        await convertLibrary(files, preferred_codec, max_conversions, summary);
    }

    logSummary(summary, preferred_codec);

    const problems = [];
    if (summary.stopped) problems.push(summary.stopped);
    if (summary.failed > 0) problems.push(`${summary.failed} file${summary.failed === 1 ? '' : 's'} could not be converted. The log says why.`);
    if (problems.length > 0) await db_api.updateRecord('tasks', {key: TASK_KEY}, {error: problems.join(' ')});

    return summary;
}

function hasCodecs(file) {
    return file.vcodec !== undefined || file.acodec !== undefined;
}

async function discoverCodecs(files, summary) {
    for (const file of files) {
        if (hasCodecs(file)) continue;
        const found = file.path ? await files_api.readFileCodecs(file.path, file.isAudio ? 'audio' : 'video') : {};
        if (!hasCodecs(found)) {
            summary.unreadable++;
            continue;
        }
        await db_api.updateRecord('files', {uid: file.uid}, found);
        Object.assign(file, found);
        summary.discovered++;
    }
}

async function convertLibrary(files, codec, max_conversions, summary) {
    const candidates = files.filter(file => !file.isAudio && file.vcodec && file.vcodec !== codec);

    // Files that have never failed go first, so one that fails on every run cannot use up
    // a limited run ahead of files that would convert.
    const failed_at = file => (file.codec_conversion_error && file.codec_conversion_error.at) || 0;
    candidates.sort((a, b) => (failed_at(a) - failed_at(b)) || ((a.registered || 0) - (b.registered || 0)));

    let attempted = 0;
    for (let i = 0; i < candidates.length; i++) {
        if (max_conversions > 0 && attempted >= max_conversions) {
            summary.remaining = candidates.length - i;
            break;
        }

        const outcome = await convertFile(candidates[i], codec);
        if (outcome.status === 'converted') {
            attempted++;
            summary.converted++;
            summary[outcome.method]++;
        } else if (outcome.status === 'failed') {
            attempted++;
            summary.failed++;
        } else if (outcome.status === 'skipped') {
            summary.skipped++;
        } else if (outcome.status === 'already') {
            summary.already++;
        } else if (outcome.status === 'stopped') {
            summary.stopped = outcome.reason;
            summary.remaining = candidates.length - i;
            break;
        }
    }
}

async function recordProblem(file, codec, reason) {
    await db_api.updateRecord('files', {uid: file.uid}, {codec_conversion_error: {codec, reason, at: Date.now()}});
}

/*************************************************
 * Convert one file, or say why not.
 *
 * Resolves {status}: 'converted' (with the method
 * that did it), 'already' when the file turned out
 * to be in the codec, 'skipped' when it was left
 * alone without trying, 'failed' when converting
 * was tried and did not work, and 'stopped' when
 * nothing else should be tried this run either.
 ************************************************/
async function convertFile(file, codec) {
    const source_path = file.path;
    if (!source_path || !utils.isServableMediaFile(source_path, file.user_uid)) {
        return {status: 'skipped', reason: 'the file is missing'};
    }

    const probed = await transcoding.probeMedia(source_path);
    const video_stream = probed && codecs.findVideoStream(probed.streams);
    if (!video_stream) {
        await recordProblem(file, codec, 'ffprobe found no video stream in it');
        return {status: 'skipped'};
    }

    const current = codecs.readCodecsFromProbe(probed);
    if (current.vcodec === codec) {
        await db_api.updateRecord('files', {uid: file.uid}, {...current, codec_conversion_error: null});
        return {status: 'already'};
    }

    if (codecs.isHdrStream(video_stream)) {
        const reason = 'it is HDR, and converting it would flatten it to SDR';
        logger.info(`Codec discovery is leaving '${source_path}' as ${codecs.describeCodec(current.vcodec)}: ${reason}.`);
        await recordProblem(file, codec, reason);
        return {status: 'skipped'};
    }

    const source_ext = path.extname(source_path).toLowerCase();
    const output_ext = codecs.chooseOutputExtension(source_ext, codec);
    const final_path = output_ext === source_ext ? source_path : `${utils.removeFileExtension(source_path)}${output_ext}`;
    if (final_path !== source_path && await fs.pathExists(final_path)) {
        const reason = `a ${codecs.describeCodec(codec)} copy needs a ${output_ext} file, and '${path.basename(final_path)}' already exists`;
        logger.warn(`Codec discovery is leaving '${source_path}' alone: ${reason}.`);
        await recordProblem(file, codec, reason);
        return {status: 'skipped'};
    }

    const space_problem = await describeSpaceProblem(source_path);
    if (space_problem) return {status: 'stopped', reason: space_problem};

    const job = {
        uid: file.uid,
        codec,
        source_path,
        final_path,
        part_path: `${final_path}${PART_SUFFIX}`,
        started_at: Date.now()
    };
    await writeJournal(job);

    const label = codecs.describeCodec(codec);
    logger.info(`Codec discovery is converting '${source_path}' from ${codecs.describeCodec(current.vcodec)} to ${label}.`);
    try {
        let method = 'reacquired';
        const not_reacquired = await reacquire(file, probed, job, output_ext);
        if (not_reacquired) {
            logger.verbose(`Transcoding '${source_path}' rather than downloading it again: ${not_reacquired}.`);
            await transcode(job, probed, output_ext);
            const problem = await describeMismatch(job.part_path, codec, probed);
            if (problem) throw new Error(`the transcoded copy ${problem}`);
            method = 'transcoded';
        }

        await commit(file, job);
        logger.info(`Converted '${final_path}' to ${label} by ${method === 'reacquired' ? 'downloading it again' : 'transcoding it'}.`);
        return {status: 'converted', method};
    } catch (err) {
        await fs.remove(job.part_path);
        logger.error(`Codec discovery could not convert '${source_path}' to ${label}: ${err.message}`);
        await recordProblem(file, codec, err.message);
        return {status: 'failed'};
    } finally {
        await clearWork();
    }
}

// Room for the new copy beside the old one, which is only deleted once the new one is in
// place. A conversion rarely comes out much bigger than its source.
async function describeSpaceProblem(source_path) {
    try {
        const {size} = await fs.stat(source_path);
        const {bavail, bsize} = await statfs(path.dirname(source_path));
        const free = bavail * bsize;
        if (free >= size * 1.5) return null;
        return `Codec discovery stopped converting: only ${Math.floor(free / 1048576)} MiB are free beside '${source_path}', `
            + `which needs about ${Math.ceil(size * 1.5 / 1048576)} MiB.`;
    } catch {
        return null;
    }
}

/*************************************************
 * What is wrong with a converted copy, or null.
 *
 * It has to be in the codec, run as long as the
 * original, and keep audio if the original had
 * any. The length check is what catches a source
 * that has been re-edited since, or a download
 * that stopped early.
 ************************************************/
async function describeMismatch(file_path, codec, original_probe) {
    const probed = await transcoding.probeMedia(file_path);
    if (!probed) return 'could not be read back';
    const found = codecs.readCodecsFromProbe(probed);
    if (found.vcodec !== codec) return `came out as ${codecs.describeCodec(found.vcodec)}`;

    const expected_duration = Number(original_probe.format && original_probe.format.duration);
    const duration = Number(probed.format && probed.format.duration);
    if (expected_duration > 0 && !codecs.durationsMatch(duration, expected_duration)) {
        return `runs ${Math.round(duration)}s where the original runs ${Math.round(expected_duration)}s`;
    }
    if (codecs.findAudioStreams(original_probe.streams).length > 0 && !found.acodec) return 'has no audio';
    return null;
}

async function pauseBetweenLookups() {
    const wait_ms = last_lookup_at + downloader_api.getMinimumSleepBetweenDownloadsMs() - Date.now();
    if (wait_ms > 0) await utils.wait(wait_ms);
    last_lookup_at = Date.now();
}

function describeDownloadError(err) {
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    const error_line = stderr.split('\n').find(line => line.startsWith('ERROR')) || err.message || String(err);
    return error_line.trim().substring(0, 300);
}

/*************************************************
 * Download the file again in the codec, when the
 * source offers it at the file's resolution or
 * better. Leaves the result at job.part_path.
 *
 * Resolves null on success, or why it did not
 * (which is never fatal: the caller transcodes).
 *
 * The source's length is compared before anything
 * is downloaded. A file that was trimmed, snipped
 * or had SponsorBlock segments cut runs shorter
 * than its source, and downloading it again would
 * put back what was taken out.
 ************************************************/
async function reacquire(file, probed, job, output_ext) {
    if (!file.url) return 'it has no source URL';
    if (downloader_api.getPreferredDownloaderFork({}) !== 'yt-dlp') return 'only yt-dlp can choose a format by codec';

    await pauseBetweenLookups();
    const info_list = await downloader_api.getVideoInfoByURL(file.url, await downloader_api.generateReacquireArgs());
    const info = Array.isArray(info_list) && info_list.length === 1 ? info_list[0] : null;
    if (!info) return 'its source could not be looked up';

    const duration = Number(probed.format && probed.format.duration);
    if (Number(info.duration) > 0 && !codecs.durationsMatch(info.duration, duration)) {
        return `the source runs ${Math.round(info.duration)}s but the file runs ${Math.round(duration)}s, so it was cut after downloading`;
    }

    const height = Number(codecs.findVideoStream(probed.streams).height) || 0;
    const format = codecs.pickReacquireFormat(info.formats, job.codec, height);
    if (!format) return `the source has no ${codecs.describeCodec(job.codec)} at ${height ? `${height}p or better` : 'any resolution'}`;

    let format_selector = String(format.format_id);
    const has_audio = codecs.findAudioStreams(probed.streams).length > 0;
    if (has_audio && codecs.normalizeAudioCodec(format.acodec) === null) {
        const original_audio = codecs.getOriginalAudioFormatId(utils.getJSON(file.path, 'video'));
        format_selector = original_audio
            ? `${format.format_id}+${original_audio}/${format.format_id}+bestaudio`
            : `${format.format_id}+bestaudio`;
    }

    await fs.emptyDir(downloadDir());
    const args = await downloader_api.generateReacquireArgs({
        output_template: path.join(downloadDir(), 'media.%(ext)s'),
        format_selector,
        merge_output_format: codecs.getMuxer(output_ext) === 'matroska' ? 'mkv' : codecs.getMuxer(output_ext)
    });

    let result;
    try {
        const {callback} = await youtubedl_api.runYoutubeDL(file.url, args, null, 'yt-dlp');
        result = await callback;
    } catch (err) {
        return `yt-dlp could not be started (${err.message})`;
    }
    if (result && result.err instanceof Error) return `the download failed: ${describeDownloadError(result.err)}`;

    const downloaded = (await fs.readdir(downloadDir()))
        .filter(name => name.startsWith('media.') && !name.endsWith('.part') && !name.endsWith('.ytdl'))
        .map(name => path.join(downloadDir(), name));
    if (downloaded.length !== 1) return 'the download did not leave exactly one file behind';

    const problem = await describeMismatch(downloaded[0], job.codec, probed);
    if (problem) return `the downloaded copy ${problem}`;

    // A download can come back in another container than asked for, when the chosen format
    // needed no merging. Copying the streams into the right one costs a read and a write.
    if (path.extname(downloaded[0]).toLowerCase() === output_ext) {
        await fs.move(downloaded[0], job.part_path, {overwrite: true});
    } else {
        const remuxed = await transcoding.runFfmpeg([
            '-y', '-i', downloaded[0], '-map', '0', '-c', 'copy', '-map_metadata', '0',
            ...(['mp4', 'mov'].includes(codecs.getMuxer(output_ext)) ? ['-movflags', '+faststart+use_metadata_tags'] : []),
            '-f', codecs.getMuxer(output_ext), job.part_path
        ]);
        if (!remuxed.success) {
            await fs.remove(job.part_path);
            return `the download could not be moved into a ${output_ext} file (${remuxed.error})`;
        }
    }
    return null;
}

/*************************************************
 * ffmpeg arguments for converting a file to a
 * codec in place of the original.
 *
 * Everything else comes along untouched: every
 * audio track (re-encoded to AAC only when the
 * container cannot hold it), the container's tags
 * and chapters, and subtitles when the container
 * stays the same. Embedded cover art is dropped:
 * 0:V is the video without it.
 *
 * H.264 is forced to 8-bit, which is all most
 * H.264 decoders play. The other codecs keep the
 * source's bit depth.
 ************************************************/
exports.buildConversionArgs = (source_path, output_path, {codec, output_ext, same_container, audio_codecs = [], hardware_settings = null}) => {
    const muxer = codecs.getMuxer(output_ext);
    const args = ['-y'];
    if (hardware_settings) args.push(...hardware_settings.input_options);
    args.push('-i', source_path, '-map', '0:V:0', '-map', '0:a?');
    if (same_container) args.push('-map', '0:s?');
    args.push('-map_metadata', '0', '-map_chapters', '0');

    const filters = hardware_settings ? [...hardware_settings.video_filters] : [];
    if (codec === 'h264' && !filters.includes('format=nv12')) filters.unshift('format=nv12');
    if (filters.length > 0) args.push('-vf', filters.join(','));

    if (hardware_settings) args.push('-c:v', hardware_settings.video_encoder, ...hardware_settings.quality_options);
    else args.push(...transcoding.SOFTWARE_ENCODERS[codec]);
    // Apple's players only take HEVC in MP4 under the hvc1 tag, and ffmpeg defaults to hev1.
    if (codec === 'hevc' && (muxer === 'mp4' || muxer === 'mov')) args.push('-tag:v', 'hvc1');

    if (audio_codecs.length > 0) {
        if (audio_codecs.every(audio_codec => codecs.containerAcceptsAudio(output_ext, audio_codec))) args.push('-c:a', 'copy');
        else args.push('-c:a', 'aac', '-b:a', '192k');
    }
    if (same_container) args.push('-c:s', 'copy');

    // use_metadata_tags keeps tags MP4 has no field for, such as the source URL.
    if (muxer === 'mp4' || muxer === 'mov') args.push('-movflags', '+faststart+use_metadata_tags');
    args.push('-f', muxer, output_path);
    return args;
}

function describeEncoder(codec, hardware_settings) {
    if (hardware_settings) return transcoding.describeFfmpegSettings(hardware_settings);
    const software_encoder = transcoding.SOFTWARE_ENCODERS[codec];
    return `software encoding (${software_encoder[software_encoder.indexOf('-c:v') + 1]})`;
}

async function transcode(job, probed, output_ext) {
    const attempts = await transcoding.getCodecEncodeAttempts(job.codec);
    const audio_codecs = codecs.findAudioStreams(probed.streams).map(stream => codecs.normalizeAudioCodec(stream.codec_name));
    const same_container = path.extname(job.source_path).toLowerCase() === output_ext;
    const duration = Number(probed.format && probed.format.duration) || 0;

    let error = null;
    for (let i = 0; i < attempts.length; i++) {
        const args = exports.buildConversionArgs(job.source_path, job.part_path, {
            codec: job.codec, output_ext, same_container, audio_codecs, hardware_settings: attempts[i]
        });
        logger.info(`Transcoding '${job.source_path}' to ${codecs.describeCodec(job.codec)} using ${describeEncoder(job.codec, attempts[i])}. This can take a while.`);
        logger.debug(`ffmpeg codec conversion command: ffmpeg ${args.join(' ')}`);

        let last_progress_log = Date.now();
        const on_progress_seconds = duration > 0 ? seconds => {
            if (Date.now() - last_progress_log < PROGRESS_LOG_INTERVAL_MS) return;
            last_progress_log = Date.now();
            logger.info(`Transcoding '${path.basename(job.source_path)}' to ${codecs.describeCodec(job.codec)}: ${Math.min(99, Math.floor(seconds / duration * 100))}%`);
        } : null;

        const result = await transcoding.runFfmpeg(args, {on_progress_seconds});
        if (result.success) return;

        error = result.error;
        await fs.remove(job.part_path);
        if (i + 1 < attempts.length) {
            logger.warn(`Transcoding '${job.source_path}' using ${describeEncoder(job.codec, attempts[i])} failed: ${error}. Retrying with ${describeEncoder(job.codec, attempts[i + 1])}.`);
        }
    }
    throw new Error(`ffmpeg failed: ${error || 'no error given'}`);
}

/*************************************************
 * Swap the checked copy in for the original.
 *
 * Keeping the container, one rename replaces the
 * original, and the record is updated after. With
 * a new container, the copy is renamed into place,
 * the record is repointed -- the commit, as far as
 * recovery is concerned -- and only then is the
 * original deleted.
 ************************************************/
async function commit(file, job) {
    await fs.rename(job.part_path, job.final_path);

    const probed = await transcoding.probeMedia(job.final_path);
    const video_stream = probed && codecs.findVideoStream(probed.streams);
    const update = {
        // Checked moments ago, so a failed probe here is ffprobe's problem, not the file's.
        ...(probed ? codecs.readCodecsFromProbe(probed) : {}),
        size: (await fs.stat(job.final_path)).size,
        codec_conversion_error: null
    };
    if (video_stream && Number(video_stream.height) > 0) update.height = Number(video_stream.height);

    const moves_file = job.final_path !== job.source_path;
    if (moves_file) update.path = job.final_path;

    const updated = await db_api.updateRecord('files', {uid: file.uid}, update);
    if (!updated) {
        if (!moves_file) {
            // The original is already gone, so the record is what is stale. The next run
            // finds the codec wrong, probes the file, and corrects it.
            logger.warn(`Converted '${job.final_path}', but its record could not be updated.`);
            return;
        }
        await fs.remove(job.final_path);
        throw new Error('its record could not be updated, so the original was kept');
    }

    if (moves_file) await fs.remove(job.source_path);
}

function logSummary(summary, preferred_codec) {
    const lines = [`recorded the codecs of ${summary.discovered} file${summary.discovered === 1 ? '' : 's'}`];
    if (summary.unreadable > 0) lines.push(`${summary.unreadable} could not be read`);
    if (preferred_codec) {
        const label = codecs.describeCodec(preferred_codec);
        lines.push(`converted ${summary.converted} to ${label} (${summary.reacquired} downloaded again, ${summary.transcoded} transcoded)`);
        if (summary.already > 0) lines.push(`${summary.already} already were ${label}`);
        if (summary.failed > 0) lines.push(`${summary.failed} failed`);
        if (summary.skipped > 0) lines.push(`${summary.skipped} skipped`);
        if (summary.remaining > 0) lines.push(`${summary.remaining} left for the next run`);
    }
    logger.info(`Codec discovery ${lines.join(', ')}.`);
    if (summary.stopped) logger.error(summary.stopped);
}
