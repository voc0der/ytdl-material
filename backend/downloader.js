const fs = require('fs-extra');
const { v4: uuid } = require('uuid');
const path = require('path');
const NodeID3 = require('node-id3')
const Mutex = require('async-mutex').Mutex;

const logger = require('./logger');
const youtubedl_api = require('./youtube-dl');
const config_api = require('./config');
const twitch_api = require('./twitch');
const { create } = require('xmlbuilder2');
const categories_api = require('./categories');
const utils = require('./utils');
const db_api = require('./db');
const files_api = require('./files');
const notifications_api = require('./notifications');
const archive_api = require('./archive');

const mutex = new Mutex();
let should_check_downloads = true;

const download_to_child_process = {};
const active_progress_checks = new Set();
const DEFAULT_PLAYLIST_CHUNK_SIZE = 20;
const MAX_AUTOMATIC_PLAYLIST_CHUNKS = Math.max(1, Number(process.env.YTDL_MAX_PLAYLIST_CHUNKS) || 20);
const PLAYLIST_RANGE_ARG_KEYS = ['--playlist-items', '--playlist-start', '--playlist-end', '--max-downloads'];

function asFiniteNumber(value, defaultValue = 0) {
    const numeric_value = Number(value);
    return Number.isFinite(numeric_value) ? numeric_value : defaultValue;
}

function parseDelimitedArgs(args_string = '') {
    if (typeof args_string !== 'string' || args_string.trim() === '') return [];
    return args_string.split(',,').map(arg => arg.trim()).filter(arg => arg !== '');
}

function getConfiguredPlaylistChunkSize() {
    return Math.max(1, asFiniteNumber(config_api.getConfigItem('ytdl_playlist_chunk_size'), DEFAULT_PLAYLIST_CHUNK_SIZE));
}

function hasArg(args = [], target_arg = '') {
    if (!Array.isArray(args) || !target_arg) return false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (typeof arg !== 'string') continue;
        if (arg === target_arg || arg.startsWith(`${target_arg}=`)) return true;
    }
    return false;
}

function hasPlaylistRangeArgs(args = []) {
    if (!Array.isArray(args) || args.length === 0) return false;
    return PLAYLIST_RANGE_ARG_KEYS.some(range_arg_key => hasArg(args, range_arg_key));
}

function isLikelyPlaylistURL(url = '') {
    if (typeof url !== 'string' || url.trim() === '') return false;
    try {
        const parsed_url = new URL(url);
        if (parsed_url.searchParams.has('list')) return true;
        return parsed_url.pathname.includes('/playlist');
    } catch (e) {
        return url.includes('list=') || url.includes('/playlist');
    }
}

function buildPlaylistChunkRanges(total_items, chunk_size = DEFAULT_PLAYLIST_CHUNK_SIZE, max_chunks = MAX_AUTOMATIC_PLAYLIST_CHUNKS) {
    const normalized_total_items = Math.max(0, asFiniteNumber(total_items, 0));
    if (!normalized_total_items) return [];

    let normalized_chunk_size = Math.max(1, asFiniteNumber(chunk_size, DEFAULT_PLAYLIST_CHUNK_SIZE));
    const normalized_max_chunks = Math.max(1, asFiniteNumber(max_chunks, MAX_AUTOMATIC_PLAYLIST_CHUNKS));

    const initial_chunk_count = Math.ceil(normalized_total_items / normalized_chunk_size);
    if (initial_chunk_count > normalized_max_chunks) {
        normalized_chunk_size = Math.ceil(normalized_total_items / normalized_max_chunks);
    }

    const ranges = [];
    for (let start = 1; start <= normalized_total_items; start += normalized_chunk_size) {
        const end = Math.min(normalized_total_items, start + normalized_chunk_size - 1);
        ranges.push({
            start: start,
            end: end,
            label: `${start}-${end}`
        });
    }
    return ranges;
}
exports.buildPlaylistChunkRanges = buildPlaylistChunkRanges;

function formatChunkedPlaylistTitle(base_title = 'Playlist', chunk_range_label = null, chunk_index = null, chunk_count = null) {
    const normalized_title = typeof base_title === 'string' && base_title.trim() !== '' ? base_title.trim() : 'Playlist';
    if (!chunk_range_label) return normalized_title;

    const normalized_chunk_index = Number(chunk_index);
    const normalized_chunk_count = Number(chunk_count);
    if (Number.isFinite(normalized_chunk_index) && Number.isFinite(normalized_chunk_count) && normalized_chunk_index > 0 && normalized_chunk_count > 0) {
        return `${normalized_title} [Chunk ${normalized_chunk_index}/${normalized_chunk_count}: ${chunk_range_label}]`;
    }

    return `${normalized_title} [${chunk_range_label}]`;
}

function appendAdditionalArgs(existing_args_string = '', args_to_append = []) {
    const existing_args = parseDelimitedArgs(existing_args_string);
    const additional_args = (Array.isArray(args_to_append) ? args_to_append : []).filter(arg => arg !== undefined && arg !== null && String(arg).trim() !== '').map(arg => String(arg));
    return existing_args.concat(additional_args).join(',,');
}

function shouldAutoChunkPlaylist(url, options = {}) {
    if (!isLikelyPlaylistURL(url)) return false;
    if (!options || typeof options !== 'object') return true;
    if (typeof options.customArgs === 'string' && options.customArgs.trim() !== '') return false;

    const additional_args = parseDelimitedArgs(options.additionalArgs);
    if (additional_args.length === 0) return true;

    if (hasArg(additional_args, '--no-playlist')) return false;
    if (hasPlaylistRangeArgs(additional_args)) return false;

    return true;
}

function shouldMarkPlaylistAsExclusive(url, options = {}) {
    if (!isLikelyPlaylistURL(url)) return false;
    if (!options || typeof options !== 'object') return true;

    const additional_args = parseDelimitedArgs(options.additionalArgs);
    const custom_args = parseDelimitedArgs(options.customArgs);

    if (hasArg(additional_args, '--no-playlist') || hasArg(custom_args, '--no-playlist')) {
        return false;
    }
    return true;
}

function isExclusivePlaylistDownload(download = null) {
    if (!download || typeof download !== 'object') return false;
    const options = download.options && typeof download.options === 'object' ? download.options : {};

    if (options.playlistExclusive === true) return true;
    if (options.playlistChunkRange) return true;

    if (!isLikelyPlaylistURL(download.url || '')) return false;

    const additional_args = parseDelimitedArgs(options.additionalArgs);
    const custom_args = parseDelimitedArgs(options.customArgs);
    if (hasArg(additional_args, '--no-playlist') || hasArg(custom_args, '--no-playlist')) return false;

    return true;
}
exports.isExclusivePlaylistDownload = isExclusivePlaylistDownload;

function getExclusivePlaylistGroupKey(download = null) {
    if (!isExclusivePlaylistDownload(download)) return null;
    const options = download.options && typeof download.options === 'object' ? download.options : {};

    if (options.playlistBatchId) return `playlist-batch:${options.playlistBatchId}`;
    if (options.ui_uid) return `playlist-ui:${options.ui_uid}`;

    const user_uid = download && download.user_uid ? download.user_uid : 'global';
    const type = download && download.type ? download.type : 'video';
    const url = download && download.url ? download.url : '';
    return `playlist-url:${user_uid}:${type}:${url}`;
}
exports.getExclusivePlaylistGroupKey = getExclusivePlaylistGroupKey;

