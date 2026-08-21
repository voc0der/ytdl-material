const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { Readable, pipeline } = require('stream');
const { ZipArchive } = require('archiver');
const ProgressBar = require('progress');
const winston = require('winston');

const config_api = require('./config');
const logger = require('./logger');
const transcoding_api = require('./transcoding');
const CONSTS = require('./consts');

const is_windows = process.platform === 'win32';
const DEFAULT_INVALID_FILENAME_CHARS = '\\/:*?"<>|';

function getSafeFilenameReplacement() {
    const configured_replacement = config_api.getConfigItem('ytdl_invalid_filename_replacement');
    const replacement = configured_replacement === undefined || configured_replacement === null ? '_' : String(configured_replacement);
    return replacement.replace(/[\\/\0]/g, '');
}

function getUniqueChars(chars = '') {
    const unique_chars = [];
    for (const char of chars) {
        if (!unique_chars.includes(char)) unique_chars.push(char);
    }
    return unique_chars;
}

exports.sanitizePathSegment = (segment, fallback = 'file') => {
    const replacement = getSafeFilenameReplacement();
    const configured_invalid_chars = config_api.getConfigItem('ytdl_invalid_filename_chars');
    const invalid_chars = ['\\', '/', '\0'];

    if (config_api.getConfigItem('ytdl_replace_invalid_filename_chars')) {
        invalid_chars.push(...(typeof configured_invalid_chars === 'string' && configured_invalid_chars.length > 0 ? configured_invalid_chars : DEFAULT_INVALID_FILENAME_CHARS));
    }

    let sanitized_segment = segment === undefined || segment === null ? '' : String(segment);
    sanitized_segment = sanitized_segment.trim();

    for (const char of getUniqueChars(invalid_chars.join(''))) {
        sanitized_segment = sanitized_segment.split(char).join(replacement);
    }

    sanitized_segment = sanitized_segment.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!sanitized_segment || sanitized_segment === '.' || sanitized_segment === '..') {
        return fallback || 'file';
    }
    return sanitized_segment;
}

exports.getSubscriptionPathName = (sub = {}) => {
    const fallback = sub && sub.id ? String(sub.id) : 'subscription';
    return exports.sanitizePathSegment(sub && sub.name, fallback);
}

exports.usesSubscriptionSubfolder = (sub = {}) => {
    return !(sub && sub.use_subfolder === false);
}

exports.getSubscriptionTypeFolder = (sub = {}) => {
    return sub && sub.isPlaylist ? 'playlists' : 'channels';
}

exports.getSubscriptionTypePath = (sub = {}, base_path = '') => {
    return path.join(base_path, exports.getSubscriptionTypeFolder(sub));
}

exports.getSubscriptionDownloadPath = (sub = {}, base_path = '') => {
    const subscription_type_path = exports.getSubscriptionTypePath(sub, base_path);
    if (!exports.usesSubscriptionSubfolder(sub)) return subscription_type_path;
    return path.join(subscription_type_path, exports.getSubscriptionPathName(sub));
}

exports.getSubscriptionMetadataPath = (sub = {}, base_path = '') => {
    const subscription_type_path = exports.getSubscriptionTypePath(sub, base_path);
    const subscription_path_name = exports.getSubscriptionPathName(sub);
    if (exports.usesSubscriptionSubfolder(sub)) return path.join(subscription_type_path, subscription_path_name);
    return path.join(subscription_type_path, '.metadata', subscription_path_name);
}

// replaces .webm with appropriate extension
exports.getTrueFileName = (unfixed_path, type, force_ext = null) => {
    let fixed_path = unfixed_path;

    const new_ext = (type === 'audio' ? 'mp3' : 'mp4');
    let unfixed_parts = unfixed_path.split('.');
    const old_ext = unfixed_parts[unfixed_parts.length-1];


    if (old_ext !== new_ext) {
        unfixed_parts[unfixed_parts.length-1] = force_ext || new_ext;
        fixed_path = unfixed_parts.join('.');
    }
    return fixed_path;
}

exports.getDownloadedFilesByType = async (basePath, type, full_metadata = false) => {
    // return empty array if the path doesn't exist
    if (!(await fs.pathExists(basePath))) return [];

    let files = [];
    const ext = type === 'audio' ? 'mp3' : 'mp4';
    var located_files = await exports.recFindByExt(basePath, ext);
    for (let i = 0; i < located_files.length; i++) {
        let file = located_files[i];
        var file_path = file.substring(basePath.includes('\\') ? basePath.length+1 : basePath.length, file.length);

        var stats = await fs.stat(file);

        var id = file_path.substring(0, file_path.length-4);
        var jsonobj = await exports.getJSONByType(type, id, basePath);
        if (!jsonobj) continue;
        if (full_metadata) {
            jsonobj['id'] = id;
            files.push(jsonobj);
            continue;
        }
        var upload_date = exports.formatDateString(jsonobj.upload_date);

        var isaudio = type === 'audio';
        var file_obj = new exports.File(id, jsonobj.title, jsonobj.thumbnail, isaudio, jsonobj.duration, jsonobj.webpage_url, jsonobj.uploader,
                                stats.size, file, upload_date, jsonobj.description, jsonobj.view_count, jsonobj.height, jsonobj.abr);
        files.push(file_obj);
    }
    return files;
}

/*************************************************
 * The archive's name on disk used to be the
 * playlist or subscription name, which a user
 * chooses. That put a caller-controlled string into
 * a path -- so it could name another .zip, which
 * the download handler then deletes after sending
 * -- and made two people downloading containers of
 * the same name collide with each other.
 *
 * The name the user chose is still what they see:
 * it goes in the Content-Disposition header, which
 * is what a filename is actually for.
 ************************************************/
exports.createContainerZipFile = async (file_name, container_file_objs, user_uid = null) => {
    const container_files_to_download = [];
    for (const container_file_obj of container_file_objs) {
        // Every path here came out of a database record. Records written before the path
        // stopped being client-writable can still point anywhere.
        if (!exports.isServableMediaFile(container_file_obj.path, container_file_obj.user_uid || user_uid)) {
            logger.error(`Leaving ${container_file_obj.path} out of the archive: it is not a regular file `
                + `inside its owner's media folder.`);
            continue;
        }
        container_files_to_download.push(container_file_obj.path);
    }

    const zip_file_path = path.join('appdata', `container-${uuid()}.zip`);
    return await exports.createZipFile(zip_file_path, container_files_to_download);
}

