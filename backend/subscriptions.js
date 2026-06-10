const fs = require('fs-extra');
const path = require('path');

const youtubedl_api = require('./youtube-dl');
const config_api = require('./config');
const archive_api = require('./archive');
const files_api = require('./files');
const utils = require('./utils');
const logger = require('./logger');
const CONSTS = require('./consts');

const debugMode = process.env.YTDL_MODE === 'debug';

const db_api = require('./db');
const downloader_api = require('./downloader');

const SUBSCRIPTION_REFRESH_PHASES = Object.freeze({
    IDLE: 'idle',
    COLLECTING: 'collecting',
    QUEUEING: 'queueing',
    QUEUED: 'queued',
    COMPLETE: 'complete',
    CANCELLED: 'cancelled',
    ERROR: 'error'
});
const SUBSCRIPTION_REFRESH_COUNT_WRITE_INTERVAL = 5;
const SUBSCRIPTION_QUEUE_BATCH_SIZE = 50;
const MATCH_FILTER_ARGS = new Set(['--match-filter', '--match-filters']);
const BREAK_MATCH_FILTER_ARGS = new Set(['--break-match-filter', '--break-match-filters']);
const NO_MATCH_FILTER_ARGS = new Set(['--no-match-filter', '--no-match-filters']);
const JOIN_ONLY_AVAILABILITY_VALUES = new Set(['subscriber_only']);
const active_subscription_refresh_trackers = new Map();

function shouldRestrictToUser(user_uid) {
    return config_api.getConfigItem('ytdl_multi_user_mode') && user_uid !== null && user_uid !== undefined;
}

function getSubscriptionsBasePath(user_uid = null) {
    if (user_uid) return path.join(config_api.getConfigItem('ytdl_users_base_path'), user_uid, 'subscriptions');
    return config_api.getConfigItem('ytdl_subscriptions_base_path');
}

function getSubscriptionsBasePathForSub(sub = null, user_uid = null) {
    return getSubscriptionsBasePath(user_uid || (sub && sub.user_uid));
}

function normalizeSubscriptionStorageOptions(sub = null) {
    if (!sub || typeof sub !== 'object') return sub;
    sub.use_subfolder = sub.use_subfolder !== false;
    return sub;
}

function getSubscriptionMetadataBasePath(sub, base_path) {
    return utils.getSubscriptionMetadataPath(sub, base_path);
}

function getSubscriptionTemporaryArchivePath(sub, base_path) {
    return path.join(getSubscriptionMetadataBasePath(sub, base_path), 'archive.txt');
}

function asFiniteCount(value, default_value = 0) {
    const numeric_value = Number(value);
    if (!Number.isFinite(numeric_value)) return default_value;
    return Math.max(0, Math.floor(numeric_value));
}

function normalizeNullableCount(value) {
    const numeric_value = Number(value);
    if (!Number.isFinite(numeric_value)) return null;
    return Math.max(0, Math.floor(numeric_value));
}

function normalizeNullableString(value) {
    if (typeof value !== 'string') return null;
    const normalized_value = value.trim();
    return normalized_value !== '' ? normalized_value : null;
}

function normalizeStringForComparison(value) {
    if (value === null || value === undefined) return null;
    const normalized_value = String(value).trim();
    if (normalized_value === '') return null;
    return normalized_value.replace(/^['"]|['"]$/g, '').trim().toLowerCase();
}

function normalizeArchiveSourceValue(value) {
    if (value === null || value === undefined) return null;
    const normalized_value = String(value).trim();
    return normalized_value === '' ? null : normalized_value;
}

function getArchiveKey(extractor = null, id = null) {
    const normalized_extractor = normalizeStringForComparison(extractor);
    const normalized_id = normalizeArchiveSourceValue(id);
    if (!normalized_extractor || !normalized_id) return null;
    return `${normalized_extractor}:${normalized_id}`;
}

function parseDelimitedArgs(args_string = '') {
    if (typeof args_string !== 'string' || args_string.trim() === '') return [];
    return args_string.split(',,').map(arg => arg.trim()).filter(arg => arg !== '');
}

function applyCustomArgs(downloadConfig = [], args_string = '') {
    const custom_args = parseDelimitedArgs(args_string);
    if (custom_args.length === 0) return downloadConfig;
    return utils.injectArgs(downloadConfig, custom_args);
}

function collectMatchFiltersFromArgs(args = []) {
    const match_filters = [];
    if (!Array.isArray(args)) return match_filters;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (typeof arg !== 'string') continue;

        if (NO_MATCH_FILTER_ARGS.has(arg)) {
            match_filters.length = 0;
            continue;
        }

        const inline_match_filter_arg = [...MATCH_FILTER_ARGS].find(match_filter_arg => arg.startsWith(`${match_filter_arg}=`));
        if (inline_match_filter_arg) {
            const inline_filter = arg.slice(inline_match_filter_arg.length + 1).trim();
            if (inline_filter && inline_filter !== '-') match_filters.push(inline_filter);
            continue;
        }

        if (!MATCH_FILTER_ARGS.has(arg)) continue;
        if (i + 1 >= args.length) continue;

        const filter_value = typeof args[i + 1] === 'string' ? args[i + 1].trim() : '';
        if (filter_value && filter_value !== '-') match_filters.push(filter_value);
        i += 1;
    }

    return match_filters;
}

function isYouTubeSubscriptionOutput(output_json = null) {
    if (!output_json || typeof output_json !== 'object') return false;
    const candidates = [
        output_json.extractor,
        output_json.extractor_key,
        output_json.ie_key,
        output_json.webpage_url,
        output_json.url
    ].map(candidate => typeof candidate === 'string' ? candidate.toLowerCase() : '');

    return candidates.some(candidate => candidate.includes('youtube') || candidate.includes('youtu.be'));
}

function getSubscriptionOutputAvailability(output_json = null) {
    if (!output_json || typeof output_json !== 'object') return null;

    const normalized_availability = normalizeStringForComparison(output_json.availability);
    if (normalized_availability) return normalized_availability;

    // yt-dlp flat YouTube playlist entries usually report public videos as
    // availability: null, while restricted entries carry explicit values.
    if (isYouTubeSubscriptionOutput(output_json) && output_json._type === 'url') {
        return 'public';
    }

    return null;
}

function getSubscriptionOutputArchiveExtractor(output_json = null) {
    if (!output_json || typeof output_json !== 'object') return null;

    const extractor = normalizeStringForComparison(output_json.extractor);
    if (extractor) return extractor.split(':')[0];

    const extractor_key = normalizeStringForComparison(output_json.extractor_key || output_json.ie_key);
    if (extractor_key) return extractor_key;

    if (isYouTubeSubscriptionOutput(output_json)) return 'youtube';
    return null;
}

function getSubscriptionOutputArchiveIdentity(output_json = null, type = 'video') {
    if (!output_json || typeof output_json !== 'object') return null;

    const source_metadata = files_api.extractSourceMetadataFromInfo(output_json, type)
        || files_api.extractSourceMetadataFromUrl(output_json.webpage_url || output_json.original_url || output_json.url, type);
    const extractor = getSubscriptionOutputArchiveExtractor(output_json)
        || (source_metadata && source_metadata.source_extractor);
    const id = normalizeArchiveSourceValue(output_json.source_id)
        || normalizeArchiveSourceValue(output_json.id)
        || normalizeArchiveSourceValue(output_json.display_id)
        || normalizeArchiveSourceValue(source_metadata && source_metadata.source_id);

    if (!extractor || !id) return null;
    return {
        extractor: extractor,
        id: id,
        title: output_json.title || null
    };
}

function getSubscriptionOutputArchiveKey(output_json = null, type = 'video') {
    const archive_identity = getSubscriptionOutputArchiveIdentity(output_json, type);
    return archive_identity ? getArchiveKey(archive_identity.extractor, archive_identity.id) : null;
}

function getSubscriptionFileArchiveKey(file_obj = null, type = 'video') {
    if (!file_obj || typeof file_obj !== 'object') return null;

    const source_extractor = normalizeArchiveSourceValue(file_obj.source_extractor);
    const source_id = normalizeArchiveSourceValue(file_obj.source_id);
    const key_from_source_metadata = getArchiveKey(source_extractor, source_id);
    if (key_from_source_metadata) return key_from_source_metadata;

    const source_metadata = files_api.extractSourceMetadataFromUrl(file_obj.url, type);
    return source_metadata ? getArchiveKey(source_metadata.source_extractor, source_metadata.source_id) : null;
}

function getSubscriptionDownloadArchiveKey(download = null, type = 'video') {
    if (!download || typeof download !== 'object') return null;

    const prefetched_info_items = Array.isArray(download.prefetched_info)
        ? download.prefetched_info.filter(info_item => !!info_item && typeof info_item === 'object')
        : [];
    const candidates = [
        ...prefetched_info_items,
        {
            webpage_url: download.url,
            url: download.url,
            title: download.title
        }
    ];

    for (const candidate of candidates) {
        const archive_key = getSubscriptionOutputArchiveKey(candidate, type);
        if (archive_key) return archive_key;
    }

    return null;
}

function getSubscriptionArchiveFilter(sub = null) {
    const filter = {sub_id: sub && sub.id};
    if (sub && sub.type) filter.type = sub.type;
    if (config_api.getConfigItem('ytdl_multi_user_mode')) {
        filter.user_uid = sub ? sub.user_uid : null;
    }
    return filter;
}

function parseAvailabilityMatchCondition(condition = '') {
    if (typeof condition !== 'string' || condition.trim() === '') return null;

    const match = condition.trim().match(/^availability\s*(=|==|!=)\s*(.+)$/i);
    if (!match) return null;

    const expected_availability = normalizeStringForComparison(match[2]);
    if (!expected_availability) return null;
    return {
        operator: match[1],
        expected_availability: expected_availability
    };
}

function evaluateAvailabilityMatchCondition(output_json = null, condition = '') {
    const parsed_condition = parseAvailabilityMatchCondition(condition);
    if (!parsed_condition) return null;

    const actual_availability = getSubscriptionOutputAvailability(output_json);
    if (!actual_availability) return null;

    return parsed_condition.operator === '!='
        ? actual_availability !== parsed_condition.expected_availability
        : actual_availability === parsed_condition.expected_availability;
}

function isAvailabilityMatchFilter(match_filter = '') {
    if (typeof match_filter !== 'string' || match_filter.trim() === '') return false;
    return match_filter.split(/\s*&\s*/).some(condition => parseAvailabilityMatchCondition(condition) !== null);
}

function evaluateAvailabilityMatchFilter(output_json = null, match_filter = '') {
    if (typeof match_filter !== 'string' || match_filter.trim() === '') return null;

    const conditions = match_filter.split(/\s*&\s*/).map(condition => condition.trim()).filter(condition => condition !== '');
    if (conditions.length === 0) return null;

    let found_evaluable_condition = false;
    let found_unknown_condition = false;
    for (const condition of conditions) {
        const condition_result = evaluateAvailabilityMatchCondition(output_json, condition);
        if (condition_result === false) return false;
        if (condition_result === true) {
            found_evaluable_condition = true;
        } else {
            found_unknown_condition = true;
        }
    }

    if (found_unknown_condition) return null;
    return found_evaluable_condition ? true : null;
}

function filterSubscriptionDiscoveryAvailabilityMatchFilters(args = []) {
    if (!Array.isArray(args)) return [];

    const filtered_args = [];
    const match_filter_args_with_values = new Set([...MATCH_FILTER_ARGS, ...BREAK_MATCH_FILTER_ARGS]);
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (typeof arg !== 'string') {
            filtered_args.push(arg);
            continue;
        }

        const inline_match_filter_arg = [...match_filter_args_with_values].find(match_filter_arg => arg.startsWith(`${match_filter_arg}=`));
        if (inline_match_filter_arg) {
            const inline_filter = arg.slice(inline_match_filter_arg.length + 1).trim();
            if (isAvailabilityMatchFilter(inline_filter)) continue;
            filtered_args.push(arg);
            continue;
        }

        if (match_filter_args_with_values.has(arg)) {
            const filter_value = i + 1 < args.length && typeof args[i + 1] === 'string' ? args[i + 1].trim() : '';
            if (isAvailabilityMatchFilter(filter_value)) {
                i += 1;
                continue;
            }
        }

        filtered_args.push(arg);
    }

    return filtered_args;
}

