// yt-dlp removes SponsorBlock segments (and --remove-chapters ranges) without re-encoding: it
// runs the file through ffmpeg's concat demuxer with -c copy. The part after a cut can then
// only start on a video keyframe, so ffmpeg starts it at the keyframe before the end of the
// cut, and the audio from that keyframe on comes with it. That audio overlaps what is already
// written, so ffmpeg squeezes it into an instant, each packet a tick after the last, but the
// sound is all still there. Players play audio back to back, so everything after the cut is
// late by the gap between that keyframe and the end of the cut: up to one keyframe interval,
// a second or two.
//
// Dropping the squeezed packets, again without re-encoding, puts the audio back in sync and
// takes the rest of the cut-out sound with it. The squeezed video frames stay: the frames
// after the cut are decoded from them.
//
// Downloads are fixed as they finish. The task fixes the ones from before that.
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');

const codecs = require('./codecs');
const transcoding = require('./transcoding');
const db_api = require('./db');
const utils = require('./utils');
const logger = require('./logger');

const TASK_KEY = 'resync_cut_audio';

// The copy is written beside the file and renamed over it once checked. No media extension,
// so a library scan never imports one.
const PART_SUFFIX = '.audio-sync-part';

// The yt-dlp options that cut ranges out of a download.
const CUTTING_ARGS = ['--sponsorblock-remove', '--remove-chapters'];

// The containers a copy comes out of with everything else as it was. Not Matroska: ffmpeg
// writes its cover art back as an ordinary video track.
const REWRITABLE_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm'];

exports.TASK_KEY = TASK_KEY;
exports.PART_SUFFIX = PART_SUFFIX;

exports.canRewrite = (file_path) => REWRITABLE_EXTENSIONS.includes(path.extname(file_path).toLowerCase());

exports.cutsRanges = (args = []) => Array.isArray(args) && args.some(arg => typeof arg === 'string'
    && CUTTING_ARGS.some(cutting_arg => arg === cutting_arg || arg.startsWith(`${cutting_arg}=`)));

/**
 * The runs of packets in one stream that a cut squeezed together. A squeezed packet lands at
 * most one tick after the one before it: ffmpeg moves it one tick on in MP4 and leaves it on
 * the same tick in Matroska and WebM. A real audio packet lasts 20 ticks or more, even at
 * Matroska's milliseconds.
 * @param {(number|null)[]} dts_values decoding timestamps in stream order, null where unknown
 * @returns {number[][]} [first, last] packet indices of each run, inclusive
 */
function findSqueezedRuns(dts_values) {
    const runs = [];
    let run_start = null;
    for (let i = 0; i < dts_values.length; i++) {
        const known = i > 0 && dts_values[i] !== null && dts_values[i - 1] !== null;
        const step = known ? dts_values[i] - dts_values[i - 1] : null;
        const squeezed = step !== null && step >= 0 && step <= 1;
        if (squeezed && run_start === null) run_start = i;
        if (!squeezed && run_start !== null) {
            runs.push([run_start, i - 1]);
            run_start = null;
        }
    }
    if (run_start !== null) runs.push([run_start, dts_values.length - 1]);
    return runs;
}
exports.findSqueezedRuns = findSqueezedRuns;

function countPackets(runs) {
    return runs.reduce((total, [first, last]) => total + last - first + 1, 0);
}

/**
 * Every audio stream of a file, in order, with how many packets it has and which of them a
 * cut squeezed. Resolves null when ffprobe cannot read the file.
 * @returns {Promise<{index: number, packets: number, runs: number[][]}[]|null>}
 */
function probeAudio(file_path) {
    return new Promise(resolve => {
        const ffprobe_binary = process.env.FFPROBE_PATH || 'ffprobe';
        // Only the audio is read, so this takes a fraction of a second on a long video. Stream
        // and packet lines share the output, so each one starts with its section's name.
        const args = ['-v', 'error', '-select_streams', 'a',
            '-show_entries', 'stream=index:packet=stream_index,dts', '-of', 'csv=p=1', file_path];
        const dts_by_stream = new Map();
        const stream_indices = [];
        let remainder = '';
        let finished = false;

        const finish = (result) => {
            if (finished) return;
            finished = true;
            resolve(result);
        };

        const readLine = (line) => {
            const fields = line.trim().split(',');
            const index = Number(fields[1]);
            if (!Number.isInteger(index)) return;
            if (fields[0] === 'stream') {
                stream_indices.push(index);
            } else if (fields[0] === 'packet') {
                const dts = Number(fields[2]);
                if (!dts_by_stream.has(index)) dts_by_stream.set(index, []);
                dts_by_stream.get(index).push(fields[2] !== '' && Number.isFinite(dts) ? dts : null);
            }
        };

        let ffprobe_process;
        try {
            ffprobe_process = spawn(ffprobe_binary, args);
        } catch {
            finish(null);
            return;
        }

        ffprobe_process.stdout.on('data', data => {
            // A chunk can end mid-line, so carry the tail over to the next one.
            const lines = (remainder + data.toString()).split('\n');
            remainder = lines.pop();
            lines.forEach(readLine);
        });
        ffprobe_process.on('error', () => finish(null));
        ffprobe_process.on('close', code => {
            if (code !== 0) return finish(null);
            readLine(remainder);
            finish(stream_indices.map(index => {
                const dts_values = dts_by_stream.get(index) || [];
                return {index, packets: dts_values.length, runs: findSqueezedRuns(dts_values)};
            }));
        });
    });
}
exports.probeAudio = probeAudio;