function getPlaylistBatchBaseTitle(download = null) {
    if (!download || typeof download !== 'object') return 'Playlist';
    const options = download.options && typeof download.options === 'object' ? download.options : {};

    if (typeof options.playlistChunkTitle === 'string' && options.playlistChunkTitle.trim() !== '') {
        return options.playlistChunkTitle.trim();
    }

    const title = typeof download.title === 'string' ? download.title.trim() : '';
    if (!title) return 'Playlist';

    const stripped_title = title.replace(/\s*\[Chunk\s+\d+\/\d+:\s*[^\]]+\]\s*$/i, '').trim();
    return stripped_title || title;
}

function sortBatchDownloadsForMerge(download1, download2) {
    const chunk_index_1 = asFiniteNumber(download1 && download1.options ? download1.options.playlistChunkIndex : Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const chunk_index_2 = asFiniteNumber(download2 && download2.options ? download2.options.playlistChunkIndex : Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (chunk_index_1 !== chunk_index_2) return chunk_index_1 - chunk_index_2;

    const timestamp_1 = asFiniteNumber(download1 ? download1.timestamp_start : 0, 0);
    const timestamp_2 = asFiniteNumber(download2 ? download2.timestamp_start : 0, 0);
    if (timestamp_1 !== timestamp_2) return timestamp_1 - timestamp_2;

    const uid_1 = download1 && download1.uid ? download1.uid : '';
    const uid_2 = download2 && download2.uid ? download2.uid : '';
    return uid_1.localeCompare(uid_2);
}

function getDownloadContainerReference(container = null) {
    if (!container || typeof container !== 'object') return null;

    // Keep download queue payloads small. The UI only needs playlist id (or file uid)
    // to navigate to the correct player view.
    if (container.id) {
        return {
            id: container.id,
            uids: []
        };
    }

    if (container.uid) {
        return {
            uid: container.uid
        };
    }

    return container;
}

async function finalizePlaylistBatchContainer(download_uid = null) {
    if (!download_uid) return null;

    const completed_download = await db_api.getRecord('download_queue', {uid: download_uid});
    if (!completed_download || !isExclusivePlaylistDownload(completed_download)) return null;

    const options = completed_download.options && typeof completed_download.options === 'object' ? completed_download.options : {};
    const playlist_batch_id = options.playlistBatchId;
    if (!playlist_batch_id) return null;

    const batch_filter = {'options.playlistBatchId': playlist_batch_id};
    if (completed_download.user_uid !== undefined && completed_download.user_uid !== null) {
        batch_filter['user_uid'] = completed_download.user_uid;
    }
    if (completed_download.type) {
        batch_filter['type'] = completed_download.type;
    }

    const batch_downloads = await db_api.getRecords('download_queue', batch_filter);
    if (!Array.isArray(batch_downloads) || batch_downloads.length === 0) return null;

    const active_batch_download_exists = batch_downloads.some(download => !download.finished && !download.error && !download.cancelled);
    if (active_batch_download_exists) return null;

    const successful_batch_downloads = batch_downloads
        .filter(download => download.finished && !download.error && Array.isArray(download.file_uids) && download.file_uids.length > 0)
        .sort(sortBatchDownloadsForMerge);
    if (successful_batch_downloads.length === 0) {
        await db_api.updateRecords('download_queue', batch_filter, {playlist_batch_finalized: true, playlist_batch_container_id: null});
        return null;
    }

    let final_container = null;
    // Idempotency guard: if this batch was already finalized, reuse its container.
    const finalized_batch_download = batch_downloads.find(download => download.playlist_batch_finalized && download.playlist_batch_container_id);
    if (finalized_batch_download) {
        const existing_playlist = await db_api.getRecord('playlists', {id: finalized_batch_download.playlist_batch_container_id});
        if (existing_playlist) {
            final_container = existing_playlist;
        }
    }

    if (!final_container) {
        if (successful_batch_downloads.length === 1) {
            const successful_download = successful_batch_downloads[0];
            if (successful_download.container) {
                final_container = successful_download.container;
            } else if (successful_download.file_uids.length > 1) {
                final_container = await files_api.createPlaylist(getPlaylistBatchBaseTitle(successful_download), successful_download.file_uids, successful_download.user_uid);
            } else {
                final_container = await files_api.getVideo(successful_download.file_uids[0], successful_download.user_uid);
            }
        } else {
            const merged_file_uids = [];
            const seen_file_uids = new Set();
            for (const successful_download of successful_batch_downloads) {
                const file_uids = Array.isArray(successful_download.file_uids) ? successful_download.file_uids : [];
                for (const file_uid of file_uids) {
                    if (!file_uid || seen_file_uids.has(file_uid)) continue;
                    seen_file_uids.add(file_uid);
                    merged_file_uids.push(file_uid);
                }
            }

            if (merged_file_uids.length > 1) {
                final_container = await files_api.createPlaylist(getPlaylistBatchBaseTitle(successful_batch_downloads[0]), merged_file_uids, completed_download.user_uid);
            } else if (merged_file_uids.length === 1) {
                final_container = await files_api.getVideo(merged_file_uids[0], completed_download.user_uid);
            }
        }
    }
    if (!final_container) return null;

    const final_container_reference = getDownloadContainerReference(final_container);
    const final_playlist_id = final_container_reference && final_container_reference.id ? final_container_reference.id : null;
    const chunk_playlist_ids_to_remove = new Set();

    for (const batch_download of batch_downloads) {
        const existing_container_id = batch_download && batch_download.container ? batch_download.container.id : null;
        if (existing_container_id && existing_container_id !== final_playlist_id) {
            chunk_playlist_ids_to_remove.add(existing_container_id);
        }
    }

    await db_api.updateRecords('download_queue', batch_filter, {
        playlist_batch_finalized: true,
        playlist_batch_container_id: final_playlist_id
    });

    const successful_batch_filter = {
        ...batch_filter,
        finished: true,
        error: null
    };
    await db_api.updateRecords('download_queue', successful_batch_filter, {
        container: final_container_reference
    });

    for (const chunk_playlist_id of chunk_playlist_ids_to_remove) {
        await db_api.removeRecord('playlists', {id: chunk_playlist_id});
    }

    return final_container;
}
exports.finalizePlaylistBatchContainer = finalizePlaylistBatchContainer;

async function getPlaylistChunkingMetadata(url, options = {}) {
    const probe_args = ['--flat-playlist', '--dump-single-json', '--ignore-errors'];
    if (url.includes('list=') && !probe_args.includes('--yes-playlist')) {
        probe_args.push('--yes-playlist');
    }

    if (options.youtubeUsername && options.youtubePassword) {
        probe_args.push('--username', options.youtubeUsername, '--password', options.youtubePassword);
    }

    const cookies_path = path.join(__dirname, 'appdata', 'cookies.txt');
    if (!hasArg(probe_args, '--cookies') && await fs.pathExists(cookies_path)) {
        probe_args.push('--cookies', path.join('appdata', 'cookies.txt'));
    }

    logger.debug(`Probing playlist metadata for automatic chunking: ${url}`);
    try {
        const run_result = await youtubedl_api.runYoutubeDL(url, probe_args);
        if (!run_result || !run_result.callback) return null;
        const {parsed_output} = await run_result.callback;
        if (!Array.isArray(parsed_output) || parsed_output.length === 0) return null;

        let playlist_root = parsed_output.find(item => item && Array.isArray(item['entries']));
        if (!playlist_root && parsed_output.length === 1) playlist_root = parsed_output[0];

        if (playlist_root && Array.isArray(playlist_root['entries'])) {
            const entries = playlist_root['entries'];
            const valid_entries = entries.filter(entry => !!entry).length;
            const fallback_entry_count = asFiniteNumber(playlist_root['playlist_count'], 0);
            const indexed_entry_count = entries.length;
            const entry_count = Math.max(indexed_entry_count, valid_entries, fallback_entry_count);
            if (!entry_count) return null;
            return {
                entry_count: entry_count,
                title: playlist_root['title'] || playlist_root['playlist_title'] || playlist_root['playlist'] || null
            };
        }

        // Fallback: when yt-dlp returns one JSON object per entry.
        if (parsed_output.length > 1) {
            const first = parsed_output[0] || {};
            const max_playlist_index = parsed_output.reduce((max_index, entry) => {
                if (!entry) return max_index;
                return Math.max(max_index, asFiniteNumber(entry['playlist_index'], 0));
            }, 0);
            return {
                entry_count: Math.max(parsed_output.filter(entry => !!entry).length, max_playlist_index),
                title: first['playlist_title'] || first['playlist'] || null
            };
        }
    } catch (e) {
        logger.warn(`Failed to probe playlist metadata for automatic chunking: ${url}`);
        logger.debug(e);
    }

    return null;
}

function buildPlaylistItemProgress(info = []) {
    if (!Array.isArray(info) || info.length <= 1) return null;

    return info.map((info_obj, index) => {
        let expected_file_size = 0;
        try {
            expected_file_size = asFiniteNumber(utils.getExpectedFileSize(info_obj), 0);
        } catch (e) {
            expected_file_size = 0;
        }

        return {
            index: index + 1,
            id: info_obj && info_obj['id'] ? info_obj['id'] : null,
            title: info_obj && info_obj['title'] ? info_obj['title'] : `Item ${index + 1}`,
            expected_file_size: expected_file_size,
            downloaded_size: 0,
            percent_complete: 0,
            status: 'pending',
            progress_path_index: index
        };
    });
}

function finalizePlaylistItemProgress(existing_items = [], parsed_output = []) {
    if (!Array.isArray(existing_items) || existing_items.length === 0) return null;

    const completed_ids = new Set();
    const completed_titles = new Set();
    if (Array.isArray(parsed_output)) {
        for (let i = 0; i < parsed_output.length; i++) {
            const output_item = parsed_output[i];
            if (!output_item) continue;
            if (output_item['id']) completed_ids.add(output_item['id']);
            if (output_item['title']) completed_titles.add(output_item['title']);
        }
    }

    return existing_items.map(item => {
        if (!item) return item;

        const item_completed = (item.id && completed_ids.has(item.id))
            || (item.title && completed_titles.has(item.title));

        if (item_completed) {
            const expected_file_size = asFiniteNumber(item.expected_file_size, 0);
            const downloaded_size = Math.max(asFiniteNumber(item.downloaded_size, 0), expected_file_size);
            return {
                ...item,
                downloaded_size: downloaded_size,
                percent_complete: 100,
                status: 'complete'
            };
        }

        return {
            ...item,
            status: 'failed'
        };
    });
}

function hasReachedConcurrentDownloadLimit(maxConcurrentDownloads, runningDownloadsCount) {
    const normalizedLimit = Number(maxConcurrentDownloads);
    // `-1` (and other negative values) mean "no limit" in the UI/config.
    if (!Number.isFinite(normalizedLimit) || normalizedLimit < 0) return false;
    return runningDownloadsCount >= normalizedLimit;
}
exports.hasReachedConcurrentDownloadLimit = hasReachedConcurrentDownloadLimit;

if (db_api.database_initialized) {
    exports.setupDownloads();
} else {
    db_api.database_initialized_bs.subscribe(init => {
        if (init) exports.setupDownloads();
    });
}

/*

This file handles all the downloading functionality.

To download a file, we go through 4 steps. Here they are with their respective index & function:

0: Create the download
 - createDownload()
1: Get info for the download (we need this step for categories and archive functionality)
 - collectInfo()
2: Download the file
 - downloadQueuedFile()
3: Complete
 - N/A

We use checkDownloads() to move downloads through the steps and call their respective functions.

*/

exports.createDownload = async (url, type, options, user_uid = null, sub_id = null, sub_name = null, prefetched_info = null, paused = false, display_title = null) => {
    return await mutex.runExclusive(async () => {
        const download = {
            url: url,
            type: type,
            title: display_title || '',
            user_uid: user_uid,
            sub_id: sub_id,
            sub_name: sub_name,
            prefetched_info: prefetched_info,
            options: options,
            uid: uuid(),
            step_index: 0,
            paused: paused,
            running: false,
            finished_step: true,
            error: null,
            percent_complete: null,
            playlist_item_progress: null,
            finished: false,
            timestamp_start: Date.now()
        };
        await db_api.insertRecordIntoTable('download_queue', download);
    
        should_check_downloads = true;
        return download;
    });
}

exports.createDownloads = async (url, type, options = {}, user_uid = null, sub_id = null, sub_name = null, prefetched_info = null, paused = false) => {
    const normalized_options = options && typeof options === 'object' ? options : {};
    const playlist_chunk_size = getConfiguredPlaylistChunkSize();
    const should_mark_playlist_exclusive = shouldMarkPlaylistAsExclusive(url, normalized_options);
    const playlist_batch_id = should_mark_playlist_exclusive
        ? String(normalized_options.playlistBatchId || normalized_options.ui_uid || uuid())
        : null;
    const normalized_options_with_playlist_policy = should_mark_playlist_exclusive
        ? {
            ...normalized_options,
            playlistExclusive: true,
            playlistBatchId: playlist_batch_id
        }
        : normalized_options;

    if (!shouldAutoChunkPlaylist(url, normalized_options)) {
        const download = await exports.createDownload(url, type, normalized_options_with_playlist_policy, user_uid, sub_id, sub_name, prefetched_info, paused);
        return download ? [download] : [];
    }

    const playlist_metadata = await getPlaylistChunkingMetadata(url, normalized_options);
    if (!playlist_metadata || playlist_metadata.entry_count <= playlist_chunk_size) {
        const prefilled_title = playlist_metadata ? formatChunkedPlaylistTitle(playlist_metadata.title || 'Playlist') : null;
        const download = await exports.createDownload(url, type, normalized_options_with_playlist_policy, user_uid, sub_id, sub_name, prefetched_info, paused, prefilled_title);
        return download ? [download] : [];
    }

    const chunk_ranges = buildPlaylistChunkRanges(playlist_metadata.entry_count, playlist_chunk_size);
    if (chunk_ranges.length <= 1) {
        const download = await exports.createDownload(url, type, normalized_options, user_uid, sub_id, sub_name, prefetched_info, paused);
        return download ? [download] : [];
    }

    logger.info(`Auto-chunking playlist download for URL '${url}' into ${chunk_ranges.length} chunks (${playlist_metadata.entry_count} items).`);

    const created_downloads = [];
    for (let i = 0; i < chunk_ranges.length; i++) {
        const chunk_range = chunk_ranges[i];
        const chunk_title = formatChunkedPlaylistTitle(playlist_metadata.title || 'Playlist', chunk_range.label, i + 1, chunk_ranges.length);
        const chunk_options = {
            ...normalized_options_with_playlist_policy,
            additionalArgs: appendAdditionalArgs(normalized_options_with_playlist_policy.additionalArgs, ['--playlist-items', chunk_range.label]),
            playlistChunkRange: chunk_range.label,
            playlistChunkIndex: i + 1,
            playlistChunkCount: chunk_ranges.length,
            playlistChunkTitle: playlist_metadata.title || null
        };
        const chunk_download = await exports.createDownload(url, type, chunk_options, user_uid, sub_id, sub_name, prefetched_info, paused, chunk_title);
        if (chunk_download) created_downloads.push(chunk_download);
    }

    return created_downloads;
}

exports.pauseDownload = async (download_uid) => {
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    if (download['paused']) {
        logger.warn(`Download ${download_uid} is already paused!`);
        return false;
    } else if (download['finished']) {
        logger.info(`Download ${download_uid} could not be paused before completing.`);
        return false;
    } else {
        logger.info(`Pausing download ${download_uid}`);
    }

    killActiveDownload(download);
    return await db_api.updateRecord('download_queue', {uid: download_uid}, {paused: true, running: false});
}

exports.resumeDownload = async (download_uid) => {
    return await mutex.runExclusive(async () => {
        const download = await db_api.getRecord('download_queue', {uid: download_uid});
        if (!download['paused']) {
            logger.warn(`Download ${download_uid} is not paused!`);
            return false;
        }

        const success = db_api.updateRecord('download_queue', {uid: download_uid}, {paused: false});
        should_check_downloads = true;
        return success;
    })
}

exports.restartDownload = async (download_uid) => {
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    await exports.clearDownload(download_uid);
    const new_download = await exports.createDownload(download['url'], download['type'], download['options'], download['user_uid']);
    
    should_check_downloads = true;
    return new_download;
}

exports.cancelDownload = async (download_uid) => {
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    if (download['cancelled']) {
        logger.warn(`Download ${download_uid} is already cancelled!`);
        return false;
    } else if (download['finished']) {
        logger.info(`Download ${download_uid} could not be cancelled before completing.`);
        return false;
    } else {
        logger.info(`Cancelling download ${download_uid}`);
    }

    killActiveDownload(download);
    await handleDownloadError(download_uid, 'Cancelled', 'cancelled');
    return await db_api.updateRecord('download_queue', {uid: download_uid}, {cancelled: true});
}

exports.clearDownload = async (download_uid) => {
    return await db_api.removeRecord('download_queue', {uid: download_uid});
}

async function handleDownloadError(download_uid, error_message, error_type = null) {
    if (!download_uid) return;
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    if (!download || download['error']) return;
    notifications_api.sendDownloadErrorNotification(download, download['user_uid'], error_message, error_type);
    await db_api.updateRecord('download_queue', {uid: download['uid']}, {error: error_message, finished: true, running: false, error_type: error_type});
}

exports.setupDownloads = async () => {
    await fixDownloadState();
    setInterval(checkDownloads, 1000);
}

async function fixDownloadState() {
    const downloads = await db_api.getRecords('download_queue');
    downloads.sort((download1, download2) => download1.timestamp_start - download2.timestamp_start);
    const running_downloads = downloads.filter(download => !download['finished'] && !download['error']);
    for (let i = 0; i < running_downloads.length; i++) {
        const running_download = running_downloads[i];
        const update_obj = {finished_step: true, paused: true, running: false};
        if (running_download['step_index'] > 0) {
            update_obj['step_index'] = running_download['step_index'] - 1;
        }
        await db_api.updateRecord('download_queue', {uid: running_download['uid']}, update_obj);
    }
}

async function checkDownloads() {
    if (!should_check_downloads) return;

    const downloads = await db_api.getRecords('download_queue', {finished: false});
    downloads.sort((download1, download2) => download1.timestamp_start - download2.timestamp_start);

    await mutex.runExclusive(async () => {
        // avoid checking downloads unnecessarily, but double check that should_check_downloads is still true
        const running_downloads = downloads.filter(download => !download['paused'] && !download['finished']);
        if (running_downloads.length === 0) {
            should_check_downloads = false;
            logger.verbose('Disabling checking downloads as none are available.');
        }
        return;
    });

    let running_downloads_count = downloads.filter(download => download['running']).length;
    const waiting_downloads = downloads.filter(download => !download['paused'] && download['finished_step'] && !download['finished']);
    const running_downloads = downloads.filter(download => download['running']);

    const running_exclusive_downloads = running_downloads
        .filter(download => isExclusivePlaylistDownload(download))
        .sort((download1, download2) => download1.timestamp_start - download2.timestamp_start);
    const waiting_exclusive_downloads = waiting_downloads
        .filter(download => isExclusivePlaylistDownload(download))
        .sort((download1, download2) => download1.timestamp_start - download2.timestamp_start);

    let exclusive_playlist_group_key = null;
    if (running_exclusive_downloads.length > 0) {
        exclusive_playlist_group_key = getExclusivePlaylistGroupKey(running_exclusive_downloads[0]);
    } else if (waiting_exclusive_downloads.length > 0) {
        exclusive_playlist_group_key = getExclusivePlaylistGroupKey(waiting_exclusive_downloads[0]);
    }

    for (let i = 0; i < waiting_downloads.length; i++) {
        const waiting_download = waiting_downloads[i];
        const waiting_download_is_exclusive = isExclusivePlaylistDownload(waiting_download);
        const waiting_download_group_key = waiting_download_is_exclusive ? getExclusivePlaylistGroupKey(waiting_download) : null;

        if (exclusive_playlist_group_key) {
            if (!waiting_download_is_exclusive || waiting_download_group_key !== exclusive_playlist_group_key) {
                continue;
            }

            const has_running_download_outside_group = running_downloads.some(download => {
                if (!download['running']) return false;
                if (!isExclusivePlaylistDownload(download)) return true;
                return getExclusivePlaylistGroupKey(download) !== exclusive_playlist_group_key;
            });
            if (has_running_download_outside_group) {
                continue;
            }

            const has_running_download_inside_group = running_downloads.some(download => {
                if (!download['running']) return false;
                if (!isExclusivePlaylistDownload(download)) return false;
                return getExclusivePlaylistGroupKey(download) === exclusive_playlist_group_key;
            });
            if (has_running_download_inside_group) {
                continue;
            }
        } else {
            const max_concurrent_downloads = config_api.getConfigItem('ytdl_max_concurrent_downloads');
            if (hasReachedConcurrentDownloadLimit(max_concurrent_downloads, running_downloads_count)) break;
        }

        if (waiting_download['finished_step'] && !waiting_download['finished']) {
            if (waiting_download['sub_id']) {
                const sub_missing = !(await db_api.getRecord('subscriptions', {id: waiting_download['sub_id']}));
                if (sub_missing) {
                    handleDownloadError(waiting_download['uid'], `Download failed as subscription with id '${waiting_download['sub_id']}' is missing!`, 'sub_id_missing');
                    continue;
                }
            }
            // move to next step
            running_downloads_count++;
            if (waiting_download['step_index'] === 0) {
                exports.collectInfo(waiting_download['uid']);
            } else if (waiting_download['step_index'] === 1) {
                exports.downloadQueuedFile(waiting_download['uid']);
            }

            if (exclusive_playlist_group_key) {
                // Playlist/chunk downloads run in exclusive mode, one at a time.
                break;
            }
        }
    }
}
exports.checkDownloads = checkDownloads;

function killActiveDownload(download) {
    const child_process = download_to_child_process[download['uid']];
    if (download['step_index'] === 2 && child_process) {
        youtubedl_api.killYoutubeDLProcess(child_process);
        delete download_to_child_process[download['uid']];
    }
}

exports.collectInfo = async (download_uid) => {
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    if (download['paused']) {
        return;
    }
    logger.verbose(`Collecting info for download ${download_uid}`);
    await db_api.updateRecord('download_queue', {uid: download_uid}, {step_index: 1, finished_step: false, running: true});

    const url = download['url'];
    const type = download['type'];
    const options = download['options'];

    if (download['user_uid'] && !options.customFileFolderPath) {
        let usersFileFolder = config_api.getConfigItem('ytdl_users_base_path');
        const user_path = path.join(usersFileFolder, download['user_uid'], type);
        options.customFileFolderPath = user_path + path.sep;
    }

    let args = await exports.generateArgs(url, type, options, download['user_uid']);

    // get video info prior to download
    let info = download['prefetched_info'] ? download['prefetched_info'] : await exports.getVideoInfoByURL(url, args, download_uid);

    if (!info || info.length === 0) {
        // info failed, error presumably already recorded
        return;
    }

    info = info.filter(info_obj => info_obj && info_obj['_filename']);
    if (info.length === 0) {
        const error_message = `No downloadable items were found while retrieving info for URL ${url}`;
        logger.error(error_message);
        if (download_uid) {
            await handleDownloadError(download_uid, error_message, 'info_retrieve_failed');
        }
        return;
    }

    // in subscriptions we don't care if archive mode is enabled, but we already removed archived videos from subs by this point
    const useYoutubeDLArchive = config_api.getConfigItem('ytdl_use_youtubedl_archive');
    if (useYoutubeDLArchive && !options.ignoreArchive && info.length === 1) {
        const info_obj = info[0];
        const exists_in_archive = await archive_api.existsInArchive(info['extractor'], info_obj['id'], type, download['user_uid'], download['sub_id']);
        if (exists_in_archive) {
            const error = `File '${info_obj['title']}' already exists in archive! Disable the archive or override to continue downloading.`;
            logger.warn(error);
            if (download_uid) {
                await handleDownloadError(download_uid, error, 'exists_in_archive');
                return;
            }
        }
    }

    let category = null;

    // check if it fits into a category. If so, then get info again using new args
    if (info.length === 1 || config_api.getConfigItem('ytdl_allow_playlist_categorization')) category = await categories_api.categorize(info);

    // set custom output if the category has one and re-retrieve info so the download manager has the right file name
    if (category && category['custom_output']) {
        options.customOutput = category['custom_output'];
        options.noRelativePath = true;
        args = await exports.generateArgs(url, type, options, download['user_uid']);
        info = await exports.getVideoInfoByURL(url, args, download_uid);
    }

    const stripped_category = category ? {name: category['name'], uid: category['uid']} : null;

    // setup info required to calculate download progress

    const expected_file_size = utils.getExpectedFileSize(info);

    const files_to_check_for_progress = [];

    // store info in download for future use
    for (let info_obj of info) files_to_check_for_progress.push(utils.removeFileExtension(info_obj['_filename']));

    const base_title = info.length > 1 ? info[0]['playlist_title'] || info[0]['playlist'] : info[0]['title'];
    const chunk_range_label = options && options.playlistChunkRange ? options.playlistChunkRange : null;
    const chunk_index = options && options.playlistChunkIndex ? options.playlistChunkIndex : null;
    const chunk_count = options && options.playlistChunkCount ? options.playlistChunkCount : null;
    const title = formatChunkedPlaylistTitle(base_title, chunk_range_label, chunk_index, chunk_count);
    const playlist_item_progress = buildPlaylistItemProgress(info);

    await db_api.updateRecord('download_queue', {uid: download_uid}, {args: args,
                                                                    finished_step: true,
                                                                    running: false,
                                                                    options: options,
                                                                    files_to_check_for_progress: files_to_check_for_progress,
                                                                    expected_file_size: expected_file_size,
                                                                    title: title,
                                                                    playlist_item_progress: playlist_item_progress,
                                                                    category: stripped_category,
                                                                    prefetched_info: null
                                                                });
}

exports.downloadQueuedFile = async(download_uid, customDownloadHandler = null) => {
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    if (download['paused']) {
        return;
    }
    logger.verbose(`Downloading ${download_uid}`);
    return new Promise(async resolve => {
        const audioFolderPath = config_api.getConfigItem('ytdl_audio_folder_path');
        const videoFolderPath = config_api.getConfigItem('ytdl_video_folder_path');
        const usersFolderPath = config_api.getConfigItem('ytdl_users_base_path');
        await db_api.updateRecord('download_queue', {uid: download_uid}, {step_index: 2, finished_step: false, running: true});

        const url = download['url'];
        const type = download['type'];
        const options = download['options'];
        const args = download['args'];
        const category = download['category'];
        let fileFolderPath = type === 'audio' ? audioFolderPath : videoFolderPath;
        if (options.customFileFolderPath) {
            fileFolderPath = options.customFileFolderPath;
        } else if (download['user_uid']) {
            fileFolderPath = path.join(usersFolderPath, download['user_uid'], type);
        }
        fs.ensureDirSync(fileFolderPath);

        const start_time = Date.now();

        const download_checker = setInterval(() => checkDownloadPercent(download['uid']), 1000);
        const file_objs = [];
        // download file
        let {child_process, callback} = await youtubedl_api.runYoutubeDL(url, args, customDownloadHandler);
        if (child_process) download_to_child_process[download['uid']] = child_process;
        const {parsed_output, err} = await callback;
        clearInterval(download_checker);
        let end_time = Date.now();
        let difference = (end_time - start_time)/1000;
        logger.debug(`${type === 'audio' ? 'Audio' : 'Video'} download delay: ${difference} seconds.`);
        if (!parsed_output) {
            const errored_download = await db_api.getRecord('download_queue', {uid: download_uid});
            if (errored_download && errored_download['paused']) return;
            logger.error(err.toString());
            await handleDownloadError(download_uid, err.toString(), 'unknown_error');
            resolve(false);
            return;
        } else if (parsed_output) {
            if (parsed_output.length === 0 || parsed_output[0].length === 0) {
                // ERROR!
                const error_message = `No output received for video download, check if it exists in your archive.`;
                await handleDownloadError(download_uid, error_message, 'no_output');
                logger.warn(error_message);
                resolve(false);
                return;
            }

            for (const output_json of parsed_output) {
                if (!output_json) {
                    continue;
                }
                if (!output_json['_filename']) {
                    logger.warn(`Skipping output item without _filename for download '${download_uid}'.`);
                    continue;
                }

                // get filepath with no extension
                const filepath_no_extension = utils.removeFileExtension(output_json['_filename']);

                const ext = type === 'audio' ? '.mp3' : '.mp4';
                var full_file_path = filepath_no_extension + ext;
                var file_name = filepath_no_extension.substring(fileFolderPath.length, filepath_no_extension.length);

                if (type === 'video' && url.includes('twitch.tv/videos/') && url.split('twitch.tv/videos/').length > 1
                    && config_api.getConfigItem('ytdl_twitch_auto_download_chat')) {
                        let vodId = url.split('twitch.tv/videos/')[1];
                        vodId = vodId.split('?')[0];
                        twitch_api.downloadTwitchChatByVODID(vodId, file_name, type, download['user_uid']);
                }

                // renames file if necessary due to bug
                if (!fs.existsSync(output_json['_filename']) && fs.existsSync(output_json['_filename'] + '.webm')) {
                    try {
                        fs.renameSync(output_json['_filename'] + '.webm', output_json['_filename']);
                        logger.info('Renamed ' + file_name + '.webm to ' + file_name);
                    } catch(e) {
                        logger.error(`Failed to rename file ${output_json['_filename']} to its appropriate extension.`);
                    }
                }

                if (type === 'audio') {
                    let tags = {
                        title: output_json['title'],
                        artist: output_json['artist'] ? output_json['artist'] : output_json['uploader']
                    }
                    let success = NodeID3.write(tags, utils.removeFileExtension(output_json['_filename']) + '.mp3');
                    if (!success) logger.error('Failed to apply ID3 tag to audio file ' + output_json['_filename']);
                }

                if (config_api.getConfigItem('ytdl_generate_nfo_files')) {
                    exports.generateNFOFile(output_json, `${filepath_no_extension}.nfo`);
                }

                if (options.cropFileSettings) {
                    await utils.cropFile(full_file_path, options.cropFileSettings.cropFileStart, options.cropFileSettings.cropFileEnd, ext);
                }

                // registers file in DB
                const file_obj = await files_api.registerFileDB(full_file_path, type, download['user_uid'], category, download['sub_id'] ? download['sub_id'] : null, options.cropFileSettings);
                if (!file_obj) {
                    logger.warn(`Failed to register downloaded file '${full_file_path}' in DB.`);
                    continue;
                }

                await archive_api.addToArchive(output_json['extractor'], output_json['id'], type, output_json['title'], download['user_uid'], download['sub_id']);

                notifications_api.sendDownloadNotification(file_obj, download['user_uid']);

                file_objs.push(file_obj);
            }

            let container = null;
            const is_chunked_playlist_batch_download = !!(options && options.playlistBatchId && options.playlistChunkRange);

            if (file_objs.length > 1) {
                if (!is_chunked_playlist_batch_download) {
                    // create playlist
                    container = await files_api.createPlaylist(download['title'], file_objs.map(file_obj => file_obj.uid), download['user_uid']);
                }
            } else if (file_objs.length === 1) {
                container = file_objs[0];
            } else {
                const error_message = 'Downloaded file failed to result in metadata object.';
                logger.error(error_message);
                await handleDownloadError(download_uid, error_message, 'no_metadata');
            }

            const file_uids = file_objs.map(file_obj => file_obj.uid);
            const latest_download = await db_api.getRecord('download_queue', {uid: download_uid});
            const playlist_item_progress = finalizePlaylistItemProgress(latest_download ? latest_download['playlist_item_progress'] : null, parsed_output);
            await db_api.updateRecord('download_queue', {uid: download_uid}, {finished_step: true, finished: true, running: false, step_index: 3, percent_complete: 100, playlist_item_progress: playlist_item_progress, file_uids: file_uids, container: container});
            await finalizePlaylistBatchContainer(download_uid);
            resolve(file_uids);
        }
    });
}

// helper functions

exports.generateArgs = async (url, type, options, user_uid = null, simulated = false) => {
    const default_downloader = config_api.getConfigItem('ytdl_default_downloader');

    if (!simulated && (default_downloader === 'youtube-dl' || default_downloader === 'youtube-dlc')) {
        logger.warn('It is recommended you use yt-dlp! To prevent failed downloads, change the downloader in your settings menu to yt-dlp and restart your instance.')
    }

    const audioFolderPath = config_api.getConfigItem('ytdl_audio_folder_path');
    const videoFolderPath = config_api.getConfigItem('ytdl_video_folder_path');
    const usersFolderPath = config_api.getConfigItem('ytdl_users_base_path');

    const videopath = config_api.getConfigItem('ytdl_default_file_output') ? config_api.getConfigItem('ytdl_default_file_output') : '%(title)s';
    const globalArgs = config_api.getConfigItem('ytdl_custom_args');
    const useCookies = config_api.getConfigItem('ytdl_use_cookies');
    const is_audio = type === 'audio';

    let fileFolderPath = type === 'audio' ? audioFolderPath : videoFolderPath; // TODO: fix
    if (options.customFileFolderPath) {
        fileFolderPath = options.customFileFolderPath;
    } else if (user_uid) {
        fileFolderPath = path.join(usersFolderPath, user_uid, fileFolderPath);
    }

    if (options.customFileFolderPath) fileFolderPath = options.customFileFolderPath;

    const customArgs = options.customArgs;
    let customOutput = options.customOutput;
    const customQualityConfiguration = options.customQualityConfiguration;

    // video-specific args
    const selectedHeight = options.selectedHeight;
    const maxHeight = options.maxHeight;
    const heightParam = selectedHeight || maxHeight;

    // audio-specific args
    const maxBitrate = options.maxBitrate;

    const youtubeUsername = options.youtubeUsername;
    const youtubePassword = options.youtubePassword;

    let downloadConfig = null;
    let qualityPath = (is_audio && !options.skip_audio_args) ? ['-f', 'bestaudio'] : ['-f', 'bestvideo+bestaudio', '--merge-output-format', 'mp4'];
    const is_youtube = url.includes('youtu');
    if (!is_audio && !is_youtube) {
        // tiktok videos fail when using the default format
        qualityPath = null;
    }

    if (customArgs) {
        downloadConfig = customArgs.split(',,');
    } else {
        if (customQualityConfiguration) {
            qualityPath = ['-f', customQualityConfiguration, '--merge-output-format', 'mp4'];
        } else if (heightParam && heightParam !== '' && !is_audio) {
            const heightFilter = (maxHeight && default_downloader === 'yt-dlp') ? ['-S', `res:${heightParam}`] : ['-f', `best[height${maxHeight ? '<' : ''}=${heightParam}]+bestaudio`]
            qualityPath = [...heightFilter, '--merge-output-format', 'mp4'];
        } else if (is_audio) {
            qualityPath = ['--audio-quality', maxBitrate ? maxBitrate : '0']
        }

        if (customOutput) {
            customOutput = options.noRelativePath ? customOutput : path.join(fileFolderPath, customOutput);
            downloadConfig = ['-o', `${customOutput}.%(ext)s`, '--write-info-json', '--print-json'];
        } else {
            downloadConfig = ['-o', path.join(fileFolderPath, videopath + (is_audio ? '.%(ext)s' : '.mp4')), '--write-info-json', '--print-json'];
        }

        if (qualityPath) downloadConfig.push(...qualityPath);

        if (is_audio && !options.skip_audio_args) {
            downloadConfig.push('-x');
            downloadConfig.push('--audio-format', 'mp3');
        }

        if (youtubeUsername && youtubePassword) {
            downloadConfig.push('--username', youtubeUsername, '--password', youtubePassword);
        }

        if (useCookies) {
            if (await fs.pathExists(path.join(__dirname, 'appdata', 'cookies.txt'))) {
                downloadConfig.push('--cookies', path.join('appdata', 'cookies.txt'));
            } else {
                logger.warn('Cookies file could not be found. You can either upload one, or disable \'use cookies\' in the Advanced tab in the settings.');
            }
        }

        const useDefaultDownloadingAgent = config_api.getConfigItem('ytdl_use_default_downloading_agent');
        const customDownloadingAgent = config_api.getConfigItem('ytdl_custom_downloading_agent');
        if (!useDefaultDownloadingAgent && customDownloadingAgent) {
            downloadConfig.splice(0, 0, '--external-downloader', customDownloadingAgent);
        }

        if (config_api.getConfigItem('ytdl_include_thumbnail')) {
            downloadConfig.push('--write-thumbnail');
        }

        if (globalArgs && globalArgs !== '') {
            // adds global args
            if (downloadConfig.indexOf('-o') !== -1 && globalArgs.split(',,').indexOf('-o') !== -1) {
                // if global args has an output, replce the original output with that of global args
                const original_output_index = downloadConfig.indexOf('-o');
                downloadConfig.splice(original_output_index, 2);
            }
            downloadConfig = downloadConfig.concat(globalArgs.split(',,'));
        }

        if (options.additionalArgs && options.additionalArgs !== '') {
            downloadConfig = utils.injectArgs(downloadConfig, options.additionalArgs.split(',,'));
        }

        const sponsorBlockEnabled = config_api.getConfigItem('ytdl_use_sponsorblock_api');
        if (default_downloader === 'yt-dlp' && sponsorBlockEnabled) {
            if (options.disableSponsorBlock) {
                // Explicit per-download opt-out from UI.
                downloadConfig = stripArgsWithValues(downloadConfig, ['--sponsorblock-remove', '--sponsorblock-mark', '--sponsorblock-api']);
            } else {
                const hasSponsorBlockArgs = downloadConfig.some(arg => typeof arg === 'string' && arg.startsWith('--sponsorblock-'));
                if (!hasSponsorBlockArgs) {
                    // Mirror the existing "skip ads" SponsorBlock setting for downloads.
                    downloadConfig.push('--sponsorblock-remove', 'sponsor');
                }
            }
        }

        const rate_limit = config_api.getConfigItem('ytdl_download_rate_limit');
        if (rate_limit && downloadConfig.indexOf('-r') === -1 && downloadConfig.indexOf('--limit-rate') === -1) {
            downloadConfig.push('-r', rate_limit);
        }
        
        if (default_downloader === 'yt-dlp') {
            downloadConfig = utils.filterArgs(downloadConfig, ['--print-json']);

            // in yt-dlp -j --no-simulate is preferable
            downloadConfig.push('--no-clean-info-json', '-j', '--no-simulate');

            // Note: yt-dlp-ejs is installed via pip and will be automatically detected
            // No --remote-components flag needed (would conflict with Deno's --no-remote flag)
        }

    }

    // filter out incompatible args
    downloadConfig = filterArgs(downloadConfig, is_audio);

    if (!simulated) logger.verbose(`${default_downloader} args being used (${downloadConfig.length} args)`);
    return downloadConfig;
}

function filterInfoLookupArgs(args = []) {
    if (!Array.isArray(args)) return [];

    // Keep selection/output/auth args so predicted filename and size match the real download,
    // but remove flags that write files or trigger an actual download during info lookup.
    const args_to_remove = new Set([
        '--write-info-json',
        '--write-thumbnail',
        '--write-all-thumbnails',
        '--write-description',
        '--write-comments',
        '--write-annotations',
        '--write-subs',
        '--write-auto-subs',
        '--all-subs',
        '--print-json',
        '-j',
        '--dump-json',
        '-J',
        '--dump-single-json',
        '--no-clean-info-json',
        '--no-simulate',
        '--force-write-archive'
    ]);
    const args_with_values_to_remove = new Set([
        '--download-archive',
        '--exec',
        '--exec-before-download',
        '--print'
    ]);

    const filtered_args = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (args_to_remove.has(arg)) continue;

        if (arg === '--print-to-file') {
            // --print-to-file takes a template and destination path.
            i += 2;
            continue;
        }

        if (args_with_values_to_remove.has(arg)) {
            i++;
            continue;
        }

        if (typeof arg === 'string' && arg.startsWith('--print=')) continue;

        filtered_args.push(arg);
    }

    return filtered_args;
}

exports.getVideoInfoByURL = async (url, args = [], download_uid = null) => {
    logger.debug('getVideoInfoByURL called');

    // Preserve safe args (notably -o/-f/-S) so progress prediction uses the real
    // filename and selected formats, but strip flags that write files/download data.
    const new_args = filterInfoLookupArgs(args);
    if (url.includes('list=') && !new_args.includes('--ignore-errors')) {
        new_args.push('--ignore-errors');
    }
    new_args.push('--dump-json');

    // Only add cookies if they exist and args do not already provide them.
    if (new_args.indexOf('--cookies') === -1 && await fs.pathExists(path.join(__dirname, 'appdata', 'cookies.txt'))) {
        new_args.push('--cookies', path.join('appdata', 'cookies.txt'));
    }

    // Note: yt-dlp-ejs is installed via pip and will be automatically detected
    // No --remote-components flag needed (would conflict with Deno's --no-remote flag)

    logger.debug(`About to call runYoutubeDL with args: ${utils.redactCommandArgsForLogging(new_args).join(' ')}`);
    let {callback} = await youtubedl_api.runYoutubeDL(url, new_args);
    logger.debug('runYoutubeDL returned, now waiting for callback');
    const {parsed_output, err} = await callback;
    logger.debug(`Callback resolved. parsed_output length: ${parsed_output ? parsed_output.length : 'null'}`);
    if (!parsed_output || parsed_output.length === 0) {
        let error_message = `Error while retrieving info on video with URL ${url} with the following message: ${err}`;
        if (err.stderr) error_message += `\n\n${err.stderr}`;
        logger.error(error_message);
        if (download_uid) {
            await handleDownloadError(download_uid, error_message, 'info_retrieve_failed');
        }
        return null;
    }

    logger.debug(`getVideoInfoByURL returning successfully for URL: ${url}`);
    return parsed_output;
}

function filterArgs(args, isAudio) {
    const video_only_args = ['--add-metadata', '--embed-subs', '--xattrs'];
    const audio_only_args = ['-x', '--extract-audio', '--embed-thumbnail'];
    return utils.filterArgs(args, isAudio ? video_only_args : audio_only_args);
}

function stripArgsWithValues(args = [], args_to_strip = []) {
    const cleaned_args = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (args_to_strip.includes(arg)) {
            i++;
            continue;
        }
        if (typeof arg === 'string' && args_to_strip.some(flag => arg.startsWith(`${flag}=`))) {
            continue;
        }
        cleaned_args.push(arg);
    }
    return cleaned_args;
}