function matchesSubscriptionAvailabilityFilters(output_json = null, match_filters = []) {
    if (!Array.isArray(match_filters) || match_filters.length === 0) return true;

    let found_evaluable_filter = false;
    for (const match_filter of match_filters) {
        const filter_result = evaluateAvailabilityMatchFilter(output_json, match_filter);
        if (filter_result === true) return true;
        if (filter_result === false) found_evaluable_filter = true;
    }

    return found_evaluable_filter ? false : true;
}

function isJoinOnlySubscriptionOutput(output_json = null) {
    const availability = getSubscriptionOutputAvailability(output_json);
    if (availability && JOIN_ONLY_AVAILABILITY_VALUES.has(availability)) return true;

    if (!output_json || typeof output_json !== 'object') return false;
    const searchable_text = [
        output_json.title,
        output_json.description,
        output_json.reason,
        output_json.message
    ].map(candidate => typeof candidate === 'string' ? candidate.toLowerCase() : '').join(' ');

    return searchable_text.includes('join this channel')
        || searchable_text.includes('members-only')
        || searchable_text.includes('member-only')
        || searchable_text.includes('member exclusive')
        || searchable_text.includes('member, supporter')
        || searchable_text.includes('patron-exclusive');
}

async function archiveSkippedJoinOnlySubscriptionOutput(output_json = null, sub = null) {
    if (!output_json || !sub) return false;

    const archive_identity = getSubscriptionOutputArchiveIdentity(output_json, sub.type);
    if (!archive_identity) return false;

    await archive_api.addToArchive(
        archive_identity.extractor,
        archive_identity.id,
        sub.type,
        archive_identity.title,
        sub.user_uid,
        sub.id
    );
    logger.info(`Archived join-only video ${archive_identity.extractor}:${archive_identity.id} for subscription ${sub.id}.`);
    return true;
}

async function shouldSkipSubscriptionOutput(output_json = null, sub = null, discovery_filter_context = null, skip_context = null) {
    if (!output_json || typeof output_json !== 'object') return true;

    if (config_api.getConfigItem('ytdl_skip_join_only_videos') && isJoinOnlySubscriptionOutput(output_json)) {
        await archiveSkippedJoinOnlySubscriptionOutput(output_json, sub);
        if (skip_context) skip_context.skipped_count = asFiniteCount(skip_context.skipped_count, 0) + 1;
        logger.info(`Skipping join-only subscription video '${output_json.webpage_url || output_json.url || output_json.id}'.`);
        return true;
    }

    const match_filters = discovery_filter_context && Array.isArray(discovery_filter_context.match_filters)
        ? discovery_filter_context.match_filters
        : [];
    if (!matchesSubscriptionAvailabilityFilters(output_json, match_filters)) {
        logger.info(`Skipping subscription video '${output_json.webpage_url || output_json.url || output_json.id}' because it did not match configured availability filters.`);
        return true;
    }

    return false;
}

function describeSubscriptionInfoError(err) {
    const fallback_error = 'downloader returned no JSON output and did not provide stderr.';
    if (!err) return fallback_error;
    if (typeof err === 'string') return err.trim() || fallback_error;
    if (err.stderr) return String(err.stderr).trim();
    if (err.message) return String(err.message).trim();
    return String(err).trim() || fallback_error;
}

function normalizeSubscriptionRefreshStatus(refresh_status = null) {
    const normalized_refresh_status = {
        active: false,
        phase: SUBSCRIPTION_REFRESH_PHASES.IDLE,
        discovered_count: 0,
        total_count: null,
        new_items_count: null,
        queued_count: 0,
        skipped_count: 0,
        latest_item_title: null,
        started_at: null,
        updated_at: null,
        completed_at: null,
        error: null
    };

    if (!refresh_status || typeof refresh_status !== 'object') {
        return normalized_refresh_status;
    }

    normalized_refresh_status.active = refresh_status.active === true;
    normalized_refresh_status.phase = Object.values(SUBSCRIPTION_REFRESH_PHASES).includes(refresh_status.phase)
        ? refresh_status.phase
        : (normalized_refresh_status.active ? SUBSCRIPTION_REFRESH_PHASES.COLLECTING : SUBSCRIPTION_REFRESH_PHASES.IDLE);
    normalized_refresh_status.discovered_count = asFiniteCount(refresh_status.discovered_count, 0);
    normalized_refresh_status.total_count = normalizeNullableCount(refresh_status.total_count);
    normalized_refresh_status.new_items_count = normalizeNullableCount(refresh_status.new_items_count);
    normalized_refresh_status.queued_count = asFiniteCount(refresh_status.queued_count, 0);
    normalized_refresh_status.skipped_count = asFiniteCount(refresh_status.skipped_count, 0);
    normalized_refresh_status.latest_item_title = normalizeNullableString(refresh_status.latest_item_title);
    normalized_refresh_status.started_at = normalizeNullableCount(refresh_status.started_at);
    normalized_refresh_status.updated_at = normalizeNullableCount(refresh_status.updated_at);
    normalized_refresh_status.completed_at = normalizeNullableCount(refresh_status.completed_at);
    normalized_refresh_status.error = normalizeNullableString(refresh_status.error);

    return normalized_refresh_status;
}
exports.normalizeSubscriptionRefreshStatus = normalizeSubscriptionRefreshStatus;

function createInitialSubscriptionRefreshStatus() {
    const now = Date.now();
    return normalizeSubscriptionRefreshStatus({
        active: true,
        phase: SUBSCRIPTION_REFRESH_PHASES.COLLECTING,
        discovered_count: 0,
        total_count: null,
        new_items_count: null,
        queued_count: 0,
        skipped_count: 0,
        latest_item_title: null,
        started_at: now,
        updated_at: now,
        completed_at: null,
        error: null
    });
}

function buildInterruptedSubscriptionRefreshStatus(refresh_status = null) {
    const normalized_refresh_status = normalizeSubscriptionRefreshStatus(refresh_status);
    if (!normalized_refresh_status.active) return normalized_refresh_status;

    return normalizeSubscriptionRefreshStatus({
        ...normalized_refresh_status,
        active: false,
        phase: SUBSCRIPTION_REFRESH_PHASES.CANCELLED,
        updated_at: Date.now(),
        completed_at: Date.now()
    });
}
exports.buildInterruptedSubscriptionRefreshStatus = buildInterruptedSubscriptionRefreshStatus;

async function persistSubscriptionRefreshStatus(sub_id, refresh_status) {
    if (!sub_id) return false;
    const normalized_refresh_status = normalizeSubscriptionRefreshStatus(refresh_status);
    normalized_refresh_status.updated_at = Date.now();
    return await db_api.updateRecord('subscriptions', {id: sub_id}, {refresh_status: normalized_refresh_status});
}

function createSubscriptionRefreshTracker(sub) {
    const refresh_status = createInitialSubscriptionRefreshStatus();
    const tracker = {
        sub_id: sub.id,
        refresh_status: refresh_status,
        seen_output_keys: new Set(),
        last_persisted_discovered_count: 0,
        last_persisted_total_count: null,
        last_persisted_queued_count: 0,
        last_persisted_skipped_count: 0,
        last_persisted_phase: refresh_status.phase
    };

    active_subscription_refresh_trackers.set(sub.id, tracker);
    return tracker;
}

function getSubscriptionOutputKey(output_json = null) {
    if (!output_json || typeof output_json !== 'object') return null;
    if (output_json.extractor && output_json.id) {
        return `${output_json.extractor}:${output_json.id}`;
    }
    if (output_json.id) {
        return `id:${output_json.id}`;
    }
    if (output_json.webpage_url) {
        return `url:${output_json.webpage_url}`;
    }
    if (output_json.url) {
        return `url:${output_json.url}`;
    }
    if (output_json.title) {
        return `title:${output_json.title}`;
    }
    return null;
}

function parseSubscriptionRefreshOutputLine(output_line = '') {
    const playlist_state = downloader_api.parseYoutubeDLPlaylistProgressState(output_line);

    if (typeof output_line !== 'string' || output_line.trim() === '') {
        return {playlist_state: playlist_state, output_json: null};
    }

    const start_idx = output_line.indexOf('{"');
    if (start_idx === -1) {
        return {playlist_state: playlist_state, output_json: null};
    }

    try {
        return {
            playlist_state: playlist_state,
            output_json: JSON.parse(output_line.slice(start_idx).trim())
        };
    } catch (e) {
        return {
            playlist_state: playlist_state,
            output_json: null
        };
    }
}
exports.parseSubscriptionRefreshOutputLine = parseSubscriptionRefreshOutputLine;

async function maybePersistSubscriptionRefreshStatus(tracker, force = false) {
    if (!tracker || !tracker.sub_id || !tracker.refresh_status) return false;

    const should_persist_discovered_count = tracker.refresh_status.discovered_count === 1
        || (tracker.refresh_status.discovered_count - tracker.last_persisted_discovered_count) >= SUBSCRIPTION_REFRESH_COUNT_WRITE_INTERVAL;
    const should_persist_queued_count = tracker.refresh_status.queued_count === 1
        || (tracker.refresh_status.queued_count - tracker.last_persisted_queued_count) >= SUBSCRIPTION_REFRESH_COUNT_WRITE_INTERVAL;
    const should_persist_skipped_count = tracker.refresh_status.skipped_count === 1
        || (tracker.refresh_status.skipped_count - tracker.last_persisted_skipped_count) >= SUBSCRIPTION_REFRESH_COUNT_WRITE_INTERVAL;
    const should_persist = force
        || tracker.refresh_status.phase !== tracker.last_persisted_phase
        || tracker.refresh_status.total_count !== tracker.last_persisted_total_count
        || should_persist_discovered_count
        || should_persist_queued_count
        || should_persist_skipped_count;
    if (!should_persist) return false;

    await persistSubscriptionRefreshStatus(tracker.sub_id, tracker.refresh_status);
    tracker.last_persisted_discovered_count = tracker.refresh_status.discovered_count;
    tracker.last_persisted_total_count = tracker.refresh_status.total_count;
    tracker.last_persisted_queued_count = tracker.refresh_status.queued_count;
    tracker.last_persisted_skipped_count = tracker.refresh_status.skipped_count;
    tracker.last_persisted_phase = tracker.refresh_status.phase;
    return true;
}