/**
 * ffmpeg arguments for a copy of the file without the squeezed packets. Everything else is
 * copied as it is, the way yt-dlp copies it: every stream but data streams, such as the
 * chapter track ffmpeg writes again from the chapters themselves.
 */
function buildResyncArgs(source_path, output_path, audio_streams) {
    const muxer = codecs.getMuxer(path.extname(source_path));
    const args = ['-y', '-i', source_path, '-map', '0', '-dn', '-ignore_unknown', '-c', 'copy', '-map_metadata', '0'];
    audio_streams.forEach((stream, audio_index) => {
        if (stream.runs.length === 0) return;
        // n counts the stream's packets from 0, in the order ffprobe listed them.
        const drop = stream.runs.map(([first, last]) => `between(n\\,${first}\\,${last})`).join('+');
        args.push(`-bsf:a:${audio_index}`, `noise=drop=${drop}`);
    });
    // faststart as yt-dlp writes MP4. Not use_metadata_tags, as codec discovery writes it: that
    // stores every tag another way, which some players do not read, and yt-dlp's MP4 tags all
    // fit the usual way already.
    if (muxer === 'mp4' || muxer === 'mov') args.push('-movflags', '+faststart');
    args.push('-f', muxer, output_path);
    return args;
}
exports.buildResyncArgs = buildResyncArgs;

/**
 * Drop the audio that cuts left squeezed into a file, and swap the copy in for it. The copy
 * keeps the file's permissions and modification time, and is only swapped in once it has
 * every packet but the dropped ones.
 * @returns {Promise<number>} how many packets were dropped; with none, the file is untouched
 */
exports.resync = async (file_path) => {
    if (!exports.canRewrite(file_path)) {
        throw new Error(`${path.extname(file_path) || 'a file with no extension'} is not a container it rewrites`);
    }
    const before = await probeAudio(file_path);
    if (!before) throw new Error('ffprobe could not read its audio');
    const dropped = before.reduce((total, stream) => total + countPackets(stream.runs), 0);
    if (dropped === 0) return 0;

    const part_path = `${file_path}${PART_SUFFIX}`;
    try {
        const args = buildResyncArgs(file_path, part_path, before);
        logger.debug(`ffmpeg audio resync command: ffmpeg ${args.join(' ')}`);
        const result = await transcoding.runFfmpeg(args);
        if (!result.success) throw new Error(`ffmpeg failed: ${result.error || 'no error given'}`);

        const after = await probeAudio(part_path);
        const as_expected = after && after.length === before.length && after.every((stream, i) =>
            stream.runs.length === 0 && stream.packets === before[i].packets - countPackets(before[i].runs));
        if (!as_expected) throw new Error('the copy did not come out with the packets it should have');

        const stats = await fs.stat(file_path);
        await fs.chmod(part_path, stats.mode);
        await fs.utimes(part_path, stats.atime, stats.mtime);
        await fs.rename(part_path, file_path);
    } finally {
        // Gone already once the copy is swapped in.
        await fs.remove(part_path);
    }
    return dropped;
};

// Whether SponsorBlock segments were looked up for a file, as its info.json records. A cut
// can only have left the audio late in those, so the rest are not worth reading.
function hasSponsorBlockSegments(file_path) {
    try {
        const info = utils.getJSON(file_path, 'video');
        return !!info && Array.isArray(info.sponsorblock_chapters) && info.sponsorblock_chapters.length > 0;
    } catch {
        return false;
    }
}

async function resyncLibrary() {
    let checked = 0;
    let fixed = 0;
    let failed = 0;
    for (const file of await db_api.getRecords('files')) {
        if (file.isAudio || typeof file.path !== 'string' || !exports.canRewrite(file.path)) continue;
        if (!await fs.pathExists(file.path) || !hasSponsorBlockSegments(file.path)) continue;
        checked++;
        try {
            if (await exports.resync(file.path) === 0) continue;
            fixed++;
            await db_api.updateRecord('files', {uid: file.uid}, {size: (await fs.stat(file.path)).size});
        } catch (err) {
            failed++;
            logger.warn(`Could not put the audio of '${file.path}' back in sync: ${err.message}`);
        }
    }
    logger.info(`Put the audio back in sync in ${fixed} of the ${checked} videos with SponsorBlock segments.`);
    if (failed > 0) throw new Error(`${failed} file(s) could not be fixed. See the server log for details.`);
}

// A task can be started by HTTP and cron at the same moment. Claim the run before awaiting
// anything, so no file is rewritten twice at once.
let active_run = null;
exports.run = () => {
    if (!active_run) active_run = resyncLibrary().finally(() => { active_run = null; });
    return active_run;
};