async function checkDownloadPercent(download_uid) {
    /*
    This is more of an art than a science, we're just selecting files that start with the file name,
    thus capturing the parts being downloaded in files named like so: '<video title>.<format>.<ext>.part'.

    Any file that starts with <video title> will be counted as part of the "bytes downloaded", which will
    be divided by the "total expected bytes."
    */

    if (active_progress_checks.has(download_uid)) return;
    active_progress_checks.add(download_uid);

    try {
        const download = await db_api.getRecord('download_queue', {uid: download_uid});
        if (!download || download['finished']) return;

        const files_to_check_for_progress = download['files_to_check_for_progress'];
        const resulting_file_size = download['expected_file_size'];

        if (!resulting_file_size || !files_to_check_for_progress || files_to_check_for_progress.length === 0) return;

        let sum_size = 0;
        const basenames_by_directory = new Map();
        for (let i = 0; i < files_to_check_for_progress.length; i++) {
            const file_to_check_for_progress = files_to_check_for_progress[i];
            const dir = path.dirname(file_to_check_for_progress);
            const file_basename = path.basename(file_to_check_for_progress);

            if (!basenames_by_directory.has(dir)) {
                basenames_by_directory.set(dir, new Set());
            }
            basenames_by_directory.get(dir).add(file_basename);
        }

        const basename_sizes = new Map();
        for (const [dir, file_basenames] of basenames_by_directory.entries()) {
            if (!fs.existsSync(dir)) continue;
            const file_basename_list = [...file_basenames];

            let dir_entries = [];
            try {
                dir_entries = await fs.readdir(dir, {withFileTypes: true});
            } catch (e) {
                continue;
            }

            for (let i = 0; i < dir_entries.length; i++) {
                const dir_entry = dir_entries[i];
                if (!dir_entry || typeof dir_entry.isDirectory !== 'function' || dir_entry.isDirectory()) continue;

                const entry_name = dir_entry.name;
                const matched_basenames = file_basename_list.filter(file_basename => entry_name.includes(file_basename));
                if (matched_basenames.length === 0) continue;

                const matching_file_path = path.join(dir, entry_name);
                const file_stats = await (async () => {
                    try {
                        return await fs.stat(matching_file_path);
                    } catch (e) {
                        return null;
                    }
                })();

                if (!file_stats || !file_stats.size) continue;
                sum_size += file_stats.size;

                for (let j = 0; j < matched_basenames.length; j++) {
                    const matched_basename = matched_basenames[j];
                    const basename_key = `${dir}\u0000${matched_basename}`;
                    const existing_size = basename_sizes.get(basename_key) || 0;
                    basename_sizes.set(basename_key, existing_size + file_stats.size);
                }
            }
        }

        let computed_percent = (sum_size / resulting_file_size) * 100;
        if (!Number.isFinite(computed_percent)) return;

        // Keep in-progress estimates stable and reserve 100% for the final completion write.
        computed_percent = Math.min(99.99, Math.max(0, computed_percent));

        const latest_download = await db_api.getRecord('download_queue', {uid: download_uid});
        if (!latest_download || latest_download['finished']) return;

        const current_percent = Number(latest_download['percent_complete']);
        const monotonic_percent = Math.max(Number.isFinite(current_percent) ? current_percent : 0, computed_percent);
        const percent_complete = monotonic_percent.toFixed(2);

        let playlist_item_progress = null;
        if (Array.isArray(latest_download['playlist_item_progress']) && latest_download['playlist_item_progress'].length > 1) {
            playlist_item_progress = latest_download['playlist_item_progress'].map(item => {
                if (!item || item['progress_path_index'] === undefined || item['progress_path_index'] === null) {
                    return item;
                }

                const progress_path_index = asFiniteNumber(item['progress_path_index'], -1);
                const file_path = files_to_check_for_progress[progress_path_index];
                if (!file_path) return item;

                const basename_key = `${path.dirname(file_path)}\u0000${path.basename(file_path)}`;
                const observed_downloaded_size = asFiniteNumber(basename_sizes.get(basename_key), 0);
                const previous_downloaded_size = asFiniteNumber(item['downloaded_size'], 0);
                const downloaded_size = Math.max(previous_downloaded_size, observed_downloaded_size);

                const expected_file_size = asFiniteNumber(item['expected_file_size'], 0);
                let calculated_item_percent = expected_file_size > 0 ? (downloaded_size / expected_file_size) * 100 : 0;
                calculated_item_percent = Math.min(100, Math.max(0, calculated_item_percent));

                const previous_item_percent = asFiniteNumber(item['percent_complete'], 0);
                const item_percent_complete = Math.max(previous_item_percent, calculated_item_percent);

                let status = item['status'] || 'pending';
                if (item_percent_complete >= 99.99) status = 'complete';
                else if (downloaded_size > 0 && status !== 'complete') status = 'downloading';
                else if (status !== 'complete') status = 'pending';

                return {
                    ...item,
                    downloaded_size: downloaded_size,
                    percent_complete: Number(item_percent_complete.toFixed(2)),
                    status: status
                };
            });
        }

        const update_obj = {percent_complete: percent_complete};
        if (playlist_item_progress) {
            update_obj['playlist_item_progress'] = playlist_item_progress;
        }

        // Avoid overwriting the final 100% once the completion update marks the download finished.
        await db_api.updateRecord('download_queue', {uid: download_uid, finished: false}, update_obj);
    } finally {
        active_progress_checks.delete(download_uid);
    }
}

exports.generateNFOFile = (info, output_path) => {
    const nfo_obj = {
        episodedetails: {
            title: info['fulltitle'],
            episode: info['playlist_index'] ? info['playlist_index'] : undefined,
            premiered: utils.formatDateString(info['upload_date']),
            plot: `${info['uploader_url']}\n${info['description']}\n${info['playlist_title'] ? info['playlist_title'] : ''}`,
            director: info['artist'] ? info['artist'] : info['uploader']
        }
    };
    const doc = create(nfo_obj);
    const xml = doc.end({ prettyPrint: true });
    fs.writeFileSync(output_path, xml);
}