function getSubscriptionRefreshTotalCountCandidate(playlist_state = null, output_json = null) {
    let total_count = null;
    if (playlist_state && playlist_state.total_items > 0) {
        total_count = playlist_state.total_items;
    }

    if (!output_json || typeof output_json !== 'object') {
        return total_count;
    }

    const total_count_candidates = [
        output_json.playlist_count,
        output_json.n_entries,
        output_json.__last_playlist_index,
        output_json.playlist_index
    ];

    for (const candidate of total_count_candidates) {
        const normalized_candidate = normalizeNullableCount(candidate);
        if (normalized_candidate === null) continue;
        total_count = total_count === null ? normalized_candidate : Math.max(total_count, normalized_candidate);
    }

    return total_count;
}

function updateSubscriptionRefreshTrackerFromLine(tracker, output_line = '') {
    if (!tracker || !tracker.refresh_status) return null;

    const {playlist_state, output_json} = parseSubscriptionRefreshOutputLine(output_line);
    const total_count_candidate = getSubscriptionRefreshTotalCountCandidate(playlist_state, output_json);
    let refresh_status_updated = false;

    if (total_count_candidate !== null) {
        const next_total_count = tracker.refresh_status.total_count === null
            ? total_count_candidate
            : Math.max(tracker.refresh_status.total_count, total_count_candidate);
        if (next_total_count !== tracker.refresh_status.total_count) {
            tracker.refresh_status.total_count = next_total_count;
            refresh_status_updated = true;
        }
    }

    if (!output_json) {
        if (refresh_status_updated) maybePersistSubscriptionRefreshStatus(tracker).catch(() => {});
        return null;
    }

    const output_key = getSubscriptionOutputKey(output_json);
    if (output_key && tracker.seen_output_keys.has(output_key)) {
        if (refresh_status_updated) maybePersistSubscriptionRefreshStatus(tracker).catch(() => {});
        return null;
    }
    if (output_key) tracker.seen_output_keys.add(output_key);

    tracker.refresh_status.discovered_count += 1;
    tracker.refresh_status.latest_item_title = normalizeNullableString(output_json.title) || tracker.refresh_status.latest_item_title;
    maybePersistSubscriptionRefreshStatus(tracker).catch(() => {});
    return output_json;
}

function isSubscriptionRefreshCancelled(tracker) {
    return !!(tracker && tracker.refresh_status && tracker.refresh_status.phase === SUBSCRIPTION_REFRESH_PHASES.CANCELLED);
}

async function finalizeSubscriptionRefreshWithError(sub_id, tracker, error_message = null) {
    if (!tracker) return false;
    tracker.refresh_status = normalizeSubscriptionRefreshStatus({
        ...tracker.refresh_status,
        active: false,
        phase: SUBSCRIPTION_REFRESH_PHASES.ERROR,
        error: normalizeNullableString(error_message),
        completed_at: Date.now()
    });
    active_subscription_refresh_trackers.delete(sub_id);
    return await maybePersistSubscriptionRefreshStatus(tracker, true);
}

async function finalizeSubscriptionRefreshAsCancelled(sub_id, tracker) {
    if (!tracker) return false;
    tracker.refresh_status = normalizeSubscriptionRefreshStatus({
        ...tracker.refresh_status,
        active: false,
        phase: SUBSCRIPTION_REFRESH_PHASES.CANCELLED,
        completed_at: Date.now(),
        error: null
    });
    active_subscription_refresh_trackers.delete(sub_id);
    return await maybePersistSubscriptionRefreshStatus(tracker, true);
}

async function ensureSubscriptionRefreshQueueContext(sub, user_uid, refresh_tracker = null, queue_context = null) {
    if (queue_context) return queue_context;

    if (config_api.getConfigItem('ytdl_subscriptions_redownload_fresh_uploads')) {
        await setFreshUploads(sub, user_uid);
        checkVideosForFreshUploads(sub, user_uid);
    }

    const created_queue_context = {
        download_context: await createSubscriptionDownloadContext(sub),
        base_download_options: {
            ...exports.generateOptionsForSubscriptionDownload(sub, user_uid),
            concurrentQueueGroupKey: 'subscription-downloads',
            concurrentQueueGroupLimit: downloader_api.getExclusivePlaylistConcurrencyLimit()
        },
        queued_count: 0,
        skipped_count: 0
    };

    if (refresh_tracker) {
        refresh_tracker.refresh_status = normalizeSubscriptionRefreshStatus({
            ...refresh_tracker.refresh_status,
            active: true,
            phase: SUBSCRIPTION_REFRESH_PHASES.QUEUEING,
            total_count: refresh_tracker.refresh_status.total_count === null
                ? refresh_tracker.refresh_status.discovered_count
                : Math.max(refresh_tracker.refresh_status.total_count, refresh_tracker.refresh_status.discovered_count),
            new_items_count: created_queue_context.queued_count + created_queue_context.skipped_count,
            queued_count: created_queue_context.queued_count,
            skipped_count: created_queue_context.skipped_count,
            error: null
        });
        await maybePersistSubscriptionRefreshStatus(refresh_tracker, true);
    }

    return created_queue_context;
}

async function updateSubscriptionRefreshTrackerQueueCounts(refresh_tracker, queue_context = null, force = false) {
    if (!refresh_tracker || !refresh_tracker.refresh_status || !queue_context) return false;

    const queued_count = asFiniteCount(queue_context.queued_count, 0);
    const skipped_count = asFiniteCount(queue_context.skipped_count, 0);
    const new_items_count = queued_count + skipped_count;
    const should_update = force
        || refresh_tracker.refresh_status.queued_count !== queued_count
        || refresh_tracker.refresh_status.skipped_count !== skipped_count
        || refresh_tracker.refresh_status.new_items_count !== new_items_count;

    if (!should_update) return false;

    refresh_tracker.refresh_status.queued_count = queued_count;
    refresh_tracker.refresh_status.skipped_count = skipped_count;
    refresh_tracker.refresh_status.new_items_count = new_items_count;
    return await maybePersistSubscriptionRefreshStatus(refresh_tracker, force);
}

async function removeArchivedPendingSubscriptionDownloads(sub, pending_downloads = null) {
    if (!sub || !sub.id) return 0;

    const effective_pending_downloads = Array.isArray(pending_downloads)
        ? pending_downloads
        : await db_api.getRecords('download_queue', {sub_id: sub.id, finished: false});
    if (effective_pending_downloads.length === 0) return 0;

    const archive_items = await db_api.getRecords('archives', getSubscriptionArchiveFilter(sub));
    const archived_output_keys = new Set(
        archive_items
            .map(archive_item => getArchiveKey(archive_item.extractor, archive_item.id))
            .filter(Boolean)
    );
    if (archived_output_keys.size === 0) return 0;

    let removed_count = 0;

    for (const pending_download of effective_pending_downloads) {
        if (!pending_download || pending_download.finished) continue;

        const pending_archive_key = getSubscriptionDownloadArchiveKey(pending_download, pending_download.type || sub.type);
        if (!pending_archive_key || !archived_output_keys.has(pending_archive_key)) continue;

        if (pending_download.running) {
            await downloader_api.cancelDownload(pending_download.uid).catch(error => {
                logger.warn(`Failed to cancel archived pending subscription download '${pending_download.uid}' before cleanup.`);
                logger.warn(error);
            });
        }

        await db_api.removeRecord('download_queue', {uid: pending_download.uid});
        removed_count += 1;
        logger.info(`Removed archived pending subscription download ${pending_archive_key} from subscription ${sub.id}.`);
    }

    return removed_count;
}

function adjustRefreshStatusAfterPendingCleanup(refresh_status, removed_pending_count = 0, pending_download_count = 0, running_download_count = 0, skipped_download_count = 0) {
    const normalized_refresh_status = normalizeSubscriptionRefreshStatus(refresh_status);
    const normalized_removed_pending_count = asFiniteCount(removed_pending_count, 0);
    const adjusted_skipped_count = Math.max(
        normalized_refresh_status.skipped_count,
        asFiniteCount(skipped_download_count, 0)
    ) + normalized_removed_pending_count;

    if (normalized_removed_pending_count <= 0 && adjusted_skipped_count === normalized_refresh_status.skipped_count) {
        return normalized_refresh_status;
    }

    const adjusted_queued_count = normalized_removed_pending_count > 0
        ? Math.max(0, normalized_refresh_status.queued_count - normalized_removed_pending_count)
        : normalized_refresh_status.queued_count;
    const adjusted_new_items_count = normalized_removed_pending_count > 0 && normalized_refresh_status.new_items_count !== null
        ? Math.max(0, normalized_refresh_status.new_items_count - normalized_removed_pending_count)
        : normalized_refresh_status.new_items_count;
    const should_mark_complete = normalized_refresh_status.phase === SUBSCRIPTION_REFRESH_PHASES.QUEUED
        && pending_download_count === 0
        && running_download_count === 0
        && (adjusted_queued_count === 0 || adjusted_skipped_count >= adjusted_queued_count);

    return normalizeSubscriptionRefreshStatus({
        ...normalized_refresh_status,
        phase: should_mark_complete ? SUBSCRIPTION_REFRESH_PHASES.COMPLETE : normalized_refresh_status.phase,
        new_items_count: adjusted_new_items_count,
        queued_count: adjusted_queued_count,
        skipped_count: adjusted_skipped_count
    });
}

function countSkippedSubscriptionDownloads(downloads = [], refresh_started_at = null) {
    if (!Array.isArray(downloads)) return 0;
    const normalized_refresh_started_at = normalizeNullableCount(refresh_started_at);
    return downloads.filter(download => {
        if (!downloader_api.isSkippableSubscriptionDownloadError(download && download.error, download && download.error_type)) return false;
        const download_started_at = normalizeNullableCount(download && download.timestamp_start);
        return normalized_refresh_started_at === null || download_started_at === null || download_started_at >= normalized_refresh_started_at;
    }).length;
}

async function persistSubscriptionRefreshStatusIfChanged(sub_id, original_refresh_status, refresh_status) {
    const original_normalized_refresh_status = normalizeSubscriptionRefreshStatus(original_refresh_status);
    const next_refresh_status = normalizeSubscriptionRefreshStatus(refresh_status);
    const changed = original_normalized_refresh_status.phase !== next_refresh_status.phase
        || original_normalized_refresh_status.new_items_count !== next_refresh_status.new_items_count
        || original_normalized_refresh_status.queued_count !== next_refresh_status.queued_count
        || original_normalized_refresh_status.skipped_count !== next_refresh_status.skipped_count;
    if (!changed) return false;
    return await persistSubscriptionRefreshStatus(sub_id, next_refresh_status);
}