exports.createZipFile = async (zip_file_path, file_paths) => {
    const output = fs.createWriteStream(zip_file_path);

    // archiver 8 replaced the callable factory with exported classes, so archiver('zip')
    // has been throwing TypeError since the dependency was bumped -- which is to say
    // container downloads have simply been failing.
    const archive = new ZipArchive({
        zlib: { level: 9 } // Sets the compression level.
    });

    // Both ends need a handler. An unhandled 'error' on either stream is an uncaught
    // exception, which takes the process down rather than failing the one request --
    // a missing file is enough to cause it.
    const archive_finished = new Promise((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.on('warning', (err) => logger.warn(`Archiver warning: ${err.message}`));
    });

    // pipe archive data to the output file
    archive.pipe(output);

    for (const file_path of file_paths) {
        const file_name = path.parse(file_path).base;
        archive.file(file_path, {name: file_name})
    }

    try {
        archive.finalize();
        await archive_finished;
    } catch (err) {
        logger.error(`Failed to build ${zip_file_path}: ${err.message}`);
        await fs.remove(zip_file_path).catch(() => null);
        return null;
    }

    return zip_file_path;
}

exports.getJSONMp4 = (name, customPath, openReadPerms = false) => {
    var obj = null; // output
    if (!customPath) customPath = config_api.getConfigItem('ytdl_video_folder_path');
    var jsonPath = path.join(customPath, name + ".info.json");
    var alternateJsonPath = path.join(customPath, name + ".mp4.info.json");
    if (fs.existsSync(jsonPath))
    {
        obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } else if (fs.existsSync(alternateJsonPath)) {
        obj = JSON.parse(fs.readFileSync(alternateJsonPath, 'utf8'));
    }
    else obj = 0;
    return obj;
}

