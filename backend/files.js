const fs = require('fs-extra')
const path = require('path')
const { v4: uuid } = require('uuid');

const config_api = require('./config');
const db_api = require('./db');
const archive_api = require('./archive');
const utils = require('./utils')
const logger = require('./logger');
const PLAYLIST_FILE_DELETE_BATCH_SIZE = 10;

function shouldRestrictToUser(user_uid) {
    return config_api.getConfigItem('ytdl_multi_user_mode') && user_uid !== null && user_uid !== undefined;
}

function escapeRegex(text = '') {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeChapter(raw_chapter) {
    if (!raw_chapter || typeof raw_chapter !== 'object') return null;

    const start_time = Number(raw_chapter.start_time);
    const end_time = Number(raw_chapter.end_time);
    const title = typeof raw_chapter.title === 'string' ? raw_chapter.title.trim() : '';

    if (!Number.isFinite(start_time) || start_time < 0) return null;
    if (!Number.isFinite(end_time) || end_time <= start_time) return null;
    if (!title) return null;

    return {
        title,
        start_time,
        end_time
    };
}

function getChaptersForFile(file_obj) {
    if (!file_obj || !file_obj.path) return [];

    const type = file_obj.isAudio ? 'audio' : 'video';
    const metadata_json = utils.getJSON(file_obj.path, type);
    if (!metadata_json || !Array.isArray(metadata_json.chapters)) return [];

    return metadata_json.chapters.map(normalizeChapter).filter(Boolean);
}

exports.attachFileChapters = (file_obj = null) => {
    if (!file_obj) return file_obj;
    return {
        ...file_obj,
        chapters: getChaptersForFile(file_obj)
    };
}

exports.attachFileChaptersCollection = (file_objs = []) => {
    if (!Array.isArray(file_objs)) return [];
    return file_objs.map(file_obj => exports.attachFileChapters(file_obj));
}

function normalizeSourceValue(value = null) {
    if (value === null || value === undefined) return null;
    const normalized_value = String(value).trim();
    return normalized_value === '' ? null : normalized_value;
}

function buildDuplicateKey(source_extractor = null, source_id = null, is_audio = false) {
    const normalized_source_id = normalizeSourceValue(source_id);
    if (!normalized_source_id) return null;

    const normalized_source_extractor = normalizeSourceValue(source_extractor) || 'unknown';
    return `${normalized_source_extractor}:${normalized_source_id}:${is_audio ? 'audio' : 'video'}`;
}
exports.buildDuplicateKey = buildDuplicateKey;

function extractYouTubeIDFromUrl(raw_url = '') {
    if (typeof raw_url !== 'string' || raw_url.trim() === '') return null;

    try {
        const parsed_url = new URL(raw_url);
        const host = parsed_url.hostname.replace(/^www\./, '').toLowerCase();
        if (host === 'youtu.be') {
            const path_segment = parsed_url.pathname.replace(/^\/+/, '').split('/')[0];
            return normalizeSourceValue(path_segment);
        }

        const is_youtube_host = host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com';
        if (!is_youtube_host) return null;

        const watch_id = parsed_url.searchParams.get('v');
        if (watch_id) return normalizeSourceValue(watch_id);

        const path_parts = parsed_url.pathname.split('/').filter(Boolean);
        if ((path_parts[0] === 'shorts' || path_parts[0] === 'embed' || path_parts[0] === 'v' || path_parts[0] === 'vi') && path_parts[1]) {
            return normalizeSourceValue(path_parts[1]);
        }
    } catch (e) {
        return null;
    }

    return null;
}

function extractTwitchVideoIDFromUrl(raw_url = '') {
    if (typeof raw_url !== 'string' || raw_url.trim() === '') return null;

    try {
        const parsed_url = new URL(raw_url);
        const host = parsed_url.hostname.replace(/^www\./, '').toLowerCase();
        if (host !== 'twitch.tv' && host !== 'm.twitch.tv') return null;

        const path_parts = parsed_url.pathname.split('/').filter(Boolean);
        if (path_parts[0] === 'videos' && path_parts[1]) return normalizeSourceValue(path_parts[1]);
    } catch (e) {
        return null;
    }

    return null;
}

function extractSourceMetadataFromUrl(raw_url = '', type = 'video') {
    const normalized_url = typeof raw_url === 'string' ? raw_url.trim() : '';
    if (!normalized_url) return null;

    const youtube_id = extractYouTubeIDFromUrl(normalized_url);
    if (youtube_id) {
        const is_audio = type === 'audio';
        return {
            source_id: youtube_id,
            source_extractor: 'youtube',
            duplicate_key: buildDuplicateKey('youtube', youtube_id, is_audio)
        };
    }

    const twitch_video_id = extractTwitchVideoIDFromUrl(normalized_url);
    if (twitch_video_id) {
        const is_audio = type === 'audio';
        return {
            source_id: twitch_video_id,
            source_extractor: 'twitch',
            duplicate_key: buildDuplicateKey('twitch', twitch_video_id, is_audio)
        };
    }

    return null;
}
exports.extractSourceMetadataFromUrl = extractSourceMetadataFromUrl;

function extractSourceMetadataFromInfo(info_json = null, type = 'video') {
    if (!info_json || typeof info_json !== 'object') return null;

    const source_id = normalizeSourceValue(info_json['id']);
    const source_extractor = normalizeSourceValue(info_json['extractor_key'])
        || normalizeSourceValue(info_json['extractor']);
    const is_audio = type === 'audio';

    if (source_id) {
        return {
            source_id: source_id,
            source_extractor: source_extractor || 'unknown',
            duplicate_key: buildDuplicateKey(source_extractor || 'unknown', source_id, is_audio)
        };
    }

    return extractSourceMetadataFromUrl(info_json['webpage_url'], type);
}
exports.extractSourceMetadataFromInfo = extractSourceMetadataFromInfo;

function applySourceMetadataToFileObject(file_object = null, source_metadata = null, type = 'video') {
    if (!file_object) return file_object;
    file_object.source_metadata_checked = true;
    if (!source_metadata) return file_object;

    const normalized_metadata = {
        source_id: normalizeSourceValue(source_metadata.source_id),
        source_extractor: normalizeSourceValue(source_metadata.source_extractor),
        duplicate_key: normalizeSourceValue(source_metadata.duplicate_key)
    };
    if (!normalized_metadata.source_id) return file_object;

    const is_audio = type === 'audio' || file_object.isAudio === true;
    if (!normalized_metadata.duplicate_key) {
        normalized_metadata.duplicate_key = buildDuplicateKey(normalized_metadata.source_extractor, normalized_metadata.source_id, is_audio);
    }

    file_object.source_id = normalized_metadata.source_id;
    file_object.source_extractor = normalized_metadata.source_extractor || 'unknown';
    file_object.duplicate_key = normalized_metadata.duplicate_key;
    return file_object;
}

async function hydrateFileSourceMetadata(file_obj = null, persist = false) {
    if (!file_obj || typeof file_obj !== 'object') return file_obj;
    if (file_obj.source_metadata_checked && file_obj.duplicate_key && file_obj.source_id) return file_obj;

    const type = file_obj.isAudio ? 'audio' : 'video';
    const info_json = file_obj.path ? utils.getJSON(file_obj.path, type) : null;
    const source_metadata = extractSourceMetadataFromInfo(info_json, type) || extractSourceMetadataFromUrl(file_obj.url, type);
    if (!source_metadata) {
        file_obj.source_metadata_checked = true;
        if (persist && file_obj.uid) {
            await db_api.updateRecord('files', {uid: file_obj.uid}, {source_metadata_checked: true});
        }
        return file_obj;
    }

    const hydrated_file_obj = applySourceMetadataToFileObject(file_obj, source_metadata, type);
    if (persist && hydrated_file_obj && hydrated_file_obj.uid) {
        await db_api.updateRecord('files', {uid: hydrated_file_obj.uid}, {
            source_id: hydrated_file_obj.source_id,
            source_extractor: hydrated_file_obj.source_extractor,
            duplicate_key: hydrated_file_obj.duplicate_key,
            source_metadata_checked: true
        });
    }
    return hydrated_file_obj;
}
exports.hydrateFileSourceMetadata = hydrateFileSourceMetadata;

async function backfillMissingDuplicateMetadata(user_uid = null) {
    const filter_obj = {source_metadata_checked: null};
    if (shouldRestrictToUser(user_uid)) filter_obj['user_uid'] = user_uid;

    const files_missing_duplicate_metadata = await db_api.getRecords('files', filter_obj);
    for (const file_obj of files_missing_duplicate_metadata) {
        await hydrateFileSourceMetadata(file_obj, true);
    }
}

function groupDuplicateFiles(file_objs = []) {
    const duplicate_groups_by_key = new Map();

    for (const file_obj of file_objs) {
        if (!file_obj || !file_obj.duplicate_key) continue;
        if (!duplicate_groups_by_key.has(file_obj.duplicate_key)) {
            duplicate_groups_by_key.set(file_obj.duplicate_key, []);
        }
        duplicate_groups_by_key.get(file_obj.duplicate_key).push(file_obj);
    }

    return [...duplicate_groups_by_key.entries()]
        .map(([duplicate_key, duplicate_files]) => {
            const ordered_files = duplicate_files
                .filter(Boolean)
                .sort((file_obj_1, file_obj_2) => Number(file_obj_1.registered || 0) - Number(file_obj_2.registered || 0));
            if (ordered_files.length <= 1) return null;

            const kept_file = ordered_files[0];
            const duplicate_count = ordered_files.length - 1;
            const newest_file = ordered_files[ordered_files.length - 1];
            return {
                duplicate_key: duplicate_key,
                source_id: kept_file.source_id || null,
                source_extractor: kept_file.source_extractor || null,
                isAudio: !!kept_file.isAudio,
                duplicate_count: duplicate_count,
                total_count: ordered_files.length,
                kept_file: kept_file,
                duplicate_files: ordered_files,
                newest_registered: newest_file ? newest_file.registered || null : null
            };
        })
        .filter(Boolean)
        .sort((group_1, group_2) => Number(group_2.newest_registered || 0) - Number(group_1.newest_registered || 0));
}

exports.getDuplicateSummary = async (user_uid = null) => {
    await backfillMissingDuplicateMetadata(user_uid);

    const filter_obj = {duplicate_key: {$ne: null}};
    if (shouldRestrictToUser(user_uid)) filter_obj['user_uid'] = user_uid;

    if (db_api.isUsingLocalDB()) {
        const files = await db_api.getRecords('files', filter_obj);
        const duplicate_groups = groupDuplicateFiles(files);
        return {
            has_duplicates: duplicate_groups.length > 0,
            duplicate_group_count: duplicate_groups.length
        };
    }

    const pipeline = [
        {$match: filter_obj},
        {$group: {_id: '$duplicate_key', count: {$sum: 1}}},
        {$match: {count: {$gt: 1}}},
        {$count: 'duplicate_group_count'}
    ];
    const aggregate_result = await db_api.aggregateRecords('files', pipeline);
    const duplicate_group_count = Array.isArray(aggregate_result) && aggregate_result[0]
        ? Number(aggregate_result[0]['duplicate_group_count'] || 0)
        : 0;
    return {
        has_duplicates: duplicate_group_count > 0,
        duplicate_group_count: duplicate_group_count
    };
}

exports.getDuplicateGroups = async (user_uid = null) => {
    await backfillMissingDuplicateMetadata(user_uid);

    const filter_obj = {duplicate_key: {$ne: null}};
    if (shouldRestrictToUser(user_uid)) filter_obj['user_uid'] = user_uid;

    if (db_api.isUsingLocalDB()) {
        const files = await db_api.getRecords('files', filter_obj);
        return groupDuplicateFiles(files);
    }

    const duplicate_key_result = await db_api.aggregateRecords('files', [
        {$match: filter_obj},
        {$group: {
            _id: '$duplicate_key',
            count: {$sum: 1},
            newest_registered: {$max: '$registered'}
        }},
        {$match: {count: {$gt: 1}}},
        {$sort: {newest_registered: -1}}
    ]);
    const duplicate_keys = duplicate_key_result.map(result => result && result._id).filter(Boolean);
    if (duplicate_keys.length === 0) return [];

    const duplicate_files = await db_api.getRecords('files', {
        ...filter_obj,
        duplicate_key: {$in: duplicate_keys}
    });
    return groupDuplicateFiles(duplicate_files);
}

async function ensureArchiveExistsForFile(file_obj = null) {
    if (!file_obj) return;

    const type = file_obj.isAudio ? 'audio' : 'video';
    let source_extractor = normalizeSourceValue(file_obj.source_extractor);
    let source_id = normalizeSourceValue(file_obj.source_id);
    if (!source_extractor || !source_id) {
        const info_json = file_obj.path ? utils.getJSON(file_obj.path, type) : null;
        const source_metadata = extractSourceMetadataFromInfo(info_json, type) || extractSourceMetadataFromUrl(file_obj.url, type);
        source_extractor = source_extractor || normalizeSourceValue(source_metadata && source_metadata.source_extractor);
        source_id = source_id || normalizeSourceValue(source_metadata && source_metadata.source_id);
    }
    if (!source_extractor || !source_id) return;

    const exists_in_archive = await archive_api.existsInArchive(source_extractor, source_id, type, file_obj.user_uid, file_obj.sub_id);
    if (!exists_in_archive) {
        await archive_api.addToArchive(source_extractor, source_id, type, file_obj.title, file_obj.user_uid, file_obj.sub_id);
    }
}

exports.removeNewestDuplicates = async (duplicate_key, user_uid = null) => {
    const normalized_duplicate_key = normalizeSourceValue(duplicate_key);
    if (!normalized_duplicate_key) {
        return {success: false, removed_uids: []};
    }

    const filter_obj = {duplicate_key: normalized_duplicate_key};
    if (shouldRestrictToUser(user_uid)) filter_obj['user_uid'] = user_uid;

    const duplicate_files = await db_api.getRecords('files', filter_obj, false, {by: 'registered', order: 1});
    if (!Array.isArray(duplicate_files) || duplicate_files.length <= 1) {
        return {success: true, removed_uids: []};
    }

    const kept_file = duplicate_files[0];
    const files_to_remove = duplicate_files.slice(1);
    const removed_uids = [];

    for (const file_obj of files_to_remove) {
        const removed = await exports.deleteFile(file_obj.uid, false, user_uid);
        if (removed) removed_uids.push(file_obj.uid);
    }

    await ensureArchiveExistsForFile(kept_file);
    return {
        success: removed_uids.length === files_to_remove.length,
        removed_uids: removed_uids
    };
}

exports.findExistingDuplicateByInfo = async (info_obj = null, type = 'video', user_uid = null) => {
    const source_metadata = extractSourceMetadataFromInfo(info_obj, type);
    const scoped_filter = shouldRestrictToUser(user_uid) ? {user_uid: user_uid} : {};

    if (source_metadata && source_metadata.duplicate_key) {
        const duplicate_matches = await db_api.getRecords('files', {
            duplicate_key: source_metadata.duplicate_key,
            ...scoped_filter
        }, false, {by: 'registered', order: 1});
        if (duplicate_matches.length > 0) return hydrateFileSourceMetadata(duplicate_matches[0], true);
    }

    const fallback_url = normalizeSourceValue(info_obj && info_obj['webpage_url']);
    if (!fallback_url) return null;

    const url_matches = await db_api.getRecords('files', {
        url: fallback_url,
        isAudio: type === 'audio',
        ...scoped_filter
    }, false, {by: 'registered', order: 1});
    if (url_matches.length === 0) return null;

    return hydrateFileSourceMetadata(url_matches[0], true);
}

exports.registerFileDB = async (file_path, type, user_uid = null, category = null, sub_id = null, cropFileSettings = null, file_object = null) => {
    if (!file_object) file_object = generateFileObject(file_path, type);
    if (!file_object) {
        logger.error(`Could not find associated JSON file for ${type} file ${file_path}`);
        return false;
    }

    if (!file_object.source_metadata_checked) {
        const source_metadata = file_object.path ? extractSourceMetadataFromInfo(utils.getJSON(file_object.path, type), type) : extractSourceMetadataFromUrl(file_object.url, type);
        applySourceMetadataToFileObject(file_object, source_metadata, type);
    }

    utils.fixVideoMetadataPerms(file_path, type);

    // add thumbnail path
    file_object['thumbnailPath'] = utils.getDownloadedThumbnail(file_path);

    // if category exists, only include essential info
    if (category) file_object['category'] = {name: category['name'], uid: category['uid']};

    // modify duration
    if (cropFileSettings) {
        file_object['duration'] = (cropFileSettings.cropFileEnd || file_object.duration) - cropFileSettings.cropFileStart;
    }

    if (user_uid) file_object['user_uid'] = user_uid;
    if (sub_id) file_object['sub_id'] = sub_id;

    const file_obj = await registerFileDBManual(file_object);

    // remove metadata JSON if needed
    if (!config_api.getConfigItem('ytdl_include_metadata')) {
        utils.deleteJSONFile(file_path, type)
    }

    return file_obj;
}

async function registerFileDBManual(file_object) {
    // add additional info
    file_object['uid'] = uuid();
    file_object['registered'] = Date.now();
    const path_object = path.parse(file_object['path']);
    file_object['path'] = path.format(path_object);

    await db_api.insertRecordIntoTable('files', file_object, {path: file_object['path']})

    return file_object;
}

function generateFileObject(file_path, type) {
    const jsonobj = utils.getJSON(file_path, type);
    if (!jsonobj) {
        return null;
    } else if (!jsonobj['_filename']) {
        logger.error(`Failed to get filename from info JSON! File ${jsonobj['title']} could not be added.`);
        return null;
    }
    const true_file_path = utils.getTrueFileName(jsonobj['_filename'], type);
    // console.
    const stats = fs.statSync(true_file_path);

    const file_id = utils.removeFileExtension(path.basename(file_path));
    const title = jsonobj.title;
    const url = jsonobj.webpage_url;
    const uploader = jsonobj.uploader;
    const upload_date = utils.formatDateString(jsonobj.upload_date);

    const size = stats.size;

    const thumbnail = jsonobj.thumbnail;
    const duration = jsonobj.duration;
    const isaudio = type === 'audio';
    const description = jsonobj.description;
    const source_metadata = extractSourceMetadataFromInfo(jsonobj, type);
    const file_obj = new utils.File(file_id, title, thumbnail, isaudio, duration, url, uploader, size, true_file_path, upload_date, description, jsonobj.view_count, jsonobj.height, jsonobj.abr, source_metadata && source_metadata.source_id, source_metadata && source_metadata.source_extractor, source_metadata && source_metadata.duplicate_key);
    file_obj.source_metadata_checked = true;
    return file_obj;
}

exports.importUnregisteredFiles = async () => {
    const imported_files = [];
    const dirs_to_check = await db_api.getFileDirectoriesAndDBs();

    // run through check list and check each file to see if it's missing from the db
    for (let i = 0; i < dirs_to_check.length; i++) {
        const dir_to_check = dirs_to_check[i];
        // recursively get all files in dir's path
        const files = await utils.getDownloadedFilesByType(dir_to_check.basePath, dir_to_check.type);

        for (let j = 0; j < files.length; j++) {
            const file = files[j];

            // check if file exists in db, if not add it
            const files_with_same_url = await db_api.getRecords('files', {url: file.url, sub_id: dir_to_check.sub_id});
            const file_is_registered = !!(files_with_same_url.find(file_with_same_url => path.resolve(file_with_same_url.path) === path.resolve(file.path)));
            if (!file_is_registered) {
                // add additional info
                const file_obj = await exports.registerFileDB(file['path'], dir_to_check.type, dir_to_check.user_uid, null, dir_to_check.sub_id, null);
                if (file_obj) {
                    imported_files.push(file_obj['uid']);
                    logger.verbose(`Added discovered file to the database: ${file.id}`);
                } else {
                    logger.error(`Failed to import ${file['path']} automatically.`);
                }
            }
        }
    }
    return imported_files;
}

exports.addMetadataPropertyToDB = async (property_key) => {
    try {
        const dirs_to_check = await db_api.getFileDirectoriesAndDBs();
        const update_obj = {};
        for (let i = 0; i < dirs_to_check.length; i++) {
            const dir_to_check = dirs_to_check[i];

            // recursively get all files in dir's path
            const files = await utils.getDownloadedFilesByType(dir_to_check.basePath, dir_to_check.type, true);
            for (let j = 0; j < files.length; j++) {
                const file = files[j];
                if (file[property_key]) {
                    update_obj[file.uid] = {[property_key]: file[property_key]};
                }
            }
        }

        return await db_api.bulkUpdateRecordsByKey('files', 'uid', update_obj);
    } catch(err) {
        logger.error(err);
        return false;
    }
}

exports.createPlaylist = async (playlist_name, uids, user_uid = null) => {
    const first_video = await exports.getVideo(uids[0], user_uid);
    if (!first_video) return null;
    const thumbnailToUse = first_video['thumbnailURL'];
    
    let new_playlist = {
        name: playlist_name,
        uids: uids,
        id: uuid(),
        thumbnailURL: thumbnailToUse,
        registered: Date.now(),
        randomize_order: false
    };

    new_playlist.user_uid = user_uid ? user_uid : undefined;

    await db_api.insertRecordIntoTable('playlists', new_playlist);
    
    const duration = await exports.calculatePlaylistDuration(new_playlist);
    await db_api.updateRecord('playlists', {id: new_playlist.id}, {duration: duration});

    return new_playlist;
}

exports.getPlaylist = async (playlist_id, user_uid = null, require_sharing = false) => {
    const playlist_filter = {id: playlist_id};
    if (shouldRestrictToUser(user_uid)) playlist_filter['user_uid'] = user_uid;
    let playlist = await db_api.getRecord('playlists', playlist_filter);

    if (!playlist) {
        playlist = await db_api.getRecord('categories', {uid: playlist_id});
        if (playlist) {
            const files_filter = {'category.uid': playlist_id};
            if (shouldRestrictToUser(user_uid)) files_filter['user_uid'] = user_uid;
            const uids = (await db_api.getRecords('files', files_filter)).map(file => file.uid);
            playlist['uids'] = uids;
            playlist['auto'] = true;
        }
    }

    // converts playlists to new UID-based schema
    if (playlist && playlist['fileNames'] && !playlist['uids']) {
        playlist['uids'] = [];
        logger.verbose(`Converting playlist ${playlist['name']} to new UID-based schema.`);
        for (let i = 0; i < playlist['fileNames'].length; i++) {
            const fileName = playlist['fileNames'][i];
            const uid = await exports.getVideoUIDByID(fileName, user_uid);
            if (uid) playlist['uids'].push(uid);
            else logger.warn(`Failed to convert file with name ${fileName} to its UID while converting playlist ${playlist['name']} to the new UID-based schema. The original file is likely missing/deleted and it will be skipped.`);
        }
        exports.updatePlaylist(playlist, user_uid);
    }

    // prevent unauthorized users from accessing the file info
    if (require_sharing && (!playlist || !playlist['sharingEnabled'])) return null;

    return playlist;
}

exports.updatePlaylist = async (playlist, user_uid = null) => {
    let playlistID = playlist.id;
    const filter_obj = {id: playlistID};
    if (shouldRestrictToUser(user_uid)) filter_obj['user_uid'] = user_uid;

    const duration = await exports.calculatePlaylistDuration(playlist);
    playlist.duration = duration;

    return await db_api.updateRecord('playlists', filter_obj, playlist);
}

exports.setPlaylistProperty = async (playlist_id, assignment_obj, user_uid = null) => {
    const playlist_filter_obj = {id: playlist_id};
    if (shouldRestrictToUser(user_uid)) playlist_filter_obj['user_uid'] = user_uid;
    let success = await db_api.updateRecord('playlists', playlist_filter_obj, assignment_obj);

    if (!success) {
        success = await db_api.updateRecord('categories', {uid: playlist_id}, assignment_obj);
    }

    if (!success) {
        logger.error(`Could not find playlist or category with ID ${playlist_id}`);
    }

    return success;
}

exports.calculatePlaylistDuration = async (playlist, playlist_file_objs = null) => {
    if (!playlist_file_objs) {
        const playlist_uids = Array.isArray(playlist['uids']) ? playlist['uids'] : [];
        const max_playlist_uids_to_scan = 10000;
        const playlist_uids_to_scan = playlist_uids.slice(0, max_playlist_uids_to_scan);
        playlist_file_objs = await exports.getVideosByUIDs(playlist_uids_to_scan, playlist.user_uid);
    }

    return playlist_file_objs.reduce((a, b) => a + utils.durationStringToNumber(b.duration), 0);
}

exports.deleteFileObject = async (file_obj, blacklistMode = false) => {
    if (!file_obj) return false;
    const type = file_obj.isAudio ? 'audio' : 'video';
    const folderPath = path.dirname(file_obj.path);
    const name = file_obj.id;
    const filePathNoExtension = utils.removeFileExtension(file_obj.path);

    var jsonPath = `${file_obj.path}.info.json`;
    var altJSONPath = `${filePathNoExtension}.info.json`;
    var thumbnailPath = `${filePathNoExtension}.webp`;
    var altThumbnailPath = `${filePathNoExtension}.jpg`;

    jsonPath = path.join(__dirname, jsonPath);
    altJSONPath = path.join(__dirname, altJSONPath);

    let jsonExists = await fs.pathExists(jsonPath);
    let thumbnailExists = await fs.pathExists(thumbnailPath);

    if (!jsonExists) {
        if (await fs.pathExists(altJSONPath)) {
            jsonExists = true;
            jsonPath = altJSONPath;
        }
    }

    if (!thumbnailExists) {
        if (await fs.pathExists(altThumbnailPath)) {
            thumbnailExists = true;
            thumbnailPath = altThumbnailPath;
        }
    }

    let fileExists = await fs.pathExists(file_obj.path);

    if (config_api.descriptors[file_obj.uid]) {
        try {
            for (let i = 0; i < config_api.descriptors[file_obj.uid].length; i++) {
                config_api.descriptors[file_obj.uid][i].destroy();
            }
        } catch(e) {

        }
    }

    let useYoutubeDLArchive = config_api.getConfigItem('ytdl_use_youtubedl_archive');
    if (useYoutubeDLArchive || file_obj.sub_id) {
        // get id/extractor from JSON

        const info_json = await (type === 'audio' ? utils.getJSONMp3(name, folderPath) : utils.getJSONMp4(name, folderPath));
        let retrievedID = null;
        let retrievedExtractor = null;
        if (info_json) {
            retrievedID = info_json['id'];
            retrievedExtractor = info_json['extractor'];
        }
        if (!retrievedID) retrievedID = file_obj.source_id || null;
        if (!retrievedExtractor) retrievedExtractor = file_obj.source_extractor || null;

        // Remove file ID from the archive file, and write it to the blacklist (if enabled)
        if (!blacklistMode) {
            await archive_api.removeFromArchive(retrievedExtractor, retrievedID, type, file_obj.user_uid, file_obj.sub_id)
        } else {
            const exists_in_archive = await archive_api.existsInArchive(retrievedExtractor, retrievedID, type, file_obj.user_uid, file_obj.sub_id);
            if (!exists_in_archive) {
                await archive_api.addToArchive(retrievedExtractor, retrievedID, type, file_obj.title, file_obj.user_uid, file_obj.sub_id);
            }
        }
    }

    if (jsonExists) await fs.unlink(jsonPath);
    if (thumbnailExists) await fs.unlink(thumbnailPath);

    await db_api.removeRecord('files', {uid: file_obj.uid});

    if (fileExists) {
        await fs.unlink(file_obj.path);
        if (await fs.pathExists(jsonPath) || await fs.pathExists(file_obj.path)) {
            return false;
        } else {
            return true;
        }
    } else {
        // TODO: tell user that the file didn't exist
        return true;
    }
}

exports.deleteFile = async (uid, blacklistMode = false, user_uid = null) => {
    const file_obj = await exports.getVideo(uid, user_uid);
    if (!file_obj) return false;

    return await exports.deleteFileObject(file_obj, blacklistMode);
}

exports.deleteFilesInBatches = async (uids = [], blacklistMode = false, user_uid = null, batch_size = PLAYLIST_FILE_DELETE_BATCH_SIZE) => {
    if (!Array.isArray(uids) || uids.length === 0) {
        return {deleted_count: 0, failed_count: 0};
    }

    const unique_uids = [...new Set(uids.filter(uid => uid !== undefined && uid !== null))];
    if (unique_uids.length === 0) {
        return {deleted_count: 0, failed_count: 0};
    }

    const file_objs = await exports.getVideosByUIDs(unique_uids, user_uid);
    if (file_objs.length === 0) {
        return {deleted_count: 0, failed_count: 0};
    }

    const bounded_batch_size = Math.max(1, Number(batch_size) || PLAYLIST_FILE_DELETE_BATCH_SIZE);
    let deleted_count = 0;
    let failed_count = 0;

    for (let i = 0; i < file_objs.length; i += bounded_batch_size) {
        const batch_file_objs = file_objs.slice(i, i + bounded_batch_size);
        const batch_results = await Promise.allSettled(
            batch_file_objs.map(file_obj => exports.deleteFileObject(file_obj, blacklistMode))
        );

        for (const result of batch_results) {
            if (result.status === 'fulfilled' && result.value) {
                deleted_count += 1;
            } else {
                failed_count += 1;
            }
        }
    }

    return {deleted_count, failed_count};
}

// Video ID is basically just the file name without the base path and file extension - this method helps us get away from that
exports.getVideoUIDByID = async (file_id, uuid = null) => {
    const filter_obj = {id: file_id};
    if (shouldRestrictToUser(uuid)) filter_obj['user_uid'] = uuid;
    const file_obj = await db_api.getRecord('files', filter_obj);
    return file_obj ? file_obj['uid'] : null;
}

exports.getVideo = async (file_uid, user_uid = null, sub_id = null) => {
    const filter_obj = {uid: file_uid};
    if (shouldRestrictToUser(user_uid)) filter_obj['user_uid'] = user_uid;
    if (sub_id) filter_obj['sub_id'] = sub_id;
    return await db_api.getRecord('files', filter_obj);
}

exports.getVideosByUIDs = async (file_uids = [], user_uid = null) => {
    if (!Array.isArray(file_uids) || file_uids.length === 0) return [];

    const ordered_uids = file_uids.filter(uid => uid !== undefined && uid !== null);
    if (ordered_uids.length === 0) return [];

    const unique_uids = [...new Set(ordered_uids)];
    const filter_obj = {uid: {$in: unique_uids}};
    if (shouldRestrictToUser(user_uid)) filter_obj['user_uid'] = user_uid;

    const file_objs = await db_api.getRecords('files', filter_obj);
    const file_by_uid = new Map(file_objs.map(file_obj => [file_obj.uid, file_obj]));
    return ordered_uids.map(uid => file_by_uid.get(uid)).filter(Boolean);
}

exports.getAllFiles = async (sort, range, text_search, file_type_filter, favorite_filter, sub_id, uuid) => {
    const filter_obj = {};
    if (config_api.getConfigItem('ytdl_multi_user_mode')) {
        filter_obj['user_uid'] = uuid;
    }

    if (text_search) {
        const normalized_text_search = text_search.trim();
        if (normalized_text_search !== '') {
            if (db_api.isUsingLocalDB()) {
                filter_obj['title'] = {$regex: escapeRegex(normalized_text_search), $options: 'i'};
            } else {
                filter_obj['$text'] = { $search: utils.createEdgeNGrams(normalized_text_search) };
            }
        }
    }

    if (favorite_filter) {
        filter_obj['favorite'] = true;
    }

    if (sub_id) {
        filter_obj['sub_id'] = sub_id;
    }

    if (file_type_filter === 'audio_only') filter_obj['isAudio'] = true;
    else if (file_type_filter === 'video_only') filter_obj['isAudio'] = false;

    const files = await db_api.getRecords('files', filter_obj, false, sort, range);
    const file_count = await db_api.getRecords('files', filter_obj, true);

    return {files, file_count};
}