async function finalizeSubscriptionRefreshSuccess(sub, tracker, queue_context = null) {
    if (!tracker) return 0;

    const queued_count = queue_context ? queue_context.queued_count : 0;
    const skipped_count = queue_context ? asFiniteCount(queue_context.skipped_count, 0) : tracker.refresh_status.skipped_count;
    const discovered_count = tracker.refresh_status.discovered_count;
    tracker.refresh_status = normalizeSubscriptionRefreshStatus({
        ...tracker.refresh_status,
        active: false,
        phase: queued_count > 0 ? SUBSCRIPTION_REFRESH_PHASES.QUEUED : SUBSCRIPTION_REFRESH_PHASES.COMPLETE,
        total_count: tracker.refresh_status.total_count === null
            ? discovered_count
            : Math.max(tracker.refresh_status.total_count, discovered_count),
        new_items_count: queued_count + skipped_count,
        queued_count: queued_count,
        skipped_count: skipped_count,
        latest_item_title: null,
        completed_at: Date.now(),
        error: null
    });

    active_subscription_refresh_trackers.delete(sub.id);
    await maybePersistSubscriptionRefreshStatus(tracker, true);
    return queued_count;
}

function createSubscriptionRefreshStreamProcessor(sub, user_uid, refresh_tracker, discovery_filter_context = null) {
    const stream_state = {
        pending_output_batch: [],
        queue_context: null,
        flush_promise: Promise.resolve(),
        flush_error: null
    };

    const flushOutputBatch = async (output_batch = []) => {
        if (stream_state.flush_error || isSubscriptionRefreshCancelled(refresh_tracker)) return stream_state.queue_context;
        stream_state.queue_context = await handleOutputJSON(output_batch, sub, user_uid, refresh_tracker, stream_state.queue_context, discovery_filter_context);
        return stream_state.queue_context;
    };

    const scheduleBatchFlush = (force = false) => {
        if (stream_state.flush_error || isSubscriptionRefreshCancelled(refresh_tracker)) {
            if (isSubscriptionRefreshCancelled(refresh_tracker)) {
                stream_state.pending_output_batch = [];
            }
            return stream_state.flush_promise;
        }

        while (stream_state.pending_output_batch.length >= SUBSCRIPTION_QUEUE_BATCH_SIZE || (force && stream_state.pending_output_batch.length > 0)) {
            const batch_size = force ? stream_state.pending_output_batch.length : SUBSCRIPTION_QUEUE_BATCH_SIZE;
            const output_batch = stream_state.pending_output_batch.splice(0, batch_size);

            stream_state.flush_promise = stream_state.flush_promise
                .then(async () => {
                    if (stream_state.flush_error || isSubscriptionRefreshCancelled(refresh_tracker)) return;
                    await flushOutputBatch(output_batch);
                })
                .catch(error => {
                    stream_state.flush_error = error;
                });

            if (!force) break;
        }

        return stream_state.flush_promise;
    };

    return {
        ingestLine(output_line = '') {
            if (stream_state.flush_error || isSubscriptionRefreshCancelled(refresh_tracker)) return;
            const output_json = updateSubscriptionRefreshTrackerFromLine(refresh_tracker, output_line);
            if (!output_json) return;

            stream_state.pending_output_batch.push(output_json);
            if (stream_state.pending_output_batch.length >= SUBSCRIPTION_QUEUE_BATCH_SIZE) {
                scheduleBatchFlush();
            }
        },
        async finalize(process_error = null) {
            if (isSubscriptionRefreshCancelled(refresh_tracker)) {
                stream_state.pending_output_batch = [];
                await stream_state.flush_promise;
                return stream_state.queue_context ? stream_state.queue_context.queued_count : 0;
            }

            await scheduleBatchFlush(true);
            await stream_state.flush_promise;
            if (stream_state.flush_error) throw stream_state.flush_error;

            const queued_count = stream_state.queue_context ? stream_state.queue_context.queued_count : 0;
            const discovered_count = refresh_tracker && refresh_tracker.refresh_status
                ? refresh_tracker.refresh_status.discovered_count
                : 0;
            const has_streamed_results = discovered_count > 0 || queued_count > 0;

            if (process_error && !has_streamed_results) {
                logger.error('Subscription check failed!');
                logger.error(process_error);
                await finalizeSubscriptionRefreshWithError(sub.id, refresh_tracker, process_error ? process_error.toString() : 'Subscription check failed.');
                return null;
            }

            if (process_error) {
                logger.warn(`Subscription discovery for '${sub.name}' exited early after streaming ${discovered_count} entries. Queueing the streamed results.`);
                logger.debug(process_error);
            }

            return await finalizeSubscriptionRefreshSuccess(sub, refresh_tracker, stream_state.queue_context);
        }
    };
}

function getSubscriptionPrefetchedInfoForDownload(file_to_download = null) {
    if (!file_to_download || typeof file_to_download !== 'object') return null;
    if (!file_to_download['_filename']) return null;
    return [file_to_download];
}

exports.subscribe = async (sub, user_uid = null, skip_get_info = false) => {
    const result_obj = {
        success: false,
        error: ''
    };
    return new Promise(async resolve => {
        normalizeSubscriptionStorageOptions(sub);
        // sub should just have url and name. here we will get isPlaylist and path
        sub.isPlaylist = sub.isPlaylist || sub.url.includes('playlist');
        sub.videos = [];

        let url_exists = !!(await db_api.getRecord('subscriptions', {url: sub.url, user_uid: user_uid}));

        if (!sub.name && url_exists) {
            logger.error(`Sub with the same URL "${sub.url}" already exists -- please provide a custom name for this new subscription.`);
            result_obj.error = 'Subcription with URL ' + sub.url + ' already exists! Custom name is required.';
            resolve(result_obj);
            return;
        }

        sub['user_uid'] = user_uid ? user_uid : undefined;
        await db_api.insertRecordIntoTable('subscriptions', JSON.parse(JSON.stringify(sub)));

        let success = skip_get_info ? true : await getSubscriptionInfo(sub);
        exports.writeSubscriptionMetadata(sub);

        if (success) {
            if (!sub.paused) exports.getVideosForSub(sub.id);
        } else {
            logger.error('Subscribe: Failed to get subscription info. Subscribe failed.')
        }

        result_obj.success = success;
        result_obj.sub = sub;
        resolve(result_obj);
    });

}

async function getSubscriptionInfo(sub) {
    // get videos
    let downloadConfig = ['--dump-json'];
    downloadConfig = applyCustomArgs(downloadConfig, config_api.getConfigItem('ytdl_custom_args'));
    downloadConfig = applyCustomArgs(downloadConfig, sub.custom_args);
    downloadConfig = utils.injectArgs(downloadConfig, ['--playlist-end', '1']);
    let useCookies = config_api.getConfigItem('ytdl_use_cookies');
    if (useCookies) {
        if (await fs.pathExists(path.join(__dirname, 'appdata', 'cookies.txt'))) {
            downloadConfig.push('--cookies', path.join('appdata', 'cookies.txt'));
        } else {
            logger.warn('Cookies file could not be found. You can either upload one, or disable \'use cookies\' in the Advanced tab in the settings.');
        }
    }

    // Note: yt-dlp-ejs is installed via pip and will be automatically detected
    // No --remote-components flag needed (would conflict with Deno's --no-remote flag)

    let {callback} = await youtubedl_api.runYoutubeDL(sub.url, downloadConfig);
    const {parsed_output, err} = await callback;
    if (err) {
        logger.error(`Subscribe: failed to retrieve info for subscription ${sub.id}: ${describeSubscriptionInfoError(err)}`);
        return false;
    }
    if (!Array.isArray(parsed_output) || parsed_output.length === 0) {
        logger.error(`Subscribe: failed to retrieve info for subscription ${sub.id}: ${describeSubscriptionInfoError(err)}`);
        return false;
    }
    logger.verbose('Subscribe: got info for subscription ' + sub.id);
    for (const output_json of parsed_output) {
        if (!output_json) {
            continue;
        }

        if (!sub.name) {
            if (sub.isPlaylist) {
                sub.name = output_json.playlist_title ? output_json.playlist_title : output_json.playlist;
            } else {
                sub.name = output_json.uploader;
            }
            // if it's now valid, update
            if (sub.name) {
                let sub_name = sub.name;
                const sub_name_exists = await db_api.getRecord('subscriptions', {name: sub.name, isPlaylist: sub.isPlaylist, user_uid: sub.user_uid});
                if (sub_name_exists) sub_name += ` - ${sub.id}`;
                await db_api.updateRecord('subscriptions', {id: sub.id}, {name: sub_name});
            }
        }

        return true;
    }

    return false;
}

exports.unsubscribe = async (sub_id, deleteMode, user_uid = null) => {
    const sub = await exports.getSubscription(sub_id, user_uid);
    if (!sub) {
        return {
            success: false,
            error: 'Subscription not found or not owned by the current user.'
        };
    }
    let basePath = getSubscriptionsBasePathForSub(sub, user_uid);

    let id = sub.id;

    const sub_files = await db_api.getRecords('files', {sub_id: id});
    for (let i = 0; i < sub_files.length; i++) {
        const sub_file = sub_files[i];
        if (config_api.descriptors[sub_file['uid']]) {
            try {
                for (let i = 0; i < config_api.descriptors[sub_file['uid']].length; i++) {
                    config_api.descriptors[sub_file['uid']][i].destroy();
                }
            } catch(e) {
                continue;
            }
        }
    }

    await killSubDownloads(sub_id, true);

    if (deleteMode && !utils.usesSubscriptionSubfolder(sub)) {
        for (const sub_file of sub_files) {
            await files_api.deleteFile(sub_file.uid, false, user_uid);
        }
    }

    const remove_sub_filter = {id: id};
    if (shouldRestrictToUser(user_uid)) remove_sub_filter['user_uid'] = user_uid;
    await db_api.removeRecord('subscriptions', remove_sub_filter);
    await db_api.removeAllRecords('files', {sub_id: id, ...(shouldRestrictToUser(user_uid) ? {user_uid: user_uid} : {})});

    // failed subs have no name, on unsubscribe they shouldn't error
    if (!sub.name) {
        return {success: true};
    }

    const appendedBasePath = getAppendedBasePath(sub, basePath);
    if (deleteMode && utils.usesSubscriptionSubfolder(sub) && (await fs.pathExists(appendedBasePath))) {
        await fs.remove(appendedBasePath);
    }
    if (deleteMode && !utils.usesSubscriptionSubfolder(sub)) {
        const metadataBasePath = getSubscriptionMetadataBasePath(sub, basePath);
        if (await fs.pathExists(metadataBasePath)) await fs.remove(metadataBasePath);
        await cleanupEmptyDirectory(path.dirname(metadataBasePath), utils.getSubscriptionTypePath(sub, basePath));
    }

    await db_api.removeAllRecords('archives', {sub_id: sub.id, ...(shouldRestrictToUser(user_uid) ? {user_uid: user_uid} : {})});
    return {success: true};
}

