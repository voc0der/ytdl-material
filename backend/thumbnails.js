const fs = require('fs-extra');
const axios = require('axios');

const db_api = require('./db');
const utils = require('./utils');
const transcoding_api = require('./transcoding');
const downloader_api = require('./downloader');
const logger = require('./logger');

/*************************************************
 * Cover art for a file that has none, or whose
 * own is unusable.
 *
 * This lives outside files.js on purpose: the
 * good answer is the real thumbnail fetched from
 * the source, which needs downloader.js, and
 * downloader.js already requires files.js. A
 * module of its own keeps that from becoming a
 * cycle.
 ************************************************/

// Where the reporter's scripts seeked to, and a reasonable default: far enough in to be past
// a title card, close enough to the start to exist in a short video.
const DEFAULT_TIMESTAMP_SECONDS = 30;

// A frame grab is local and quick; a metadata fetch talks to the network and is the step that
// can hang. Both are capped so a bulk run cannot stall on one file.
const METADATA_FETCH_TIMEOUT_MS = 30000;
const THUMBNAIL_DOWNLOAD_TIMEOUT_MS = 20000;

function getGeneratedThumbnailPath(file_path = '') {
    if (!file_path) return null;
    return `${utils.removeFileExtension(file_path)}.webp`;
}
exports.getGeneratedThumbnailPath = getGeneratedThumbnailPath;

/**
 * Keep the seek inside the file. Asked for a timestamp past the end, ffmpeg exits non-zero
 * *and* leaves a truncated output file behind, so an unclamped seek both fails and litters
 * -- which is why the caller removes the output on failure rather than trusting the exit
 * code alone. The scripts in #497/#498 seeked to 30s unconditionally and counted every
 * video shorter than that as an error.
 */
function resolveSeekSeconds(requested_seconds, duration_seconds) {
    // Number(null) and Number('') are both 0, so "not provided" has to be ruled out before
    // the conversion or a blank timestamp seeks to the first frame, which is often black.
    const provided = requested_seconds !== null && requested_seconds !== undefined && requested_seconds !== '';
    const requested = provided ? Number(requested_seconds) : NaN;
    const wanted = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_TIMESTAMP_SECONDS;
    const duration = Number(duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0) return wanted;
    // Back off to the midpoint rather than to zero: the first frame of a video is often black.
    if (wanted >= duration) return Math.max(0, duration / 2);
    return wanted;
}
exports.resolveSeekSeconds = resolveSeekSeconds;

async function writeThumbnailFromFrame(file_path, output_path, timestamp_seconds) {
    const probed = await transcoding_api.probeMedia(file_path);
    const duration = probed && probed.format ? probed.format.duration : null;
    const seek_seconds = resolveSeekSeconds(timestamp_seconds, duration);

    const {success, error} = await transcoding_api.runFfmpeg([
        '-y',
        // Before -i so ffmpeg seeks rather than decoding everything up to the timestamp.
        '-ss', String(seek_seconds),
        '-i', file_path,
        '-frames:v', '1',
        // -2 keeps the height even. libwebp accepts an odd one, so this is not load-bearing
        // today, but it is what every encoder accepts and costs nothing to keep.
        '-vf', 'scale=1280:-2',
        output_path
    ]);

    if (!success) {
        logger.warn(`Could not generate a thumbnail frame for '${file_path}': ${error}`);
        return false;
    }
    return true;
}

async function writeThumbnailFromUrl(thumbnail_url, output_path) {
    try {
        const response = await axios.get(thumbnail_url, {
            responseType: 'arraybuffer',
            timeout: THUMBNAIL_DOWNLOAD_TIMEOUT_MS,
            maxContentLength: 25 * 1024 * 1024
        });
        await fs.writeFile(output_path, Buffer.from(response.data));
        return true;
    } catch (err) {
        logger.warn(`Could not download the source thumbnail from '${thumbnail_url}': ${err.message}`);
        return false;
    }
}

/**
 * The source's own thumbnail URL, or '' when the record has no usable URL or the lookup
 * fails. Network failures are not errors here: the frame grab is the fallback.
 */