exports.getJSONMp3 = (name, customPath, openReadPerms = false) => {
    var obj = null;
    if (!customPath) customPath = config_api.getConfigItem('ytdl_audio_folder_path');
    var jsonPath = path.join(customPath, name + ".info.json");
    var alternateJsonPath = path.join(customPath, name + ".mp3.info.json");
    if (fs.existsSync(jsonPath)) {
        obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
    else if (fs.existsSync(alternateJsonPath)) {
        obj = JSON.parse(fs.readFileSync(alternateJsonPath, 'utf8'));
    }
    else
        obj = 0;

    return obj;
}

exports.getJSON = (file_path, type) => {
    const ext = type === 'audio' ? '.mp3' : '.mp4';
    let obj = null;
    const file_path_no_extension = exports.removeFileExtension(file_path);
    const actual_ext = path.extname(file_path);
    const json_paths = [
        file_path_no_extension + '.info.json',
        file_path_no_extension + `${ext}.info.json`
    ];

    if (actual_ext && actual_ext !== ext) {
        json_paths.push(file_path_no_extension + `${actual_ext}.info.json`);
    }

    // readFileSync follows a symlink, so the candidates are filtered before one is read.
    const json_path = exports.keepSiblingSidecarPaths(file_path, json_paths).find(candidate_path => fs.existsSync(candidate_path));
    if (json_path) {
        obj = JSON.parse(fs.readFileSync(json_path, 'utf8'));
    } else obj = 0;
    return obj;
}

exports.getJSONByType = (type, name, customPath, openReadPerms = false) => {
    return type === 'audio' ? exports.getJSONMp3(name, customPath, openReadPerms) : exports.getJSONMp4(name, customPath, openReadPerms)
}

exports.getDownloadedThumbnail = (file_path) => {
    const file_path_no_extension = exports.removeFileExtension(file_path);

    // What this returns is recorded as thumbnailPath and later served, so a sibling symlink
    // pointing out of the media roots must not be recorded in the first place.
    const candidate_paths = exports.keepSiblingSidecarPaths(file_path, [
        file_path_no_extension + '.jpg',
        file_path_no_extension + '.webp',
        file_path_no_extension + '.png'
    ]);

    return candidate_paths.find(candidate_path => fs.existsSync(candidate_path)) || null;
}

exports.getExpectedFileSize = (input_info_jsons) => {
    // treat single videos as arrays to have the file sizes checked/added to. makes the code cleaner
    const info_jsons = Array.isArray(input_info_jsons) ? input_info_jsons : [input_info_jsons];

    const getNumericSize = (value) => {
        const numeric_value = Number(value);
        return Number.isFinite(numeric_value) && numeric_value > 0 ? numeric_value : 0;
    };

    const estimateSizeFromBitrate = (bitrate_kbps, duration_seconds) => {
        const normalized_bitrate_kbps = getNumericSize(bitrate_kbps);
        const normalized_duration_seconds = getNumericSize(duration_seconds);
        if (normalized_bitrate_kbps === 0 || normalized_duration_seconds === 0) return 0;

        // yt-dlp reports tbr/abr/vbr in KBit/s.
        return (normalized_bitrate_kbps * 1000 / 8) * normalized_duration_seconds;
    };

    const getDurationSeconds = (info_json = {}) => {
        return getNumericSize(info_json.duration);
    };

    const getFormatBitrateKbps = (format_obj = {}) => {
        return getNumericSize(format_obj.tbr) || getNumericSize(format_obj.vbr) || getNumericSize(format_obj.abr);
    };

    const getSizeFromFormatObj = (format_obj = null, duration_fallback_seconds = 0) => {
        if (!format_obj || typeof format_obj !== 'object') return 0;
        const exact_or_approx_size = getNumericSize(format_obj.filesize) || getNumericSize(format_obj.filesize_approx);
        if (exact_or_approx_size > 0) return exact_or_approx_size;

        const format_duration_seconds = getNumericSize(format_obj.duration) || duration_fallback_seconds;
        const format_bitrate_kbps = getFormatBitrateKbps(format_obj);
        return estimateSizeFromBitrate(format_bitrate_kbps, format_duration_seconds);
    };

    const getSizeFromRequestedFormats = (info_json = {}) => {
        if (!Array.isArray(info_json.requested_formats)) return 0;
        const duration_fallback_seconds = getDurationSeconds(info_json);
        return info_json.requested_formats.reduce((sum, requested_format) => {
            return sum + getSizeFromFormatObj(requested_format, duration_fallback_seconds);
        }, 0);
    };

    const getSizeFromRequestedDownloads = (info_json = {}) => {
        if (!Array.isArray(info_json.requested_downloads)) return 0;
        const duration_fallback_seconds = getDurationSeconds(info_json);
        return info_json.requested_downloads.reduce((sum, requested_download) => {
            return sum + getSizeFromFormatObj(requested_download, duration_fallback_seconds);
        }, 0);
    };

    let expected_filesize = 0;
    info_jsons.forEach(info_json => {
        if (!info_json || typeof info_json !== 'object') return;

        const duration_fallback_seconds = getDurationSeconds(info_json);
        const format_id = typeof info_json['format_id'] === 'string' ? info_json['format_id'] : '';
        const selected_format = format_id.split('/')[0];
        const formats = selected_format.split('+').map(part => part.trim()).filter(part => part !== '');
        let individual_expected_filesize = 0;
        formats.forEach(format_id => {
            if (info_json.formats !== undefined) {
                info_json.formats.forEach(available_format => {
                  if (available_format.format_id === format_id) {
                    individual_expected_filesize += getSizeFromFormatObj(available_format, duration_fallback_seconds);
                  }
                });
            }
        });

        // yt-dlp often provides sizes for selected streams in requested_formats / requested_downloads
        // while omitting filesize metadata in the full formats list.
        if (individual_expected_filesize === 0) {
            individual_expected_filesize = getSizeFromRequestedFormats(info_json);
        }
        if (individual_expected_filesize === 0) {
            individual_expected_filesize = getSizeFromRequestedDownloads(info_json);
        }
        if (individual_expected_filesize === 0) {
            individual_expected_filesize = getNumericSize(info_json.filesize) || getNumericSize(info_json.filesize_approx);
        }
        if (individual_expected_filesize === 0) {
            const top_level_bitrate_kbps = getFormatBitrateKbps(info_json);
            individual_expected_filesize = estimateSizeFromBitrate(top_level_bitrate_kbps, duration_fallback_seconds);
        }

        expected_filesize += individual_expected_filesize;
    });

    return expected_filesize;
}

exports.fixVideoMetadataPerms = (file_path, type) => {
    if (is_windows) return;

    // chmod is a write. Derived sidecar paths are siblings of the media file now, so a
    // contained media file means contained sidecars -- but the media path itself arrives
    // from a database record here, and a record is not a guarantee.
    if (!exports.isPathInsideMediaRoots(file_path)) {
        logger.warn(`Refusing to change permissions on metadata outside the media roots: ${file_path}`);
        return;
    }

    const ext = type === 'audio' ? '.mp3' : '.mp4';

    const file_path_no_extension = exports.removeFileExtension(file_path);

    const files_to_fix = [
        // JSONs
        file_path_no_extension + '.info.json',
        file_path_no_extension + ext + '.info.json',
        // Thumbnails
        file_path_no_extension + '.webp',
        file_path_no_extension + '.jpg'
    ];

    // chmod follows a symlink to its target, so each derived path is checked, not just the
    // media file they were derived from.
    for (const file of exports.keepSiblingSidecarPaths(file_path, files_to_fix)) {
        if (!fs.existsSync(file)) continue;
        fs.chmodSync(file, 0o644);
    }
}

exports.deleteJSONFile = (file_path, type) => {
    // Same reasoning as fixVideoMetadataPerms, and unlink is the less forgiving of the two.
    if (!exports.isPathInsideMediaRoots(file_path)) {
        logger.warn(`Refusing to delete metadata outside the media roots: ${file_path}`);
        return;
    }

    const ext = type === 'audio' ? '.mp3' : '.mp4';

    const file_path_no_extension = exports.removeFileExtension(file_path);

    const json_paths = exports.keepSiblingSidecarPaths(file_path, [
        file_path_no_extension + '.info.json',
        file_path_no_extension + ext + '.info.json'
    ]);

    for (const json_path of json_paths) {
        if (fs.existsSync(json_path)) fs.unlinkSync(json_path);
    }
}

exports.durationStringToNumber = (dur_str) => {
    if (typeof dur_str === 'number') return dur_str;
    let num_sum = 0;
    const dur_str_parts = dur_str.split(':');
    for (let i = dur_str_parts.length-1; i >= 0; i--) {
      num_sum += parseInt(dur_str_parts[i])*(60**(dur_str_parts.length-1-i));
    }
    return num_sum;
}

exports.getMatchingCategoryFiles = (category, files) => {
    return files && files.filter(file => file.category && file.category.uid === category.uid);
}

exports.addUIDsToCategory = (category, files) => {
    const files_that_match = exports.getMatchingCategoryFiles(category, files);
    category['uids'] = files_that_match.map(file => file.uid);
    return files_that_match;
}

exports.recFindByExt = async (base, ext, files, result, recursive = true) => {
    const extension = `.${ext}`.toLowerCase();
    const matching_files = result || [];
    const directories_to_scan = [{dir: base, provided_files: Array.isArray(files) ? files : null}];

    while (directories_to_scan.length > 0) {
        const current_scan = directories_to_scan.pop();
        const current_dir = current_scan.dir;

        let entries;
        try {
            if (current_scan.provided_files) {
                entries = await Promise.all(current_scan.provided_files.map(async file_name => {
                    const full_path = path.join(current_dir, file_name);
                    const file_stats = await fs.stat(full_path);
                    return {
                        name: file_name,
                        isDirectory: () => file_stats.isDirectory()
                    };
                }));
            } else {
                entries = await fs.readdir(current_dir, {withFileTypes: true});
            }
        } catch (err) {
            continue;
        }

        for (const entry of entries) {
            const entry_path = path.join(current_dir, entry.name);
            if (entry.isDirectory()) {
                if (recursive) directories_to_scan.push({dir: entry_path, provided_files: null});
                continue;
            }

            if (entry.name.toLowerCase().endsWith(extension)) {
                matching_files.push(entry_path);
            }
        }
    }

    return matching_files;
}

/*************************************************
 * Strips the extension and nothing else.
 *
 * It used to split the whole path on '.' and drop
 * the last piece, which is only the extension when
 * no directory above the file contains a dot. Give
 * it '/media.v2/video/clip' -- a media root with a
 * dot in its name and a file with no extension --
 * and it returned '/media', so every sidecar path
 * derived from it ('.info.json', '.jpg', the
 * subtitle sidecars) pointed outside the media root
 * entirely: read, chmod, unlink and ffmpeg output
 * all followed it there.
 *
 * path.extname only ever looks at the basename, so
 * the result now always stays in the file's own
 * directory, which is what every caller assumes.
 ************************************************/
exports.removeFileExtension = (filename) => {
    if (typeof filename !== 'string' || !filename) return filename;
    const extension = path.extname(filename);
    if (!extension) return filename;
    return filename.slice(0, filename.length - extension.length);
}

exports.formatDateString = (date_string) => {
    return date_string ? `${date_string.substring(0, 4)}-${date_string.substring(4, 6)}-${date_string.substring(6, 8)}` : 'N/A';
}

exports.createEdgeNGrams = (str) => {
    if (str && str.length > 3) {
        const minGram = 3
        const maxGram = str.length

        return str.split(" ").reduce((ngrams, token) => {
            if (token.length > minGram) {
                for (let i = minGram; i <= maxGram && i <= token.length; ++i) {
                    ngrams = [...ngrams, token.substr(0, i)]
                }
            } else {
                ngrams = [...ngrams, token]
            }
            return ngrams
        }, []).join(" ")
    }

    return str
}

// ffmpeg helper functions

function describeCropProcessing(hardware_settings) {
    if (!hardware_settings) return 'software encoding';
    const decode_label = hardware_settings.hardware_decode ? 'hardware decoding' : 'software decoding';
    return `${hardware_settings.label} (${hardware_settings.video_encoder}) with ${decode_label}`;
}

// Degrade one step at a time rather than straight to software. A GPU that cannot decode
// a particular source can usually still encode it, so a failed hardware decode should
// cost the hardware encode too only if that fails as well.
function buildCropAttempts(ext) {
    const attempts = [];
    const full_settings = transcoding_api.getHardwareFfmpegSettings(ext);
    if (full_settings) {
        attempts.push(full_settings);
        if (full_settings.hardware_decode) {
            attempts.push(transcoding_api.getHardwareFfmpegSettings(ext, {allow_hardware_decode: false}));
        }
    }
    attempts.push(null);
    return attempts;
}

/**
 * Trim source_path down to [start, end) and write the result to output_path, walking the
 * hardware->software ladder. The source is never modified; callers that want an in-place
 * crop are responsible for swapping the files themselves.
 */
async function runCropLadder(source_path, output_path, start, end, ext, verb, on_progress = null) {
    const start_time = Date.now();
    const attempts = buildCropAttempts(ext);

    // Cropping re-encodes and can run for minutes with no other output, so announce it up
    // front. Without this a long crop is indistinguishable from a hung download.
    logger.info(`${verb} '${source_path}' using ${describeCropProcessing(attempts[0])}. This can take a while for large files.`);

    let crop_success = false;
    for (let i = 0; i < attempts.length; i++) {
        crop_success = await cropFileAttempt(source_path, output_path, start, end, attempts[i], on_progress);
        if (crop_success) {
            if (i > 0) logger.info(`${verb} for '${source_path}' succeeded using ${describeCropProcessing(attempts[i])}.`);
            break;
        }
        if (i + 1 < attempts.length) {
            logger.warn(`${verb} using ${describeCropProcessing(attempts[i])} failed for '${source_path}'. Retrying with ${describeCropProcessing(attempts[i + 1])}.`);
        }
    }

    const elapsed_seconds = ((Date.now() - start_time) / 1000).toFixed(1);
    if (crop_success) logger.info(`${verb} for '${source_path}' complete in ${elapsed_seconds}s.`);
    else logger.error(`${verb} for '${source_path}' failed after ${elapsed_seconds}s.`);

    return crop_success;
}

exports.cropFile = async (file_path, start, end, ext) => {
    const temp_file_path = `${file_path}.cropped${ext}`;
    const crop_success = await runCropLadder(file_path, temp_file_path, start, end, ext, 'Cropping');
    if (!crop_success) return false;

    // Only swap once ffmpeg has produced a complete file, so a failure leaves the original intact.
    fs.unlinkSync(file_path);
    fs.moveSync(temp_file_path, file_path);
    return true;
}

/**
 * Non-destructive counterpart to cropFile: writes the trimmed range to its own file and
 * leaves the source untouched, so an already-downloaded file can be snipped without
 * losing the original.
 * @param {string} source_path file to snip
 * @param {string} output_path where the snipped file should be written
 * @param {number} start seconds
 * @param {number} end seconds
 * @param {string} ext container extension, used to pick hardware settings
 * @param {function} [on_progress] called with a 0-100 percentage as ffmpeg reports it
 */
exports.snipFile = async (source_path, output_path, start, end, ext, on_progress = null) => {
    const snip_success = await runCropLadder(source_path, output_path, start, end, ext, 'Snipping', on_progress);
    if (!snip_success) {
        try {
            fs.removeSync(output_path);
        } catch (e) {
            // Non-fatal, the ladder already removes its own partial output.
        }
    }
    return snip_success;
}

/**
 * Assemble the ffmpeg arguments for one crop attempt.
 *
 * Argument order is load-bearing: input options have to precede -i to apply to the input,
 * and -ss has to follow it so the seek is applied output-side. Output-side seeking is what
 * restarts the output timestamps at zero, which the progress maths below depends on.
 */
function buildCropArgs(source_path, output_path, start, end, hardware_settings) {
    const args = ['-y'];
    if (hardware_settings && hardware_settings.input_options.length > 0) {
        args.push(...hardware_settings.input_options);
    }
    args.push('-i', source_path);
    if (start) {
        args.push('-ss', String(start));
    }
    if (end) {
        args.push('-t', String(end - start));
    }
    if (hardware_settings) {
        if (hardware_settings.video_filters.length > 0) {
            args.push('-vf', hardware_settings.video_filters.join(','));
        }
        args.push('-c:v', hardware_settings.video_encoder);
    }
    args.push(output_path);
    return args;
}

async function cropFileAttempt(source_path, output_path, start, end, hardware_settings, on_progress = null) {
    const args = buildCropArgs(source_path, output_path, start, end, hardware_settings);

    // ffmpeg measures progress against the *input* position, which for a short snip of a
    // long file would never climb past a few percent. We know the length of the range we
    // asked for, so derive the percentage from that instead.
    const target_duration = Number(end) - Number(start);
    const report_progress = on_progress && Number.isFinite(target_duration) && target_duration > 0;

    // the resolved command line is the only definitive record of which encoder ran
    logger.debug(`ffmpeg crop command: ffmpeg ${args.join(' ')}`);

    const {success, error} = await transcoding_api.runFfmpeg(args, {
        on_progress_seconds: report_progress ? (elapsed_seconds) => {
            const percent = (elapsed_seconds / target_duration) * 100;
            on_progress(Math.min(100, Math.max(0, percent)));
        } : null
    });

    if (success) {
        logger.verbose(`Cropping attempt for '${source_path}' finished.`);
        return true;
    }

    logger.error(`Failed to crop ${source_path}.`);
    logger.error(error);
    try {
        fs.removeSync(output_path);
    } catch (e) {
        // Non-fatal.
    }
    return false;
}

/**
 * setTimeout, but its a promise.
 * @param {number} ms
 */
exports.wait = async (ms) => {
    await new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

exports.checkExistsWithTimeout = async (filePath, timeout) => {
    return new Promise(function (resolve, reject) {

        var timer = setTimeout(function () {
            if (watcher) watcher.close();
            reject(new Error('File did not exists and was not created during the timeout.'));
        }, timeout);

        fs.access(filePath, fs.constants.R_OK, function (err) {
            if (!err) {
                clearTimeout(timer);
                if (watcher) watcher.close();
                resolve(true);
            }
        });

        var dir = path.dirname(filePath);
        var basename = path.basename(filePath);
        var watcher = fs.watch(dir, function (eventType, filename) {
            if (eventType === 'rename' && filename === basename) {
                clearTimeout(timer);
                if (watcher) watcher.close();
                resolve(true);
            }
        });
    });
}

// helper function to write an already-fetched response body to disk
exports.writeFetchResponseToFile = async (res, fileStream, file_label) => {
    var len = null;
    len = parseInt(res.headers.get("Content-Length"), 10);

    var bar = new ProgressBar(`  Downloading ${file_label} [:bar] :percent :etas`, {
        complete: '=',
        incomplete: ' ',
        width: 20,
        total: len
    });

    let bodyStream = res.body;
    if (!bodyStream) {
        throw new Error('Fetch response body is empty');
    }

    // Native fetch returns a WHATWG ReadableStream. Older clients may still provide a Node stream.
    if (typeof bodyStream.pipe !== 'function') {
        if (typeof Readable.fromWeb !== 'function') {
            throw new Error('Readable.fromWeb is unavailable for fetch response streaming');
        }
        bodyStream = Readable.fromWeb(bodyStream);
    }

    await new Promise((resolve, reject) => {
        bodyStream.pipe(fileStream);
        bodyStream.on("error", (err) => {
          reject(err);
        });
        bodyStream.on('data', function (chunk) {
            bar.tick(chunk.length);
        });
        fileStream.on("error", function(err) {
          reject(err);
        });
        fileStream.on("finish", function() {
          resolve();
        });
    });
}

exports.restartServer = async (is_update = false) => {
    logger.info(`${is_update ? 'Update complete! ' : ''}Restarting server...`);

    // the following line restarts the server through pm2
    fs.writeFileSync(`restart${is_update ? '_update' : '_general'}.json`, 'internal use only');
    process.exit(1);
}

// adds or replaces args according to the following rules:
//  - if it already exists and has value, then replace both arg and value
//  - if already exists and doesn't have value, ignore
//  - if it doesn't exist and has value, add both arg and value
//  - if it doesn't exist and doesn't have value, add arg
exports.injectArgs = (original_args, new_args) => {
    const updated_args = original_args.slice();
    try {
        for (let i = 0; i < new_args.length; i++) {
            const new_arg = new_args[i];
            if (!new_arg.startsWith('-') && !new_arg.startsWith('--') && i > 0 && original_args.includes(new_args[i - 1])) continue;

            if (CONSTS.YTDL_ARGS_WITH_VALUES.has(new_arg)) {
                if (original_args.includes(new_arg)) {
                    const original_index = original_args.indexOf(new_arg);
                    updated_args.splice(original_index, 2);
                }

                updated_args.push(new_arg, new_args[i + 1]);
                i++; // we need to skip the arg value on the next loop
            } else {
                if (!original_args.includes(new_arg)) {
                    updated_args.push(new_arg);
                }
            }
        }
    } catch (err) {
        logger.warn(err);
        logger.warn(`Failed to inject args (${new_args.length} new args) into (${original_args.length} original args)`);
    }

    return updated_args;
}

exports.filterArgs = (args, args_to_remove) => {
    return args.filter(x => !args_to_remove.includes(x));
}

exports.redactCommandArgsForLogging = (args = []) => {
    if (!Array.isArray(args)) return [];

    const sensitive_flags = new Set([
        '--username',
        '--password',
        '--video-password',
        '--ap-username',
        '--ap-password',
        '--proxy',
        '--cookies',
        '--cookies-from-browser',
        '--add-header'
    ]);

    const redacted_args = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (typeof arg !== 'string') {
            redacted_args.push(arg);
            continue;
        }

        if (sensitive_flags.has(arg)) {
            redacted_args.push(arg);
            if (i + 1 < args.length) {
                redacted_args.push('[REDACTED]');
                i++;
            }
            continue;
        }

        const inline_sensitive_flag = [...sensitive_flags].find(flag => arg.startsWith(`${flag}=`));
        if (inline_sensitive_flag) {
            redacted_args.push(`${inline_sensitive_flag}=[REDACTED]`);
            continue;
        }

        redacted_args.push(arg);
    }

    return redacted_args;
}

exports.searchObjectByString = (o, s) => {
    s = s.replace(/\[(\w+)\]/g, '.$1'); // convert indexes to properties
    s = s.replace(/^\./, '');           // strip a leading dot
    var a = s.split('.');
    for (var i = 0, n = a.length; i < n; ++i) {
        var k = a[i];
        if (k in o) {
            o = o[k];
        } else {
            return;
        }
    }
    return o;
}

exports.stripPropertiesFromObject = (obj, properties, whitelist = false) => {
    if (!whitelist) {
        const new_obj = JSON.parse(JSON.stringify(obj));
        for (let field of properties) {
            delete new_obj[field];
        }
        return new_obj;
    }

    const new_obj = {};
    for (let field of properties) {
        new_obj[field] = obj[field];
    }
    return new_obj;
}

exports.getArchiveFolder = (type, user_uid = null, sub = null) => {
    const usersFolderPath = config_api.getConfigItem('ytdl_users_base_path');
    const subsFolderPath  = config_api.getConfigItem('ytdl_subscriptions_base_path');

    if (user_uid) {
        if (sub) {
            return path.join(usersFolderPath, user_uid, 'subscriptions', 'archives', exports.getSubscriptionPathName(sub));
        } else {
            return path.join(usersFolderPath, user_uid, type, 'archives');
        }
    } else {
        if (sub) {
            return path.join(subsFolderPath, 'archives', exports.getSubscriptionPathName(sub));
        } else {
            return path.join('appdata', 'archives');
        }
    }
}

exports.getBaseURL = () => {
    return `${config_api.getConfigItem('ytdl_url')}:${config_api.getConfigItem('ytdl_port')}`
}

exports.getPublicAssetURL = (assetPath = '') => {
    const normalizedPath = String(assetPath).replace(/^\/+/, '');
    return `${exports.getBaseURL()}/${normalizedPath}`;
}

exports.updateLoggerLevel = (new_logger_level) => {
    const possible_levels = ['error', 'warn', 'info', 'verbose', 'debug'];
    if (!possible_levels.includes(new_logger_level)) {
        logger.error(`${new_logger_level} is not a valid logger level! Choose one of the following: ${possible_levels.join(', ')}.`)
        new_logger_level = 'info';
    }
    logger.level = new_logger_level;
    winston.loggers.get('console').level = new_logger_level;
    logger.transports[2].level = new_logger_level;
}

exports.convertFlatObjectToNestedObject = (obj) => {
    const result = {};
    for (const key in obj) {
      const nestedKeys = key.split('.');
      let currentObj = result;
      for (let i = 0; i < nestedKeys.length; i++) {
        if (i === nestedKeys.length - 1) {
          currentObj[nestedKeys[i]] = obj[key];
        } else {
          currentObj[nestedKeys[i]] = currentObj[nestedKeys[i]] || {};
          currentObj = currentObj[nestedKeys[i]];
        }
      }
    }
    return result;
}

exports.getDirectoriesInDirectory = async (basePath) => {
    try {
        const files = await fs.readdir(basePath, { withFileTypes: true });
        return files
            .filter((file) => file.isDirectory())
            .map((file) => path.join(basePath, file.name));
    } catch (err) {
        return [];
    }
}

exports.parseOutputJSON = (output, err) => {
    const split_output = [];

    // If output isn't provided, try a backup path from err (when available)
    if (err && !output) {
        const stderr = (typeof err === 'string') ? err : (err.stderr || '');
        const stdout = (typeof err === 'string') ? '' : (err.stdout || '');

        if (!stderr.includes('This video is unavailable') && !stderr.includes('Private video')) {
            return null;
        }
        logger.info('An error was encountered with at least one video, backup method will be used.');
        try {
            for (const line of stdout.split(/\r\n|\r|\n/)) {
                if (!line) continue;
                const start_idx = line.indexOf('{"');
                if (start_idx === -1) continue;
                const clean = line.slice(start_idx).trim();
                if (clean) split_output.push(clean);
            }
        } catch (e) {
            logger.error('Backup method failed. See error below:');
            logger.error(e);
            return null;
        }
    } else if (!output || output.length === 0 || (output.length === 1 && output[0].length === 0)) {
        // output is '' or ['']
        return [];
    } else {
        for (const output_item of output) {
            if (!output_item) continue;
            // Sometimes there are leading characters before the actual json
            const start_idx = output_item.indexOf('{"');
            if (start_idx === -1) continue;
            const clean_output = output_item.slice(start_idx).trim();
            if (clean_output) split_output.push(clean_output);
        }
    }

    try {
        return split_output.map(str => JSON.parse(str));
    } catch (e) {
        return null;
    }
}

// objects

function File(id, title, thumbnailURL, isAudio, duration, url, uploader, size, path, upload_date, description, view_count, height, abr, source_id = null, source_extractor = null, duplicate_key = null) {
    this.id = id;
    this.title = title;
    this.thumbnailURL = thumbnailURL;
    this.isAudio = isAudio;
    this.duration = duration;
    this.url = url;
    this.uploader = uploader;
    this.size = size;
    this.path = path;
    this.upload_date = upload_date;
    this.description = description;
    this.view_count = view_count;
    this.height = height;
    this.abr = abr;
    this.source_id = source_id;
    this.source_extractor = source_extractor;
    this.duplicate_key = duplicate_key;
    this.favorite = false;
}   
exports.File = File;

/*************************************************
 * Media paths live in the database, and database
 * rows are editable through the API, so a stored
 * path is not trustworthy on its own. Anything that
 * turns one into a filesystem read has to confirm
 * it still points somewhere we actually serve.
 *
 * Comparison is on path.resolve rather than
 * realpath: it stops '..' traversal, which is the
 * reachable case, without breaking the many setups
 * where the media directories are themselves
 * symlinks.
 ************************************************/
exports.getMediaRoots = () => {
    const configured_roots = [
        config_api.getConfigItem('ytdl_video_folder_path'),
        config_api.getConfigItem('ytdl_audio_folder_path'),
        config_api.getConfigItem('ytdl_users_base_path'),
        config_api.getConfigItem('ytdl_subscriptions_base_path')
    ];
    return configured_roots
        .filter(root => typeof root === 'string' && root.trim())
        .map(root => realPathOrResolved(root));
}

exports.pathIsWithin = (candidate_path, container_path) => {
    const relative_path = path.relative(container_path, candidate_path);
    if (relative_path === '') return true;
    return !relative_path.startsWith('..') && !path.isAbsolute(relative_path);
}

/*************************************************
 * path.resolve only collapses '..' textually; it
 * will happily hand back a path inside a media
 * folder that is a symlink pointing anywhere at
 * all. realpath follows the link, so the check is
 * made against what would actually be opened.
 *
 * A path that does not exist cannot be followed --
 * a download still in flight, a record whose file
 * has already been removed -- so those fall back
 * to the lexical answer, which still refuses '..'.
 ************************************************/
function realPathOrResolved(target_path) {
    const resolved_path = path.resolve(target_path);
    const trailing_segments = [];
    let candidate_path = resolved_path;

    // Walk up until something exists to canonicalize. Calling realpath on the whole path
    // and giving up when it throws is not enough: an output template names a file that
    // has not been written yet, so the call always fails and the answer falls back to the
    // lexical one -- which walks straight through a symlinked directory on the way down.
    for (;;) {
        try {
            const real_path = fs.realpathSync(candidate_path);
            if (!trailing_segments.length) return real_path;
            return path.join(real_path, ...trailing_segments.slice().reverse());
        } catch {
            const parent_path = path.dirname(candidate_path);
            // Reached the filesystem root without finding anything that exists.
            if (parent_path === candidate_path) return resolved_path;
            trailing_segments.push(path.basename(candidate_path));
            candidate_path = parent_path;
        }
    }
}

/*************************************************
 * Narrows the roots to those a given owner's media
 * may legitimately live in.
 *
 * Not simply users/<uid>: media does not always
 * move when ownership does. ytdl_oidc_migrate_videos
 * reassigns unowned records to a user and leaves
 * the files in the shared video/ and audio/ roots,
 * so restricting to the per-user directory makes
 * every migrated file unstreamable, undownloadable
 * and undeletable.
 *
 * What is actually being excluded is *other*
 * users' directories, so the shared roots stay and
 * only this user's own directory is added back out
 * of users/.
 ************************************************/
exports.getMediaRootsForUser = (user_uid) => {
    const roots = exports.getMediaRoots();
    if (!user_uid || !config_api.getConfigItem('ytdl_multi_user_mode')) return roots;

    const users_base_path = config_api.getConfigItem('ytdl_users_base_path');
    if (!users_base_path) return roots;

    const shared_users_root = realPathOrResolved(users_base_path);
    const own_directory = realPathOrResolved(path.join(users_base_path, user_uid));

    return [...roots.filter(root => root !== shared_users_root), own_directory];
}

/*************************************************
 * Filters derived sidecar paths down to the ones
 * that really are siblings of their media file.
 *
 * Deriving a sidecar by swapping the extension
 * settles where the *name* is. It says nothing about
 * where a symlink at that name points, and reads,
 * chmods and ffmpeg all follow one. Canonicalizing
 * both sides settles it.
 *
 * The invariant is deliberately local -- same
 * directory as the media file -- rather than "inside
 * the media roots". The roots are configuration, and
 * a sidecar belongs to its file wherever that file
 * is; whether the file itself belongs anywhere is a
 * separate question, asked separately by the callers
 * that serve it.
 ************************************************/
exports.keepSiblingSidecarPaths = (file_path, candidate_paths = []) => {
    if (typeof file_path !== 'string' || !file_path.trim()) return [];
    const parent_directory = realPathOrResolved(path.dirname(path.resolve(file_path)));
    return candidate_paths.filter(candidate_path => {
        if (typeof candidate_path !== 'string' || !candidate_path.trim()) return false;
        return path.dirname(realPathOrResolved(candidate_path)) === parent_directory;
    });
}

exports.isPathInsideMediaRoots = (candidate_path, user_uid = null) => {
    if (typeof candidate_path !== 'string' || !candidate_path.trim()) return false;
    const resolved_path = realPathOrResolved(candidate_path);
    const roots = exports.getMediaRootsForUser(user_uid);
    if (roots.length === 0) return false;
    return roots.some(root => exports.pathIsWithin(resolved_path, root));
}

/*************************************************
 * Containment on its own is not enough for anything
 * that reads or deletes. A directory is "inside"
 * the media roots too -- so is a media root itself
 * -- and none of these endpoints mean a directory
 * when they say path.
 ************************************************/
exports.isServableMediaFile = (candidate_path, user_uid = null) => {
    if (!exports.isPathInsideMediaRoots(candidate_path, user_uid)) return false;
    try {
        return fs.statSync(realPathOrResolved(candidate_path)).isFile();
    } catch {
        return false;
    }
}

/*************************************************
 * Which yt-dlp options a caller may supply.
 *
 * This was a denylist of the dangerous options,
 * which cannot work: yt-dlp's parser accepts any
 * unambiguous abbreviation of a long option, so
 * '--exec-before-d' reaches the same code as
 * '--exec' while matching no denied name. It also
 * accepts attached short values ('-o/tmp/x'),
 * clustered short options, and user-defined
 * aliases. A list of what to refuse can be walked
 * around; a list of what to accept cannot.
 *
 * Everything here shapes a download -- what format,
 * which subtitles, how fast, how many retries.
 * Nothing here runs a command, names a binary,
 * loads options from elsewhere, or chooses a path.
 * An option that is not on this list is refused,
 * abbreviations included, which is the point.
 *
 * The escape hatch for anything genuinely missing
 * is Downloader.custom_args in the settings page,
 * which is administrator-only and does not pass
 * through here.
 ************************************************/
const ALLOWED_DOWNLOAD_ARGS = [
    // format and quality
    '-f', '--format', '-S', '--format-sort', '--format-sort-force', '--merge-output-format',
    '--audio-format', '--audio-quality', '-x', '--extract-audio', '--remux-video', '--recode-video',
    '--prefer-free-formats', '--check-formats', '--no-check-formats',
    '--video-multistreams', '--audio-multistreams',
    // subtitles
    '--write-subs', '--write-auto-subs', '--no-write-subs', '--no-write-auto-subs', '--all-subs',
    '--sub-lang', '--sub-langs', '--sub-format', '--convert-subs', '--convert-subtitles',
    '--embed-subs', '--no-embed-subs',
    // metadata and thumbnails
    '--embed-metadata', '--add-metadata', '--no-embed-metadata',
    '--embed-thumbnail', '--no-embed-thumbnail', '--write-thumbnail', '--no-write-thumbnail',
    '--write-description', '--write-info-json', '--no-write-info-json',
    '--embed-chapters', '--no-embed-chapters', '--parse-metadata', '--replace-in-metadata', '--xattrs',
    // playlists
    '-I', '--playlist-items', '--playlist-start', '--playlist-end', '--yes-playlist', '--no-playlist',
    '--playlist-reverse', '--playlist-random', '--max-downloads',
    // filters
    '--match-filter', '--match-filters', '--break-match-filter', '--break-match-filters',
    '--min-filesize', '--max-filesize', '--date', '--datebefore', '--dateafter',
    '--min-views', '--max-views', '--match-title', '--reject-title', '--age-limit',
    '--break-on-existing', '--no-break-on-existing',
    // network and retries
    '-r', '--limit-rate', '--throttled-rate', '-R', '--retries', '--file-access-retries',
    '--fragment-retries', '--retry-sleep', '--socket-timeout', '-N', '--concurrent-fragments',
    '--buffer-size', '--http-chunk-size', '-4', '--force-ipv4', '-6', '--force-ipv6', '--source-address',
    // pacing
    '--sleep-requests', '--sleep-interval', '--min-sleep-interval', '--max-sleep-interval', '--sleep-subtitles',
    // filenames and overwrite behaviour
    '--no-mtime', '--mtime', '--no-part', '--part', '--continue', '--no-continue',
    '-i', '--ignore-errors', '--no-abort-on-error', '--abort-on-error', '--skip-unavailable-fragments',
    '--no-overwrites', '-w', '--force-overwrites',
    '--windows-filenames', '--no-windows-filenames', '--trim-filenames',
    '--restrict-filenames', '--no-restrict-filenames',
    // geo
    '--geo-bypass', '--no-geo-bypass', '--geo-bypass-country', '--geo-bypass-ip-block',
    // sponsorblock
    '--sponsorblock-mark', '--sponsorblock-remove', '--no-sponsorblock', '--sponsorblock-chapter-title',
    // extractor and http shaping
    '--extractor-args', '--user-agent', '--referer', '--add-header', '--impersonate',
    // output verbosity
    '-v', '--verbose', '-q', '--quiet', '--no-warnings', '--newline', '--progress', '--no-progress',
    '-s', '--simulate', '--no-simulate', '--skip-download'
];

exports.ALLOWED_DOWNLOAD_ARGS = ALLOWED_DOWNLOAD_ARGS;

const ADVANCED_DOWNLOAD_FIELDS = ['customArgs', 'additionalArgs', 'customOutput'];

exports.ADVANCED_DOWNLOAD_FIELDS = ADVANCED_DOWNLOAD_FIELDS;

exports.hasAdvancedDownloadOptions = (options) => {
    if (!options || typeof options !== 'object') return false;
    return ADVANCED_DOWNLOAD_FIELDS.some(field => typeof options[field] === 'string' && options[field].trim() !== '');
}

function isAllowedDownloadArg(flag) {
    // Long options are compared case-insensitively; short ones are not, because yt-dlp
    // reads '-P' and '-p' as different options.
    if (ALLOWED_DOWNLOAD_ARGS.includes(flag)) return true;
    return flag.startsWith('--') && ALLOWED_DOWNLOAD_ARGS.includes(flag.toLowerCase());
}

exports.findDisallowedDownloadArgs = (raw_args) => {
    if (typeof raw_args !== 'string' || !raw_args.trim()) return [];

    return raw_args.split(',,')
        // yt-dlp accepts '--format=best' and '--format best' alike, and the delimiter
        // splits on ',,' rather than whitespace, so either form can be one token.
        .map(arg => arg.trim().split(/[=\s]/)[0])
        // A token that does not begin with '-' is a value belonging to the option before
        // it, not an option of its own.
        .filter(arg => arg.startsWith('-') && !isAllowedDownloadArg(arg));
}

/*************************************************
 * Constant-time string comparison, for secrets
 * that arrive on a request. A plain === leaks how
 * much of the value was right through how long the
 * comparison took.
 ************************************************/
exports.timingSafeEquals = (provided, expected) => {
    if (typeof provided !== 'string' || typeof expected !== 'string') return false;
    const provided_buffer = Buffer.from(provided);
    const expected_buffer = Buffer.from(expected);
    if (provided_buffer.length !== expected_buffer.length) return false;
    return crypto.timingSafeEqual(provided_buffer, expected_buffer);
}

/*************************************************
 * Quarantine rather than repair.
 *
 * Arguments arrive as one string split on ',,', so
 * a flag and its value can share a token or sit in
 * separate ones. Removing just the offending flag
 * would leave its value behind as a stray token,
 * which yt-dlp reads as a URL. Discarding the whole
 * string is unambiguous, and an argument list that
 * contains one of these was not written by the
 * download dialog in the first place.
 *
 * Used at the downloader boundary, where stored
 * subscription arguments and resumed queue entries
 * arrive without ever passing an HTTP handler.
 ************************************************/
exports.quarantineDisallowedDownloadArgs = (raw_args, context = 'download') => {
    const disallowed_args = exports.findDisallowedDownloadArgs(raw_args);
    if (!disallowed_args.length) return raw_args;

    logger.error(`Discarding the custom arguments for this ${context}: ${disallowed_args.join(', ')} `
        + `${disallowed_args.length === 1 ? 'is not an option' : 'are not options'} a download may set. `
        + `The download will continue with its ordinary arguments.`);
    return null;
}

/*************************************************
 * customOutput is a yt-dlp output template joined
 * onto the download folder, so '../' in it walks
 * out of that folder exactly like any other path.
 * The template placeholders are left alone -- what
 * is being checked is the literal part.
 ************************************************/
exports.sanitizeCustomOutput = (custom_output, folder_path) => {
    if (typeof custom_output !== 'string' || !custom_output.trim()) return null;
    if (path.isAbsolute(custom_output)) {
        logger.error(`Ignoring a custom output that is an absolute path: ${custom_output}`);
        return null;
    }

    // realpath rather than resolve: a directory inside the folder can be a symlink, and
    // a lexical check walks straight through it.
    const joined_path = realPathOrResolved(path.join(folder_path, custom_output));
    if (!exports.pathIsWithin(joined_path, realPathOrResolved(folder_path))) {
        logger.error(`Ignoring a custom output that escapes its download folder: ${custom_output}`);
        return null;
    }

    return custom_output;
}

/*************************************************
 * yt-dlp reads anything option-shaped as an
 * option, wherever it sits on the command line. A
 * URL that begins with '-' is therefore not data:
 * '--update-to=owner/repo@tag' asks it to replace
 * its own binary from another repository.
 *
 * The launchers put '--' between the options and
 * the URL, which stops the parsing. This is the
 * second half: a URL still has to be a URL, and one
 * of a scheme worth fetching.
 ************************************************/
const ALLOWED_DOWNLOAD_URL_PROTOCOLS = ['http:', 'https:'];

exports.ALLOWED_DOWNLOAD_URL_PROTOCOLS = ALLOWED_DOWNLOAD_URL_PROTOCOLS;

exports.isAllowedDownloadURL = (candidate_url) => {
    if (typeof candidate_url !== 'string' || !candidate_url.trim()) return false;
    // Rejected before parsing as well: a value starting with '-' is an option to yt-dlp
    // whatever the URL parser makes of it.
    if (candidate_url.trim().startsWith('-')) return false;

    try {
        return ALLOWED_DOWNLOAD_URL_PROTOCOLS.includes(new URL(candidate_url.trim()).protocol);
    } catch {
        return false;
    }
}

/*************************************************
 * Parses one HTTP byte range against a known file
 * size, per RFC 9110 section 14.
 *
 * The handler this replaces got the browser case
 * right and every other case wrong, which is why
 * nothing noticed: a browser sends one polite
 * 'bytes=0-' and never asks again. Anything driving
 * a remote file with ffmpeg does not behave that
 * way -- it reads the tail of the container to find
 * an index, and it seeks speculatively past the end
 * -- and both of those used to hang the connection
 * or throw.
 *
 * Returns one of:
 *   null                     no range header, or one
 *                            to ignore and answer 200
 *   {satisfiable: false}     answer 416
 *   {start, end, length}     answer 206, inclusive
 *
 * An unparseable header is deliberately ignored
 * rather than refused. RFC 9110 says a recipient
 * that does not understand a Range header must
 * treat the request as though it had none, and a
 * player that sends something odd is better served
 * the whole file than a 500.
 ************************************************/
exports.parseByteRange = (range_header, file_size) => {
    if (typeof range_header !== 'string') return null;
    if (!Number.isInteger(file_size) || file_size < 0) return null;

    // Only 'bytes' is defined, and only a single range is answered here. A multi-range
    // request is answered with the whole file rather than a multipart body.
    const match = /^bytes=(\d*)-(\d*)$/.exec(range_header.trim());
    if (!match) return null;

    const [, raw_start, raw_end] = match;
    if (raw_start === '' && raw_end === '') return null;

    // An empty file cannot satisfy any range, including the suffix form.
    if (file_size === 0) return {satisfiable: false};

    let start;
    let end;
    if (raw_start === '') {
        // Suffix form: 'bytes=-500' is the last 500 bytes, not 'from 0 to 500'. Asking for
        // more than the file holds is satisfiable and means the whole file.
        const suffix_length = parseInt(raw_end, 10);
        if (suffix_length === 0) return {satisfiable: false};
        start = Math.max(0, file_size - suffix_length);
        end = file_size - 1;
    } else {
        start = parseInt(raw_start, 10);
        // Clamped, because the read stream stops at EOF whatever was asked for. Without
        // this the Content-Length promised more bytes than could ever arrive, and the
        // client waited for the remainder until it gave up.
        end = raw_end === '' ? file_size - 1 : Math.min(parseInt(raw_end, 10), file_size - 1);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start >= file_size || start > end) return {satisfiable: false};

    return {start: start, end: end, length: (end - start) + 1};
}

/*************************************************
 * Sends an open read stream to an HTTP response,
 * and takes responsibility for closing it.
 *
 * Two things this replaces a bare .pipe() for.
 *
 * A read error had no listener. fs.existsSync runs
 * before the stream is opened, so a file deleted in
 * between -- which this application does to its own
 * files, during playback -- emitted 'error' on an
 * emitter nobody was listening to. That is an
 * uncaught exception, and it takes the server down
 * rather than the request.
 *
 * .pipe() also does not destroy the source when the
 * destination goes away, and a client that walks
 * away mid-response is not an edge case here: it is
 * how a player seeks. Every abandoned seek left an
 * open descriptor and an entry in the registry
 * below, neither of which was ever released.
 *
 * The registry is what lets a delete release its
 * file locks first (see files.js), so an entry that
 * outlives its stream is not merely garbage -- it
 * is a lock nobody can find their way back to.
 ************************************************/
exports.pipeMediaFileToResponse = (file, res, uid) => {
    if (config_api.descriptors[uid]) config_api.descriptors[uid].push(file);
    else                             config_api.descriptors[uid] = [file];

    const forgetDescriptor = () => {
        const open_descriptors = config_api.descriptors[uid];
        if (!open_descriptors) return;
        const index = open_descriptors.indexOf(file);
        // splice(-1, 1) drops the last element, so an entry already removed used to take
        // an unrelated live stream out of the registry with it.
        if (index !== -1) open_descriptors.splice(index, 1);
        // Otherwise the object keeps one empty array per uid ever streamed.
        if (!open_descriptors.length) delete config_api.descriptors[uid];
    };

    pipeline(file, res, (err) => {
        forgetDescriptor();
        if (!err) {
            logger.debug('Successfully closed stream and removed file reference.');
            return;
        }
        // A client hanging up is ordinary -- a player seeking abandons the response it
        // asked for -- so it is not logged as a failure. Anything else is a real read
        // error, and the response is already committed by the time it surfaces.
        if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'ECONNRESET') {
            logger.debug(`Client closed the connection while streaming ${uid}.`);
            return;
        }
        logger.error(`Error while streaming ${uid}: ${err.message}`);
    });
}