exports.deleteSubscriptionFile = async (sub, file, deleteForever, file_uid = null, user_uid = null) => {
    if (typeof sub === 'string') {
        // TODO: fix bad workaround where sub is a sub_id
        sub = await db_api.getRecord('subscriptions', {sub_id: sub});
    }
    // TODO: combine this with deletefile
    let basePath = getSubscriptionsBasePathForSub(sub, user_uid);
    const appendedBasePath = getAppendedBasePath(sub, basePath);
    const name = file;
    let retrievedID = null;
    let retrievedExtractor = null;

    await db_api.removeRecord('files', {uid: file_uid});

    let filePath = appendedBasePath;
    const ext = (sub.type && sub.type === 'audio') ? '.mp3' : '.mp4'
    var jsonPath = path.join(__dirname,filePath,name+'.info.json');
    var videoFilePath = path.join(__dirname,filePath,name+ext);
    var imageFilePath = path.join(__dirname,filePath,name+'.jpg');
    var altImageFilePath = path.join(__dirname,filePath,name+'.webp');

    const [jsonExists, videoFileExists, imageFileExists, altImageFileExists] = await Promise.all([
        fs.pathExists(jsonPath),
        fs.pathExists(videoFilePath),
        fs.pathExists(imageFilePath),
        fs.pathExists(altImageFilePath),
    ]);

    if (jsonExists) {
        const info_json = fs.readJSONSync(jsonPath);
        retrievedID = info_json['id'];
        retrievedExtractor = info_json['extractor'];
        await fs.unlink(jsonPath);
    }

    if (imageFileExists) {
        await fs.unlink(imageFilePath);
    }

    if (altImageFileExists) {
        await fs.unlink(altImageFilePath);
    }

    if (videoFileExists) {
        await fs.unlink(videoFilePath);
        if ((await fs.pathExists(jsonPath)) || (await fs.pathExists(videoFilePath))) {
            return false;
        } else {
            // check if the user wants the video to be redownloaded (deleteForever === false)
            if (deleteForever) {
                // ensure video is in the archives
                const exists_in_archive = await archive_api.existsInArchive(retrievedExtractor, retrievedID, sub.type, user_uid, sub.id);
                if (!exists_in_archive) {
                    await archive_api.addToArchive(retrievedExtractor, retrievedID, sub.type, file.title, user_uid, sub.id);
                }
            } else {
                await archive_api.removeFromArchive(retrievedExtractor, retrievedID, sub.type, user_uid, sub.id);
            }
            return true;
        }
    } else {
        // TODO: tell user that the file didn't exist
        return true;
    }
}

exports.redownloadSubscription = async (sub_id, user_uid = null) => {
    const sub = await exports.getSubscription(sub_id, user_uid);
    if (!sub) {
        return {
            success: false,
            error: 'Subscription not found or not owned by the current user.'
        };
    }

    if (sub['downloading'] || sub['child_process'] || sub['refresh_status']?.active) {
        await exports.cancelCheckSubscription(sub.id, user_uid);
    }
    await killSubDownloads(sub.id, true);

    const sub_files_filter = {sub_id: sub.id};
    if (shouldRestrictToUser(user_uid)) sub_files_filter['user_uid'] = user_uid;
    const sub_files = await db_api.getRecords('files', sub_files_filter);

    let deleted_count = 0;
    let failed_count = 0;
    for (const sub_file of sub_files) {
        try {
            const deleted = await files_api.deleteFile(sub_file.uid, false, user_uid);
            if (deleted) {
                deleted_count += 1;
            } else {
                failed_count += 1;
            }
        } catch (e) {
            failed_count += 1;
            logger.error(`Failed to delete subscription file '${sub_file.uid}' before redownload.`);
            logger.error(e);
        }
    }

    if (failed_count > 0) {
        return {
            success: false,
            deleted_count: deleted_count,
            failed_count: failed_count,
            refresh_started: false,
            error: `Failed to delete ${failed_count} subscription file${failed_count === 1 ? '' : 's'} before redownload.`
        };
    }

    const refresh_started = await exports.getVideosForSub(sub.id, user_uid);
    const result = {
        success: refresh_started,
        deleted_count: deleted_count,
        failed_count: failed_count,
        refresh_started: refresh_started
    };
    if (!refresh_started) result.error = 'Failed to start subscription refresh.';
    return result;
}

exports.checkSubscriptions = async () => {
    if (!config_api.getConfigItem('ytdl_allow_subscriptions')) {
        logger.info('Skipping subscription check as subscriptions are disabled.');
        return {
            success: true,
            checked: false,
            checked_count: 0,
            skipped_count: 0,
            reason: 'subscriptions_disabled'
        };
    }

    const subscription_ids = await getValidSubscriptionsToCheck();
    if (!subscription_ids || subscription_ids.length === 0) {
        logger.info('Skipping subscription check as no valid subscriptions exist.');
        return {
            success: true,
            checked: false,
            checked_count: 0,
            skipped_count: 0,
            reason: 'no_valid_subscriptions'
        };
    }

    const checked_sub_ids = [];
    const skipped_sub_ids = [];
    for (const sub_id of subscription_ids) {
        const started = await checkSubscription(sub_id);
        if (started === false) {
            skipped_sub_ids.push(sub_id);
        } else {
            checked_sub_ids.push(sub_id);
        }
    }

    return {
        success: true,
        checked: checked_sub_ids.length > 0,
        checked_count: checked_sub_ids.length,
        skipped_count: skipped_sub_ids.length,
        sub_ids: checked_sub_ids,
        skipped_sub_ids: skipped_sub_ids
    };
}

async function checkSubscription(sub_id) {
    let sub = await exports.getSubscription(sub_id);

    if (!sub) {
        logger.verbose(`Subscription: skipped check for missing subscription with uid ${sub_id}.`);
        return false;
    }

    // don't check the sub if the last check for the same subscription has not completed
    if (sub.downloading) {
        logger.verbose(`Subscription: skipped checking ${sub.name} as it's downloading videos.`);
        return false;
    }

    if (!sub.name) {
        logger.verbose(`Subscription: skipped check for subscription with uid ${sub.id} as name has not been retrieved yet.`);
        return false;
    }

    return await exports.getVideosForSub(sub.id);
}

async function getValidSubscriptionsToCheck() {
    const subscriptions = await exports.getAllSubscriptions();

    if (!subscriptions) return;

    // auto pause deprecated streamingOnly mode
    const streaming_only_subs = subscriptions.filter(sub => sub.streamingOnly);
    exports.updateSubscriptionPropertyMultiple(streaming_only_subs, {paused: true});

    const valid_subscription_ids = subscriptions.filter(sub => !sub.paused && !sub.streamingOnly).map(sub => sub.id);
    return valid_subscription_ids;
}

exports.getVideosForSub = async (sub_id, user_uid = null) => {
    const sub = await exports.getSubscription(sub_id, user_uid);
    if (!sub || sub['downloading']) {
        return false;
    }

    _getVideosForSub(sub);
    return true;
}

async function _getVideosForSub(sub) {
    const user_uid = sub['user_uid'];
    const refresh_tracker = createSubscriptionRefreshTracker(sub);
    await Promise.all([
        updateSubscriptionProperty(sub, {downloading: true}, user_uid),
        maybePersistSubscriptionRefreshStatus(refresh_tracker, true)
    ]);

    // get basePath
    let basePath = getSubscriptionsBasePathForSub(sub, user_uid);

    let appendedBasePath = getAppendedBasePath(sub, basePath);
    fs.ensureDirSync(appendedBasePath);

    const downloadConfig = await generateArgsForSubscriptionDiscovery(sub, user_uid);
    const discovery_filter_context = {
        match_filters: collectMatchFiltersFromArgs(downloadConfig)
    };
    const discoveryDownloadConfig = filterSubscriptionDiscoveryAvailabilityMatchFilters(downloadConfig);

    // get videos
    logger.verbose(`Subscription: getting list of videos to download for ${sub.name} with args: ${utils.redactCommandArgsForLogging(discoveryDownloadConfig).join(',')}`);

    const refresh_stream_processor = createSubscriptionRefreshStreamProcessor(sub, user_uid, refresh_tracker, discovery_filter_context);
    let {child_process, callback} = await youtubedl_api.runYoutubeDLLineStream(sub.url, discoveryDownloadConfig, {
        onStdoutLine: (line) => refresh_stream_processor.ingestLine(line),
        onStderrLine: (line) => refresh_stream_processor.ingestLine(line)
    });
    await updateSubscriptionProperty(sub, {child_process: child_process}, user_uid);
    try {
        const {err} = await callback;
        const queued_count = await refresh_stream_processor.finalize(err);
        logger.verbose('Subscription: finished check for ' + sub.name);
        return queued_count;
    } catch (e) {
        if (!isSubscriptionRefreshCancelled(refresh_tracker)) {
            logger.error(`Failed to queue downloads for subscription '${sub.name}'.`);
            logger.error(e);
            await finalizeSubscriptionRefreshWithError(sub.id, refresh_tracker, e ? e.toString() : 'Failed to queue subscription downloads.');
        }
        return null;
    } finally {
        // remove temporary archive file if it exists
        const archive_path = getSubscriptionTemporaryArchivePath(sub, basePath);
        const archive_exists = await fs.pathExists(archive_path);
        if (archive_exists) {
            await fs.unlink(archive_path);
        }

        const current_refresh_tracker = active_subscription_refresh_trackers.get(sub.id);
        if (!current_refresh_tracker || current_refresh_tracker === refresh_tracker) {
            await updateSubscriptionProperty(sub, {downloading: false, child_process: null}, user_uid);
        }
    }
}

async function handleOutputJSON(output_jsons, sub, user_uid, refresh_tracker = null, queue_context = null, discovery_filter_context = null) {
    const filtered_output_jsons = Array.isArray(output_jsons)
        ? output_jsons.filter(output_json => !!output_json && typeof output_json === 'object')
        : [];
    if (filtered_output_jsons.length === 0) {
        return queue_context;
    }

    const effective_queue_context = await ensureSubscriptionRefreshQueueContext(sub, user_uid, refresh_tracker, queue_context);
    const files_to_download = await getFilesToDownload(sub, filtered_output_jsons, effective_queue_context.download_context, discovery_filter_context, effective_queue_context);
    await updateSubscriptionRefreshTrackerQueueCounts(refresh_tracker, effective_queue_context);

    for (const file_to_download of files_to_download) {
        const prefetched_info = getSubscriptionPrefetchedInfoForDownload(file_to_download);
        if (prefetched_info && Array.isArray(file_to_download['formats'])) {
            // Keep subscription queue payloads small when full info is available.
            file_to_download['formats'] = utils.stripPropertiesFromObject(file_to_download['formats'], ['format_id', 'filesize', 'filesize_approx']);
        }
        await downloader_api.createDownload(file_to_download['webpage_url'], sub.type || 'video', effective_queue_context.base_download_options, user_uid, sub.id, sub.name, prefetched_info);
        effective_queue_context.queued_count += 1;
        await updateSubscriptionRefreshTrackerQueueCounts(refresh_tracker, effective_queue_context);
    }

    return effective_queue_context;
}