async function resolveSourceThumbnailUrl(file_obj) {
    const url = file_obj && typeof file_obj.url === 'string' ? file_obj.url.trim() : '';
    if (!url) return '';

    try {
        const info = await Promise.race([
            downloader_api.getVideoInfoByURL(url, ['--skip-download']),
            new Promise(resolve => setTimeout(() => resolve(null), METADATA_FETCH_TIMEOUT_MS))
        ]);
        const entry = Array.isArray(info) ? info[0] : info;
        const thumbnail = entry && typeof entry.thumbnail === 'string' ? entry.thumbnail.trim() : '';
        return /^https?:\/\//i.test(thumbnail) ? thumbnail : '';
    } catch (err) {
        logger.warn(`Could not read source metadata for '${url}': ${err.message}`);
        return '';
    }
}

/**
 * Give a file cover art, preferring the real thumbnail from its source and falling back to a
 * frame from the file itself. Returns the stored relative path, or null when nothing worked.
 *
 * @param {object} file_obj a files record
 * @param {{timestamp_seconds?: number, allow_source_fetch?: boolean}} options
 */
exports.generateThumbnailForFile = async (file_obj, {timestamp_seconds = DEFAULT_TIMESTAMP_SECONDS, allow_source_fetch = true} = {}) => {
    if (!file_obj || !file_obj.path) return null;

    const file_path = file_obj.path;
    // ffprobe and ffmpeg are handed this path, so it gets the same check as the endpoints
    // that read it directly -- a regular file inside its owner's media folders.
    if (!utils.isServableMediaFile(file_path, file_obj.user_uid)) {
        logger.error(`Refusing to generate a thumbnail for ${file_obj.uid}: its path is not a regular `
            + `file inside its owner's media folder.`);
        return null;
    }

    const output_path = getGeneratedThumbnailPath(file_path);
    // This hands ffmpeg somewhere to write, which deserves its own check rather than an
    // inherited assumption about where the media file was.
    if (!output_path || !utils.isPathInsideMediaRoots(output_path, file_obj.user_uid)) {
        logger.warn(`Refusing to write a thumbnail outside the media roots: ${output_path}`);
        return null;
    }

    let written = false;
    if (allow_source_fetch) {
        const source_thumbnail_url = await resolveSourceThumbnailUrl(file_obj);
        if (source_thumbnail_url) written = await writeThumbnailFromUrl(source_thumbnail_url, output_path);
    }
    if (!written) written = await writeThumbnailFromFrame(file_path, output_path, timestamp_seconds);

    if (!written) {
        try {
            await fs.remove(output_path);
        } catch {
            // Non-fatal.
        }
        return null;
    }

    try {
        await fs.chmod(output_path, 0o644);
    } catch {
        // Non-fatal.
    }

    const stored_thumbnail_path = utils.getDownloadedThumbnail(file_path);
    await db_api.updateRecord('files', {uid: file_obj.uid}, {
        thumbnailPath: stored_thumbnail_path,
        thumbnailURL: file_obj.thumbnailURL || 'local'
    });

    return stored_thumbnail_path;
};

/**
 * Every file the library holds that has no cover art at all. Files that already have one are
 * left alone -- replacing existing art is something only the per-file action does.
 */
exports.getFilesMissingThumbnails = async () => {
    const files = await db_api.getRecords('files');
    return (files || []).filter(file_obj => {
        if (!file_obj || !file_obj.path) return false;
        return !file_obj.thumbnailPath || !utils.getDownloadedThumbnail(file_obj.path);
    });
};

/**
 * Bulk repair. Runs a couple of files at a time: the source fetch is network-bound, and a
 * long run must not compete with downloads for bandwidth or yt-dlp's rate limits.
 */
exports.generateMissingThumbnails = async (concurrency = 2) => {
    const files = await exports.getFilesMissingThumbnails();
    const results = {generated: 0, failed: 0, total: files.length};
    let next_index = 0;

    const worker = async () => {
        while (next_index < files.length) {
            const file_obj = files[next_index++];
            try {
                const generated = await exports.generateThumbnailForFile(file_obj);
                if (generated) results.generated++;
                else results.failed++;
            } catch (err) {
                logger.error(`Failed to generate a thumbnail for ${file_obj && file_obj.uid}: ${err.message}`);
                results.failed++;
            }
        }
    };

    await Promise.all(Array.from({length: Math.max(1, Math.min(concurrency, files.length))}, worker));
    logger.info(`Generated cover art for ${results.generated} of ${results.total} files missing it.`);
    return results;
};