exports.generateOptionsForSubscriptionDownload = (sub, user_uid) => {
    let basePath = getSubscriptionsBasePathForSub(sub, user_uid);

    let default_output = config_api.getConfigItem('ytdl_default_file_output') ? config_api.getConfigItem('ytdl_default_file_output') : '%(title)s';

    const base_download_options = {
        maxHeight: sub.maxQuality && sub.maxQuality !== 'best' ? sub.maxQuality : null,
        customFileFolderPath: getAppendedBasePath(sub, basePath),
        customOutput: sub.custom_output ? `${sub.custom_output}` : `${default_output}`,
        customArchivePath: path.join(basePath, 'archives', utils.getSubscriptionPathName(sub)),
        additionalArgs: sub.custom_args
    }

    return base_download_options;
}

async function generateArgsForSubscription(sub, user_uid, redownload = false, desired_path = null) {
    // get basePath
    let basePath = getSubscriptionsBasePathForSub(sub, user_uid);

    let appendedBasePath = getAppendedBasePath(sub, basePath);

    const file_output = config_api.getConfigItem('ytdl_default_file_output') ? config_api.getConfigItem('ytdl_default_file_output') : '%(title)s';

    let fullOutput = `"${appendedBasePath}/${file_output}.%(ext)s"`;
    if (desired_path) {
        fullOutput = `"${desired_path}.%(ext)s"`;
    } else if (sub.custom_output) {
        fullOutput = `"${appendedBasePath}/${sub.custom_output}.%(ext)s"`;
    }

    let downloadConfig = ['--dump-json', '-o', fullOutput, !redownload ? '-ciw' : '-ci', '--write-info-json', '--print-json'];

    let qualityPath = null;
    if (sub.type && sub.type === 'audio') {
        qualityPath = ['-f', 'bestaudio']
        qualityPath.push('-x');
        qualityPath.push('--audio-format', 'mp3');
    } else {
        if (!sub.maxQuality || sub.maxQuality === 'best') qualityPath = ['-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4'];
        else qualityPath = ['-f', `bestvideo[height<=${sub.maxQuality}]+bestaudio/best[height<=${sub.maxQuality}]`, '--merge-output-format', 'mp4'];
    }

    downloadConfig.push(...qualityPath)

    // skip videos that are in the archive. otherwise sub download can be permanently slow (vs. just the first time)
    const archive_text = await archive_api.generateArchive(sub.type, sub.user_uid, sub.id);
    const archive_count = archive_text.split('\n').length - 1;
    if (archive_count > 0) {
        logger.verbose(`Generating temporary archive file for subscription ${sub.name} with ${archive_count} entries.`)
        const archive_path = getSubscriptionTemporaryArchivePath(sub, basePath);
        await fs.ensureDir(path.dirname(archive_path));
        await fs.writeFile(archive_path, archive_text);
        downloadConfig.push('--download-archive', archive_path);
    }

    downloadConfig = applyCustomArgs(downloadConfig, config_api.getConfigItem('ytdl_custom_args'));
    downloadConfig = applyCustomArgs(downloadConfig, sub.custom_args);

    const default_downloader = config_api.getConfigItem('ytdl_default_downloader');
    downloadConfig = downloader_api.appendFilenameSanitizationArgs(downloadConfig, default_downloader);

    if (sub.timerange && !redownload) {
        downloadConfig.push('--dateafter', sub.timerange);
    }

    let useCookies = config_api.getConfigItem('ytdl_use_cookies');
    if (useCookies) {
        if (await fs.pathExists(path.join(__dirname, 'appdata', 'cookies.txt'))) {
            downloadConfig.push('--cookies', path.join('appdata', 'cookies.txt'));
        } else {
            logger.warn('Cookies file could not be found. You can either upload one, or disable \'use cookies\' in the Advanced tab in the settings.');
        }
    }

    if (config_api.getConfigItem('ytdl_include_thumbnail')) {
        downloadConfig.push('--write-thumbnail');
    }

    const rate_limit = config_api.getConfigItem('ytdl_download_rate_limit');
    if (rate_limit && downloadConfig.indexOf('-r') === -1 && downloadConfig.indexOf('--limit-rate') === -1) {
        downloadConfig.push('-r', rate_limit);
    }

    if (default_downloader === 'yt-dlp') {
        downloadConfig.push('--no-clean-info-json');
        // Note: yt-dlp-ejs is installed via pip and will be automatically detected
        // No --remote-components flag needed (would conflict with Deno's --no-remote flag)
    }

    downloadConfig = utils.filterArgs(downloadConfig, ['--write-comments']);

    return downloadConfig;
}

function hasSubscriptionDiscoveryDateFilter(args = []) {
    if (!Array.isArray(args)) return false;
    return args.some(arg => typeof arg === 'string'
        && (arg === '--date'
            || arg.startsWith('--date=')
            || arg === '--dateafter'
            || arg.startsWith('--dateafter=')
            || arg === '--datebefore'
            || arg.startsWith('--datebefore=')));
}

function filterSubscriptionDiscoveryArgs(args = [], options = {}) {
    if (!Array.isArray(args)) return [];

    const args_without_discovery_side_effects = [];
    const preserve_download_shaping_args = !!options.preserve_download_shaping_args;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg) continue;

        if (arg === '-o' || arg === '-f' || arg === '-S' || arg === '--audio-format' || arg === '--audio-quality' || arg === '--merge-output-format') {
            if (preserve_download_shaping_args) {
                args_without_discovery_side_effects.push(arg);
                if (i + 1 < args.length) args_without_discovery_side_effects.push(args[++i]);
            } else {
                i += 1;
            }
            continue;
        }

        if (arg === '--replace-in-metadata') {
            if (preserve_download_shaping_args) {
                args_without_discovery_side_effects.push(arg);
                for (let j = 0; j < 3 && i + 1 < args.length; j++) {
                    args_without_discovery_side_effects.push(args[++i]);
                }
            } else {
                i += 3;
            }
            continue;
        }

        const stripped_flag_args = [
            '--dump-json',
            '--print-json',
            '--write-info-json',
            '--write-thumbnail',
            '--write-all-thumbnails',
            '--write-description',
            '--write-comments',
            '--write-annotations',
            '--write-subs',
            '--write-auto-subs',
            '--all-subs',
            '--embed-subs',
            '--embed-thumbnail',
            '--add-metadata',
            '--xattrs',
            '--no-clean-info-json',
            ...(preserve_download_shaping_args ? [] : ['-x', '--windows-filenames', '--restrict-filenames'])
        ];
        if (stripped_flag_args.includes(arg)) {
            continue;
        }

        args_without_discovery_side_effects.push(arg);
    }

    return args_without_discovery_side_effects;
}

async function generateArgsForSubscriptionDiscovery(sub, user_uid) {
    const download_args = await generateArgsForSubscription(sub, user_uid);
    // Flat playlist entries often lack upload dates, so yt-dlp cannot reliably
    // apply date filters until it fetches full entry metadata.
    const should_use_full_metadata = hasSubscriptionDiscoveryDateFilter(download_args);
    const discovery_args = filterSubscriptionDiscoveryArgs(download_args, {
        preserve_download_shaping_args: should_use_full_metadata
    });

    return [
        ...discovery_args,
        ...(should_use_full_metadata ? [] : ['--flat-playlist']),
        '--dump-json'
    ];
}

async function createSubscriptionDownloadContext(sub) {
    const [existing_sub_files, pending_sub_downloads, archive_items] = await Promise.all([
        db_api.getRecords('files', {sub_id: sub.id}),
        db_api.getRecords('download_queue', {sub_id: sub.id, error: null, finished: false}),
        db_api.getRecords('archives', getSubscriptionArchiveFilter(sub))
    ]);
    const archived_output_keys = new Set(
        archive_items
            .map(archive_item => getArchiveKey(archive_item.extractor, archive_item.id))
            .filter(Boolean)
    );
    const active_pending_sub_downloads = [];

    for (const pending_download of pending_sub_downloads) {
        const pending_archive_key = getSubscriptionDownloadArchiveKey(pending_download, pending_download.type || sub.type);
        if (pending_archive_key && archived_output_keys.has(pending_archive_key)) {
            if (pending_download.running) {
                await downloader_api.cancelDownload(pending_download.uid).catch(error => {
                    logger.warn(`Failed to cancel archived pending subscription download '${pending_download.uid}' before cleanup.`);
                    logger.warn(error);
                });
            }
            await db_api.removeRecord('download_queue', {uid: pending_download.uid});
            logger.info(`Removed archived pending subscription download ${pending_archive_key} from subscription ${sub.id}.`);
            continue;
        }

        active_pending_sub_downloads.push(pending_download);
    }

    return {
        urls_with_existing_files: new Set(existing_sub_files.map(file => file.url)),
        paths_with_existing_files: new Set(existing_sub_files.map(file => file.path)),
        source_keys_with_existing_files: new Set(existing_sub_files.map(file => getSubscriptionFileArchiveKey(file, sub.type)).filter(Boolean)),
        urls_with_pending_downloads: new Set(active_pending_sub_downloads.map(download => download.url)),
        source_keys_with_pending_downloads: new Set(active_pending_sub_downloads.map(download => getSubscriptionDownloadArchiveKey(download, download.type || sub.type)).filter(Boolean)),
        archived_output_keys: archived_output_keys
    };
}

async function getFilesToDownload(sub, output_jsons, download_context = null, discovery_filter_context = null, skip_context = null) {
    const files_to_download = [];
    const effective_download_context = download_context || await createSubscriptionDownloadContext(sub);
    const {
        urls_with_existing_files = new Set(),
        paths_with_existing_files = new Set(),
        source_keys_with_existing_files = new Set(),
        urls_with_pending_downloads = new Set(),
        source_keys_with_pending_downloads = new Set(),
        archived_output_keys = new Set()
    } = effective_download_context;

    for (let i = 0; i < output_jsons.length; i++) {
        const output_json = output_jsons[i];
        if (!output_json || !output_json['webpage_url']) continue;

        if (await shouldSkipSubscriptionOutput(output_json, sub, discovery_filter_context, skip_context)) continue;

        const output_url = output_json['webpage_url'];
        const output_path = output_json['_filename'];
        const output_archive_key = getSubscriptionOutputArchiveKey(output_json, sub.type);

        if (output_archive_key && archived_output_keys.has(output_archive_key)) continue;

        const file_missing = !urls_with_existing_files.has(output_url)
            && !urls_with_pending_downloads.has(output_url)
            && (!output_archive_key || !source_keys_with_existing_files.has(output_archive_key))
            && (!output_archive_key || !source_keys_with_pending_downloads.has(output_archive_key));
        if (!file_missing) continue;

        if (output_path && paths_with_existing_files.has(output_path)) {
            // or maybe just overwrite???
            logger.info(`Skipping adding file ${output_path} for subscription ${sub.name} as a file with that path already exists.`)
            continue;
        }

        files_to_download.push(output_json);
        urls_with_pending_downloads.add(output_url);
        if (output_archive_key) source_keys_with_pending_downloads.add(output_archive_key);
    }
    return files_to_download;
}

exports.cancelCheckSubscription = async (sub_id, user_uid = null) => {
    const sub = await exports.getSubscription(sub_id, user_uid);
    if (!sub) {
        logger.error('Failed to cancel subscription check, subscription not found.');
        return false;
    }
    if (!sub['downloading'] && !sub['child_process']) {
        logger.error('Failed to cancel subscription check, verify that it is still running!');
        return false;
    }

    // if check is ongoing
    if (sub['child_process']) {
        const child_process = sub['child_process'];
        youtubedl_api.killYoutubeDLProcess(child_process);
    }

    // cancel activate video downloads
    await killSubDownloads(sub_id);
    const refresh_tracker = active_subscription_refresh_trackers.get(sub_id);
    if (refresh_tracker) {
        await finalizeSubscriptionRefreshAsCancelled(sub_id, refresh_tracker);
    } else {
        const refresh_status = normalizeSubscriptionRefreshStatus(sub['refresh_status']);
        if (refresh_status.active || refresh_status.phase === SUBSCRIPTION_REFRESH_PHASES.COLLECTING || refresh_status.phase === SUBSCRIPTION_REFRESH_PHASES.QUEUEING) {
            await persistSubscriptionRefreshStatus(sub_id, {
                ...refresh_status,
                active: false,
                phase: SUBSCRIPTION_REFRESH_PHASES.CANCELLED,
                completed_at: Date.now(),
                error: null
            });
        }
    }
    await updateSubscriptionProperty(sub, {downloading: false, child_process: null}, user_uid);

    return true;
}

async function killSubDownloads(sub_id, remove_downloads = false) {
    const sub_downloads = await db_api.getRecords('download_queue', {sub_id: sub_id});
    for (const sub_download of sub_downloads) {
        if (sub_download['running'])
            await downloader_api.cancelDownload(sub_download['uid']);
        if (remove_downloads)
            await db_api.removeRecord('download_queue', {uid: sub_download['uid']});
    }
}

exports.getSubscriptions = async (user_uid = null) => {
    // TODO: fix issue where the downloading property may not match getSubscription()
    if (!config_api.getConfigItem('ytdl_multi_user_mode')) {
        return await db_api.getRecords('subscriptions');
    }
    return await db_api.getRecords('subscriptions', {user_uid: user_uid});
}

exports.getAllSubscriptions = async () => {
    const all_subs = await db_api.getRecords('subscriptions');
    const multiUserMode = config_api.getConfigItem('ytdl_multi_user_mode');
    if (!multiUserMode) return all_subs;
    return all_subs.filter(sub => !!(sub.user_uid));
}

exports.getSubscription = async (subID, user_uid = null) => {
    // stringify and parse because we may override the 'downloading' property
    const filter_obj = {id: subID};
    if (shouldRestrictToUser(user_uid)) filter_obj['user_uid'] = user_uid;
    const raw_sub = await db_api.getRecord('subscriptions', filter_obj);
    if (!raw_sub) return null;
    const sub = JSON.parse(JSON.stringify(raw_sub));
    const removed_archived_pending_count = await removeArchivedPendingSubscriptionDownloads(sub);
    // now with the download_queue, we may need to override 'downloading'
    const [
        current_downloads,
        pending_download_count,
        running_download_count,
        skipped_downloads
    ] = await Promise.all([
        db_api.getRecords('download_queue', {running: true, sub_id: subID}, true),
        db_api.getRecords('download_queue', {sub_id: subID, finished: false}, true),
        db_api.getRecords('download_queue', {sub_id: subID, running: true, finished: false}, true),
        db_api.getRecords('download_queue', {sub_id: subID, finished: true, error: {$ne: null}})
    ]);
    if (!sub['downloading']) sub['downloading'] = current_downloads > 0;

    const original_refresh_status = normalizeSubscriptionRefreshStatus(sub['refresh_status']);
    const skipped_download_count = countSkippedSubscriptionDownloads(skipped_downloads, original_refresh_status.started_at);
    let refresh_status = normalizeSubscriptionRefreshStatus(original_refresh_status);
    if (!sub['downloading'] && refresh_status.active) {
        refresh_status = buildInterruptedSubscriptionRefreshStatus(refresh_status);
    }
    refresh_status = adjustRefreshStatusAfterPendingCleanup(refresh_status, removed_archived_pending_count, pending_download_count, running_download_count, skipped_download_count);

    if (refresh_status.phase === SUBSCRIPTION_REFRESH_PHASES.IDLE && pending_download_count > 0) {
        refresh_status = normalizeSubscriptionRefreshStatus({
            ...refresh_status,
            phase: SUBSCRIPTION_REFRESH_PHASES.QUEUED,
            queued_count: refresh_status.queued_count || pending_download_count
        });
    }
    await persistSubscriptionRefreshStatusIfChanged(subID, original_refresh_status, refresh_status);

    sub['refresh_status'] = {
        ...refresh_status,
        pending_download_count: pending_download_count,
        running_download_count: running_download_count
    };
    return sub;
}

exports.getSubscriptionByName = async (subName, user_uid = null) => {
    if (!config_api.getConfigItem('ytdl_multi_user_mode')) {
        return await db_api.getRecord('subscriptions', {name: subName});
    }
    return await db_api.getRecord('subscriptions', {name: subName, user_uid: user_uid});
}

function normalizePath(file_path = '') {
    return path.resolve(file_path);
}

function isSamePath(first_path = '', second_path = '') {
    return normalizePath(first_path) === normalizePath(second_path);
}

function isPathInsideOrSame(candidate_path = '', parent_path = '') {
    const normalized_candidate_path = normalizePath(candidate_path);
    const normalized_parent_path = normalizePath(parent_path);
    if (normalized_candidate_path === normalized_parent_path) return true;
    const relative_path = path.relative(normalized_parent_path, normalized_candidate_path);
    return !!relative_path && !relative_path.startsWith('..') && !path.isAbsolute(relative_path);
}

function getDestinationPathForSubscriptionMove(source_path, old_base_path, new_base_path) {
    if (isPathInsideOrSame(new_base_path, old_base_path) && isPathInsideOrSame(source_path, new_base_path)) {
        return source_path;
    }

    if (!isPathInsideOrSame(source_path, old_base_path)) return null;

    const relative_path = path.relative(path.resolve(old_base_path), path.resolve(source_path));
    return path.join(new_base_path, relative_path);
}

async function getExistingSubscriptionMediaPath(file_obj = null, type = 'video') {
    if (!file_obj || !file_obj.path) return null;

    const candidate_paths = [
        file_obj.path,
        utils.getTrueFileName(file_obj.path, type)
    ].filter((candidate_path, index, all_paths) => candidate_path && all_paths.indexOf(candidate_path) === index);

    for (const candidate_path of candidate_paths) {
        if (await fs.pathExists(candidate_path)) return candidate_path;
    }

    return null;
}

async function getSubscriptionSubtitleSidecarPaths(media_path) {
    const subtitle_sidecar_paths = [];
    const media_directory = path.dirname(media_path);
    const media_basename = path.basename(utils.removeFileExtension(media_path)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const subtitle_regex = new RegExp(`^${media_basename}\\.player-subtitles(?:\\.\\d+)?\\.vtt$`);

    let directory_entries = [];
    try {
        directory_entries = await fs.readdir(media_directory);
    } catch (e) {
        return subtitle_sidecar_paths;
    }

    for (const directory_entry of directory_entries) {
        if (subtitle_regex.test(directory_entry)) {
            subtitle_sidecar_paths.push(path.join(media_directory, directory_entry));
        }
    }

    return subtitle_sidecar_paths;
}

async function getExistingSubscriptionSidecarPaths(media_path, type = 'video') {
    const file_path_no_extension = utils.removeFileExtension(media_path);
    const expected_extension = type === 'audio' ? '.mp3' : '.mp4';
    const actual_extension = path.extname(media_path);
    const sidecar_candidates = [
        `${media_path}.info.json`,
        `${file_path_no_extension}.info.json`,
        `${file_path_no_extension}${expected_extension}.info.json`,
        `${file_path_no_extension}.webp`,
        `${file_path_no_extension}.jpg`,
        `${file_path_no_extension}.png`,
        `${file_path_no_extension}.nfo`,
        ...await getSubscriptionSubtitleSidecarPaths(media_path)
    ];

    if (actual_extension && actual_extension !== expected_extension) {
        sidecar_candidates.push(`${file_path_no_extension}${actual_extension}.info.json`);
    }

    const existing_sidecar_paths = [];
    for (const sidecar_candidate of [...new Set(sidecar_candidates)]) {
        if (await fs.pathExists(sidecar_candidate)) existing_sidecar_paths.push(sidecar_candidate);
    }

    return existing_sidecar_paths;
}

function addSubscriptionMovePlanEntry(move_plan, source_path, destination_path) {
    if (!source_path || !destination_path || isSamePath(source_path, destination_path)) return;
    if (move_plan.some(plan_entry => isSamePath(plan_entry.source_path, source_path))) return;

    move_plan.push({
        source_path: source_path,
        destination_path: destination_path
    });
}

async function validateSubscriptionMovePlan(move_plan = [], source_base_path, destination_base_path) {
    const resolved_source_base_path = path.resolve(source_base_path);
    const resolved_destination_base_path = path.resolve(destination_base_path);
    const destination_paths = new Set();
    for (const plan_entry of move_plan) {
        const source_path = path.resolve(plan_entry.source_path);
        const destination_path = path.resolve(plan_entry.destination_path);
        const source_relative_path = path.relative(resolved_source_base_path, source_path);
        const destination_relative_path = path.relative(resolved_destination_base_path, destination_path);

        if (source_relative_path === '..' || source_relative_path.startsWith('..' + path.sep)) {
            logger.error(`Failed to move subscription files. Source is outside the old subscription folder: '${source_path}'.`);
            return false;
        }

        if (path.isAbsolute(source_relative_path)) {
            logger.error(`Failed to move subscription files. Source resolved to an absolute relative path: '${source_path}'.`);
            return false;
        }

        if (destination_relative_path === '..' || destination_relative_path.startsWith('..' + path.sep)) {
            logger.error(`Failed to move subscription files. Destination is outside the new subscription folder: '${destination_path}'.`);
            return false;
        }

        if (path.isAbsolute(destination_relative_path)) {
            logger.error(`Failed to move subscription files. Destination resolved to an absolute relative path: '${destination_path}'.`);
            return false;
        }

        const normalized_destination_path = normalizePath(destination_path);
        if (destination_paths.has(normalized_destination_path)) {
            logger.error(`Failed to move subscription files. Multiple files would move to '${destination_path}'.`);
            return false;
        }
        destination_paths.add(normalized_destination_path);

        if (await fs.pathExists(destination_path)) {
            logger.error(`Failed to move subscription files. Destination already exists: '${destination_path}'.`);
            return false;
        }
    }

    return true;
}

async function applySubscriptionMovePlan(move_plan = [], source_base_path, destination_base_path) {
    const resolved_source_base_path = path.resolve(source_base_path);
    const resolved_destination_base_path = path.resolve(destination_base_path);

    for (const plan_entry of move_plan) {
        const source_path = path.resolve(plan_entry.source_path);
        const destination_path = path.resolve(plan_entry.destination_path);
        const source_relative_path = path.relative(resolved_source_base_path, source_path);
        const destination_relative_path = path.relative(resolved_destination_base_path, destination_path);

        if (source_relative_path === '..' || source_relative_path.startsWith('..' + path.sep)) {
            throw new Error('Subscription file move source path failed validation.');
        }

        if (path.isAbsolute(source_relative_path)) {
            throw new Error('Subscription file move source path failed validation.');
        }

        if (destination_relative_path === '..' || destination_relative_path.startsWith('..' + path.sep)) {
            throw new Error('Subscription file move destination path failed validation.');
        }

        if (path.isAbsolute(destination_relative_path)) {
            throw new Error('Subscription file move path failed validation.');
        }

        await fs.ensureDir(path.dirname(destination_path));
        await fs.move(source_path, destination_path, {overwrite: false});
    }
}

async function cleanupEmptyDirectory(directory_path, stop_path) {
    let current_path = path.resolve(directory_path);
    const resolved_stop_path = path.resolve(stop_path);

    while (current_path !== resolved_stop_path && isPathInsideOrSame(current_path, resolved_stop_path)) {
        let directory_entries = null;
        try {
            directory_entries = await fs.readdir(current_path);
        } catch (e) {
            return;
        }

        if (directory_entries.length > 0) return;
        await fs.remove(current_path);
        current_path = path.dirname(current_path);
    }
}

async function moveSubscriptionFilesForUpdatedPath(current_sub, updated_sub, user_uid = null) {
    const old_base_path = getSubscriptionsBasePathForSub(current_sub, user_uid);
    const new_base_path = getSubscriptionsBasePathForSub(updated_sub, user_uid);
    const old_subscription_type_path = utils.getSubscriptionTypePath(current_sub, old_base_path);
    const new_subscription_type_path = utils.getSubscriptionTypePath(updated_sub, new_base_path);
    const old_download_path = getAppendedBasePath(current_sub, old_base_path);
    const new_download_path = getAppendedBasePath(updated_sub, new_base_path);
    if (isSamePath(old_download_path, new_download_path)) return true;

    const sub_files_filter = {sub_id: current_sub.id};
    if (shouldRestrictToUser(user_uid)) sub_files_filter['user_uid'] = user_uid;
    const sub_files = await db_api.getRecords('files', sub_files_filter);
    const move_plan = [];
    const file_path_updates = {};

    for (const sub_file of sub_files) {
        const file_type = sub_file.isAudio || updated_sub.type === 'audio' ? 'audio' : 'video';
        const media_source_path = await getExistingSubscriptionMediaPath(sub_file, file_type);
        if (!media_source_path) continue;
        if (!isPathInsideOrSame(media_source_path, old_download_path)) {
            logger.warn(`Skipping move for subscription file '${sub_file.uid}' because its path is outside the old subscription folder.`);
            continue;
        }

        const media_destination_path = getDestinationPathForSubscriptionMove(media_source_path, old_download_path, new_download_path);
        addSubscriptionMovePlanEntry(move_plan, media_source_path, media_destination_path);

        if (!isSamePath(media_source_path, media_destination_path)) {
            file_path_updates[sub_file.uid] = {path: media_destination_path};
        }

        const sidecar_paths = await getExistingSubscriptionSidecarPaths(media_source_path, file_type);
        for (const sidecar_path of sidecar_paths) {
            addSubscriptionMovePlanEntry(
                move_plan,
                sidecar_path,
                getDestinationPathForSubscriptionMove(sidecar_path, old_download_path, new_download_path)
            );
        }
    }

    if (!(await validateSubscriptionMovePlan(move_plan, old_subscription_type_path, new_subscription_type_path))) return false;

    try {
        await applySubscriptionMovePlan(move_plan, old_subscription_type_path, new_subscription_type_path);
    } catch (e) {
        logger.error(`Failed to move files for subscription '${current_sub.name}'.`);
        logger.error(e);
        return false;
    }

    await db_api.bulkUpdateRecordsByKey('files', 'uid', file_path_updates);
    return true;
}

async function cleanupSubscriptionPathChange(current_sub, updated_sub, user_uid = null) {
    const old_base_path = getSubscriptionsBasePathForSub(current_sub, user_uid);
    const new_base_path = getSubscriptionsBasePathForSub(updated_sub, user_uid);
    const old_download_path = getAppendedBasePath(current_sub, old_base_path);
    const new_download_path = getAppendedBasePath(updated_sub, new_base_path);
    const old_metadata_path = getSubscriptionMetadataBasePath(current_sub, old_base_path);
    const new_metadata_path = getSubscriptionMetadataBasePath(updated_sub, new_base_path);
    const old_subscription_type_path = utils.getSubscriptionTypePath(current_sub, old_base_path);

    if (!isSamePath(old_metadata_path, new_metadata_path)) {
        await fs.remove(path.join(old_metadata_path, CONSTS.SUBSCRIPTION_BACKUP_PATH));
        await cleanupEmptyDirectory(old_metadata_path, old_subscription_type_path);
    }

    if (!isSamePath(old_download_path, new_download_path)) {
        await cleanupEmptyDirectory(old_download_path, old_subscription_type_path);
    }
}

exports.updateSubscription = async (sub, user_uid = null) => {
    normalizeSubscriptionStorageOptions(sub);
    const filter_obj = {id: sub.id};
    if (shouldRestrictToUser(user_uid)) filter_obj['user_uid'] = user_uid;
    const stored_sub = await db_api.getRecord('subscriptions', filter_obj);
    if (!stored_sub) return false;
    const current_sub = JSON.parse(JSON.stringify(stored_sub));

    normalizeSubscriptionStorageOptions(current_sub);
    const moved_files = await moveSubscriptionFilesForUpdatedPath(current_sub, sub, user_uid);
    if (!moved_files) return false;

    const updated = await db_api.updateRecord('subscriptions', filter_obj, sub);
    if (!updated) return false;
    exports.writeSubscriptionMetadata(sub);
    await cleanupSubscriptionPathChange(current_sub, sub, user_uid);
    return true;
}

exports.updateSubscriptionPropertyMultiple = async (subs, assignment_obj) => {
    subs.forEach(async sub => {
        await updateSubscriptionProperty(sub, assignment_obj);
    });
}

async function updateSubscriptionProperty(sub, assignment_obj) {
    // TODO: combine with updateSubscription
    await db_api.updateRecord('subscriptions', {id: sub.id}, assignment_obj);
    return true;
}

exports.writeSubscriptionMetadata = (sub) => {
    try {
        if (!sub || typeof sub !== 'object') {
            logger.warn('Skipping subscription metadata write for invalid subscription object.');
            return false;
        }

        const subscription_name = typeof sub.name === 'string' ? sub.name.trim() : '';
        if (!subscription_name) {
            logger.warn(`Skipping subscription metadata write for subscription '${sub.id || 'unknown'}' because name is missing.`);
            return false;
        }

        let basePath = getSubscriptionsBasePathForSub(sub);
        if (typeof basePath !== 'string' || basePath.trim() === '') {
            logger.warn(`Skipping subscription metadata write for subscription '${subscription_name}' because the base path is missing.`);
            return false;
        }

        basePath = basePath.trim();
        const metadata_sub = Object.assign({}, sub, {name: subscription_name});
        const appendedBasePath = getSubscriptionMetadataBasePath(metadata_sub, basePath);
        const resolvedBasePath = path.resolve(basePath);
        const resolvedSubscriptionPath = path.resolve(appendedBasePath);
        const relativeSubscriptionPath = path.relative(resolvedBasePath, resolvedSubscriptionPath);
        if (relativeSubscriptionPath.startsWith('..') || path.isAbsolute(relativeSubscriptionPath)) {
            logger.error(`Refusing to write subscription metadata outside subscriptions directory for subscription '${subscription_name}'.`);
            return false;
        }

        const metadata_path = path.resolve(resolvedSubscriptionPath, CONSTS.SUBSCRIPTION_BACKUP_PATH);

        fs.ensureDirSync(resolvedSubscriptionPath);
        fs.writeJSONSync(metadata_path, metadata_sub);
        return true;
    } catch (err) {
        logger.warn(`Skipping subscription metadata write for subscription '${sub && sub.id ? sub.id : 'unknown'}': ${err.message}`);
        return false;
    }
}

async function setFreshUploads(sub) {
    const sub_files = await db_api.getRecords('files', {sub_id: sub.id});
    if (!sub_files) return;
    const current_date = new Date().toISOString().split('T')[0].replace(/-/g, '');
    sub_files.forEach(async file => {
        if (current_date === file['upload_date'].replace(/-/g, '')) {
            // set upload as fresh
            const file_uid = file['uid'];
            await db_api.setVideoProperty(file_uid, {'fresh_upload': true});
        }
    });
}

async function checkVideosForFreshUploads(sub, user_uid) {
    const sub_files = await db_api.getRecords('files', {sub_id: sub.id});
    const current_date = new Date().toISOString().split('T')[0].replace(/-/g, '');
    sub_files.forEach(async file => {
        if (file['fresh_upload'] && current_date > file['upload_date'].replace(/-/g, '')) {
            await checkVideoIfBetterExists(file, sub, user_uid)
        }
    });
}

async function checkVideoIfBetterExists(file_obj, sub, user_uid) {
    const new_path = file_obj['path'].substring(0, file_obj['path'].length - 4);
    const downloadConfig = await generateArgsForSubscription(sub, user_uid, true, new_path);
    logger.verbose(`Checking if a better version of the fresh upload ${file_obj['id']} exists.`);
    // simulate a download to verify that a better version exists
    
    const info = await downloader_api.getVideoInfoByURL(file_obj['url'], downloadConfig);
    if (info && info.length === 1) {
        const metric_to_compare = sub.type === 'audio' ? 'abr' : 'height';
        if (info[metric_to_compare] > file_obj[metric_to_compare]) {
            // download new video as the simulated one is better
            let {callback} = await youtubedl_api.runYoutubeDL(sub.url, downloadConfig);
            const {parsed_output, err} = await callback;
            if (err) {
                logger.verbose(`Failed to download better version of video ${file_obj['id']}`);
            } else if (parsed_output) {
                logger.verbose(`Successfully upgraded video ${file_obj['id']}'s ${metric_to_compare} from ${file_obj[metric_to_compare]} to ${info[metric_to_compare]}`);
                await db_api.setVideoProperty(file_obj['uid'], {[metric_to_compare]: info[metric_to_compare]});
            }
        } 
    }
    await db_api.setVideoProperty(file_obj['uid'], {'fresh_upload': false});
}

// helper functions

function getAppendedBasePath(sub, base_path) {
    return utils.getSubscriptionDownloadPath(sub, base_path);
}
