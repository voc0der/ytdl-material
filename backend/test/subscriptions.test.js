const { assert, path, fs, uuid, db_api, utils, subscriptions_api, archive_api, youtubedl_api, config_api } = require('./test-shared');

describe('Subscriptions', function() {
    const downloader_api = require('../downloader');
    const files_api = require('../files');
    const new_sub = {
        name: 'test_sub',
        url: 'https://www.youtube.com/channel/UCzofo-P8yMMCOv8rsPfIR-g',
        maxQuality: null,
        id: uuid(),
        user_uid: null,
        type: 'video',
        paused: true
    };
    // A check asks the source for the channel's own record before listing its uploads. Tests
    // that do not replace this get an empty record, rather than a real yt-dlp process.
    let original_runYoutubeDL = null;
    beforeEach(async function() {
        original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        youtubedl_api.runYoutubeDL = async () => ({
            child_process: null,
            callback: Promise.resolve({parsed_output: [{}], err: null})
        });
        await db_api.removeAllRecords('subscriptions');
        await db_api.removeAllRecords('download_queue');
        await db_api.removeAllRecords('files');
        await db_api.removeAllRecords('archives');
        await db_api.removeAllRecords('playlists');
        config_api.setConfigItem('ytdl_allow_subscriptions', true);
        config_api.setConfigItem('ytdl_subscriptions_redownload_fresh_uploads', false);
        config_api.setConfigItem('ytdl_custom_args', '');
        config_api.setConfigItem('ytdl_skip_join_only_videos', false);
        config_api.setConfigItem('ytdl_replace_invalid_filename_chars', false);
        config_api.setConfigItem('ytdl_invalid_filename_chars', '\\/:*?"<>|');
        config_api.setConfigItem('ytdl_invalid_filename_replacement', '_');
    });
    afterEach(function() {
        youtubedl_api.runYoutubeDL = original_runYoutubeDL;
    });

    async function waitForCondition(predicate, timeout_ms = 2000) {
        const start = Date.now();
        while ((Date.now() - start) < timeout_ms) {
            if (await predicate()) return true;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return false;
    }
    it('Subscribe', async function () {
        const success = await subscriptions_api.subscribe(new_sub, null, true);
        assert(success);
        const sub_exists = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert(sub_exists);
    });
    it('Applies custom args when retrieving subscription metadata', async function () {
        const original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: null,
            custom_args: '--sleep-interval,,2,,--playlist-end,,250'
        });
        let captured_args = null;

        youtubedl_api.runYoutubeDL = async (requested_url, args) => {
            captured_args = args;
            return {
                callback: Promise.resolve({
                    parsed_output: [{
                        uploader: 'metadata_args_sub',
                        playlist_title: 'metadata_args_sub'
                    }],
                    err: null
                })
            };
        };

        try {
            config_api.setConfigItem('ytdl_custom_args', '--resize-buffer');
            const result = await subscriptions_api.subscribe(sub, null, false);
            assert.strictEqual(result.success, true);
        } finally {
            youtubedl_api.runYoutubeDL = original_runYoutubeDL;
        }

        const sleep_interval_index = captured_args.indexOf('--sleep-interval');
        const playlist_items_index = captured_args.indexOf('--playlist-items');
        assert(captured_args.includes('--resize-buffer'));
        assert(sleep_interval_index !== -1);
        assert.strictEqual(captured_args[sleep_interval_index + 1], '2');
        // The channel's own record, none of its entries: no video is extracted to learn a name.
        assert(captured_args.includes('--dump-single-json'));
        assert(captured_args.includes('--flat-playlist'));
        assert(playlist_items_index !== -1);
        assert.strictEqual(captured_args[playlist_items_index + 1], '0');
        const stored_sub = await db_api.getRecord('subscriptions', {id: sub.id});
        assert.strictEqual(stored_sub.name, 'metadata_args_sub');
    });
    it('Unsubscribe', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        await subscriptions_api.unsubscribe(new_sub);
        const sub_exists = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert(!sub_exists);
    });
    it('Cleans up an automatic playlist when unsubscribing', async function () {
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'unsubscribe_playlist_sub',
            auto_create_playlist: true
        });
        const source_file = {
            uid: uuid(),
            sub_id: sub.id,
            title: 'Subscription file',
            thumbnailURL: 'https://example.com/source.jpg',
            duration: 30,
            registered: 100
        };

        await db_api.insertRecordIntoTable('subscriptions', sub);
        await db_api.insertRecordIntoTable('files', source_file);
        await files_api.syncSubscriptionPlaylist(sub.id);
        assert(await db_api.getRecord('playlists', {source_sub_id: sub.id}));

        const result = await subscriptions_api.unsubscribe(sub.id, true);

        assert.strictEqual(result.success, true);
        assert.strictEqual(await db_api.getRecord('playlists', {source_sub_id: sub.id}), undefined);
    });
    it('Keeps custom playlist entries when unsubscribing from its automatic source', async function () {
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'detach_playlist_sub',
            auto_create_playlist: true
        });
        const source_file = {
            uid: uuid(),
            sub_id: sub.id,
            title: 'Subscription file',
            thumbnailURL: 'https://example.com/source.jpg',
            duration: 30,
            registered: 100
        };
        const custom_file = {
            uid: uuid(),
            title: 'Custom file',
            thumbnailURL: 'https://example.com/custom.jpg',
            duration: 45,
            registered: 200
        };

        await db_api.insertRecordIntoTable('subscriptions', sub);
        await db_api.insertRecordIntoTable('files', source_file);
        await db_api.insertRecordIntoTable('files', custom_file);
        let playlist = await files_api.syncSubscriptionPlaylist(sub.id);
        playlist['uids'].push(custom_file.uid);
        assert.strictEqual(await files_api.updatePlaylist(playlist), true);

        const result = await subscriptions_api.unsubscribe(sub.id, true);

        assert.strictEqual(result.success, true);
        playlist = await db_api.getRecord('playlists', {id: playlist.id});
        assert(playlist);
        assert.deepStrictEqual(playlist.uids, [custom_file.uid]);
        assert.strictEqual(playlist.source_sub_id, undefined);
        assert.strictEqual(playlist.thumbnailURL, custom_file.thumbnailURL);
        assert.strictEqual(playlist.duration, 45);
    });
    it('Does not recreate an automatic playlist when a download finishes during unsubscribe', async function () {
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'concurrent_unsubscribe_sub',
            auto_create_playlist: true
        });
        const source_file = {
            uid: uuid(),
            sub_id: sub.id,
            title: 'Subscription file',
            thumbnailURL: 'https://example.com/source.jpg',
            duration: 30,
            registered: 100
        };
        const original_create_playlist = files_api.createPlaylist;
        let release_create_playlist;
        let signal_create_started;
        const create_started = new Promise(resolve => { signal_create_started = resolve; });
        const create_released = new Promise(resolve => { release_create_playlist = resolve; });

        files_api.createPlaylist = async (...args) => {
            signal_create_started();
            await create_released;
            return await original_create_playlist(...args);
        };

        try {
            await db_api.insertRecordIntoTable('subscriptions', sub);
            await db_api.insertRecordIntoTable('files', source_file);
            const sync_promise = files_api.syncSubscriptionPlaylist(sub.id);
            await create_started;

            const unsubscribe_promise = subscriptions_api.unsubscribe(sub.id, true);
            assert(await waitForCondition(async () => {
                const stored_sub = await db_api.getRecord('subscriptions', {id: sub.id});
                return stored_sub && stored_sub.auto_create_playlist === false;
            }));
            release_create_playlist();

            await sync_promise;
            const result = await unsubscribe_promise;
            assert.strictEqual(result.success, true);
            assert.strictEqual(await db_api.getRecord('playlists', {source_sub_id: sub.id}), undefined);
        } finally {
            files_api.createPlaylist = original_create_playlist;
            release_create_playlist();
        }
    });
    it('Delete subscription file', async function () {
        
    });
    it('Deletes subscription files and starts a fresh redownload', async function () {
        const original_deleteFile = files_api.deleteFile;
        const original_getVideosForSub = subscriptions_api.getVideosForSub;
        const sub = Object.assign({}, new_sub, {id: uuid(), name: 'redownload_sub'});
        const file_one = {uid: uuid(), sub_id: sub.id, url: 'https://example.com/video-1', path: 'subscriptions/video-1.mp4'};
        const file_two = {uid: uuid(), sub_id: sub.id, url: 'https://example.com/video-2', path: 'subscriptions/video-2.mp4'};
        const queued_download = {
            uid: uuid(),
            sub_id: sub.id,
            url: 'https://example.com/video-queued',
            running: false,
            finished: false,
            error: null
        };
        const deleted_files = [];
        let refresh_sub_id = null;

        files_api.deleteFile = async (uid, blacklistMode, user_uid) => {
            deleted_files.push({uid, blacklistMode, user_uid});
            return true;
        };
        subscriptions_api.getVideosForSub = async (sub_id, user_uid) => {
            refresh_sub_id = sub_id;
            assert.strictEqual(user_uid, null);
            return true;
        };

        try {
            await db_api.insertRecordIntoTable('subscriptions', sub);
            await db_api.insertRecordIntoTable('files', file_one);
            await db_api.insertRecordIntoTable('files', file_two);
            await db_api.insertRecordIntoTable('download_queue', queued_download);

            const result = await subscriptions_api.redownloadSubscription(sub.id);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.deleted_count, 2);
            assert.strictEqual(result.failed_count, 0);
            assert.strictEqual(result.refresh_started, true);
            assert.strictEqual(refresh_sub_id, sub.id);
            assert.deepStrictEqual(deleted_files.map(file => file.uid).sort(), [file_one.uid, file_two.uid].sort());
            assert(deleted_files.every(file => file.blacklistMode === false));

            const remaining_downloads = await db_api.getRecords('download_queue', {sub_id: sub.id});
            assert.strictEqual(remaining_downloads.length, 0);
        } finally {
            files_api.deleteFile = original_deleteFile;
            subscriptions_api.getVideosForSub = original_getVideosForSub;
        }
    });
    it('Does not start redownload refresh when deleting a subscription file fails', async function () {
        const original_deleteFile = files_api.deleteFile;
        const original_getVideosForSub = subscriptions_api.getVideosForSub;
        const sub = Object.assign({}, new_sub, {id: uuid(), name: 'redownload_failure_sub'});
        const file_one = {uid: uuid(), sub_id: sub.id, url: 'https://example.com/video-1', path: 'subscriptions/video-1.mp4'};
        const file_two = {uid: uuid(), sub_id: sub.id, url: 'https://example.com/video-2', path: 'subscriptions/video-2.mp4'};
        let refresh_started = false;

        files_api.deleteFile = async (uid) => uid === file_one.uid;
        subscriptions_api.getVideosForSub = async () => {
            refresh_started = true;
            return true;
        };

        try {
            await db_api.insertRecordIntoTable('subscriptions', sub);
            await db_api.insertRecordIntoTable('files', file_one);
            await db_api.insertRecordIntoTable('files', file_two);

            const result = await subscriptions_api.redownloadSubscription(sub.id);

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.deleted_count, 1);
            assert.strictEqual(result.failed_count, 1);
            assert.strictEqual(result.refresh_started, false);
            assert.strictEqual(refresh_started, false);
        } finally {
            files_api.deleteFile = original_deleteFile;
            subscriptions_api.getVideosForSub = original_getVideosForSub;
        }
    });
    it('Does not redownload a missing subscription', async function () {
        const result = await subscriptions_api.redownloadSubscription(uuid());

        assert.strictEqual(result.success, false);
        assert(result.error.includes('Subscription not found'));
    });
    it('Cancels active subscription work before redownloading', async function () {
        const original_cancelCheckSubscription = subscriptions_api.cancelCheckSubscription;
        const original_getVideosForSub = subscriptions_api.getVideosForSub;
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'active_redownload_sub',
            downloading: true
        });
        let cancelled_sub_id = null;
        let refresh_sub_id = null;

        subscriptions_api.cancelCheckSubscription = async (sub_id, user_uid) => {
            cancelled_sub_id = sub_id;
            assert.strictEqual(user_uid, null);
            return true;
        };
        subscriptions_api.getVideosForSub = async (sub_id, user_uid) => {
            refresh_sub_id = sub_id;
            assert.strictEqual(user_uid, null);
            return true;
        };

        try {
            await db_api.insertRecordIntoTable('subscriptions', sub);

            const result = await subscriptions_api.redownloadSubscription(sub.id);

            assert.strictEqual(result.success, true);
            assert.strictEqual(cancelled_sub_id, sub.id);
            assert.strictEqual(refresh_sub_id, sub.id);
        } finally {
            subscriptions_api.cancelCheckSubscription = original_cancelCheckSubscription;
            subscriptions_api.getVideosForSub = original_getVideosForSub;
        }
    });
    it('Get subscription by name', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        const sub_by_name = await subscriptions_api.getSubscriptionByName('test_sub');
        assert(sub_by_name);
    });
    it('Get subscriptions', async function() {
        await subscriptions_api.subscribe(new_sub, null, true);
        const subs = await subscriptions_api.getSubscriptions(null);
        assert(subs && subs.length === 1);
    });
    it('Checks all valid subscriptions in one run', async function() {
        const original_get_videos_for_sub = subscriptions_api.getVideosForSub;
        const checked_sub_ids = [];
        const sub_one = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'check_all_sub_one',
            paused: false
        });
        const sub_two = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'check_all_sub_two',
            url: 'https://www.youtube.com/channel/check-all-two',
            paused: false
        });
        const paused_sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'check_all_paused_sub',
            url: 'https://www.youtube.com/channel/check-all-paused',
            paused: true
        });

        subscriptions_api.getVideosForSub = async (sub_id) => {
            checked_sub_ids.push(sub_id);
            return true;
        };

        try {
            await db_api.insertRecordIntoTable('subscriptions', sub_one);
            await db_api.insertRecordIntoTable('subscriptions', sub_two);
            await db_api.insertRecordIntoTable('subscriptions', paused_sub);

            const result = await subscriptions_api.checkSubscriptions();

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.checked, true);
            assert.strictEqual(result.checked_count, 2);
            assert.strictEqual(result.skipped_count, 0);
            assert.deepStrictEqual(result.sub_ids, [sub_one.id, sub_two.id]);
            assert.deepStrictEqual(checked_sub_ids, [sub_one.id, sub_two.id]);
        } finally {
            subscriptions_api.getVideosForSub = original_get_videos_for_sub;
        }
    });
    it('Get subscription refresh status with pending queue counts', async function() {
        await subscriptions_api.subscribe(new_sub, null, true);
        await db_api.updateRecord('subscriptions', {id: new_sub['id']}, {
            refresh_status: {
                active: false,
                phase: 'idle',
                discovered_count: 25,
                total_count: 25,
                new_items_count: 2,
                queued_count: 2
            }
        });

        await db_api.insertRecordIntoTable('download_queue', {
            uid: uuid(),
            url: 'https://example.com/video-1',
            type: 'video',
            options: {},
            sub_id: new_sub['id'],
            running: true,
            paused: false,
            finished_step: false,
            finished: false,
            error: null,
            timestamp_start: Date.now()
        });
        await db_api.insertRecordIntoTable('download_queue', {
            uid: uuid(),
            url: 'https://example.com/video-2',
            type: 'video',
            options: {},
            sub_id: new_sub['id'],
            running: false,
            paused: false,
            finished_step: false,
            finished: false,
            error: null,
            timestamp_start: Date.now()
        });

        const refreshed_sub = await subscriptions_api.getSubscription(new_sub['id']);
        assert(refreshed_sub);
        assert.strictEqual(refreshed_sub['refresh_status']['phase'], 'queued');
        assert.strictEqual(refreshed_sub['refresh_status']['queued_count'], 2);
        assert.strictEqual(refreshed_sub['refresh_status']['pending_download_count'], 2);
        assert.strictEqual(refreshed_sub['refresh_status']['running_download_count'], 1);
    });
    it('Removes archived pending subscription downloads before reporting refresh status', async function() {
        const sub = Object.assign({}, new_sub, {id: uuid(), name: 'archived_pending_sub'});
        const archived_download = {
            uid: uuid(),
            url: 'https://www.youtube.com/watch?v=join-only-video',
            type: 'video',
            title: 'Members-only video',
            options: {},
            sub_id: sub.id,
            user_uid: null,
            running: false,
            paused: false,
            finished_step: true,
            finished: false,
            error: null,
            timestamp_start: Date.now()
        };

        await db_api.insertRecordIntoTable('subscriptions', {
            ...sub,
            refresh_status: {
                active: false,
                phase: 'queued',
                discovered_count: 1,
                total_count: 1,
                new_items_count: 1,
                queued_count: 1
            }
        });
        await archive_api.addToArchive('youtube', 'join-only-video', 'video', 'Members-only video', null, sub.id);
        await db_api.insertRecordIntoTable('download_queue', archived_download);

        const refreshed_sub = await subscriptions_api.getSubscription(sub.id);

        assert(refreshed_sub);
        assert.strictEqual(refreshed_sub['refresh_status']['pending_download_count'], 0);
        assert.strictEqual(refreshed_sub['refresh_status']['running_download_count'], 0);
        assert.strictEqual(refreshed_sub['refresh_status']['queued_count'], 0);
        assert.strictEqual(refreshed_sub['refresh_status']['new_items_count'], 0);
        assert.strictEqual(refreshed_sub['refresh_status']['skipped_count'], 1);
        assert.strictEqual(refreshed_sub['refresh_status']['phase'], 'complete');

        const remaining_downloads = await db_api.getRecords('download_queue', {sub_id: sub.id});
        assert.strictEqual(remaining_downloads.length, 0);
    });
    it('Reports skipped finished subscription downloads in refresh status', async function() {
        const sub = Object.assign({}, new_sub, {id: uuid(), name: 'skipped_finished_sub'});

        await db_api.insertRecordIntoTable('subscriptions', {
            ...sub,
            refresh_status: {
                active: false,
                phase: 'queued',
                discovered_count: 2,
                total_count: 2,
                new_items_count: 2,
                queued_count: 2
            }
        });
        await db_api.insertRecordIntoTable('download_queue', {
            uid: uuid(),
            url: 'https://www.youtube.com/watch?v=join-only-video-1',
            type: 'video',
            title: 'Members-only video 1',
            options: {},
            sub_id: sub.id,
            user_uid: null,
            running: false,
            paused: false,
            finished_step: true,
            finished: true,
            error: 'Error while retrieving info on video: Join this channel to get access to members-only content',
            error_type: 'join_only',
            timestamp_start: Date.now()
        });
        await db_api.insertRecordIntoTable('download_queue', {
            uid: uuid(),
            url: 'https://www.youtube.com/watch?v=join-only-video-2',
            type: 'video',
            title: 'Members-only video 2',
            options: {},
            sub_id: sub.id,
            user_uid: null,
            running: false,
            paused: false,
            finished_step: true,
            finished: true,
            error: 'Error while retrieving info on video: Join this channel to get access to members-only content',
            error_type: 'join_only',
            timestamp_start: Date.now()
        });

        const refreshed_sub = await subscriptions_api.getSubscription(sub.id);

        assert(refreshed_sub);
        assert.strictEqual(refreshed_sub['refresh_status']['pending_download_count'], 0);
        assert.strictEqual(refreshed_sub['refresh_status']['running_download_count'], 0);
        assert.strictEqual(refreshed_sub['refresh_status']['queued_count'], 2);
        assert.strictEqual(refreshed_sub['refresh_status']['new_items_count'], 2);
        assert.strictEqual(refreshed_sub['refresh_status']['skipped_count'], 2);
        assert.strictEqual(refreshed_sub['refresh_status']['phase'], 'complete');

        const stored_sub = await db_api.getRecord('subscriptions', {id: sub.id});
        assert.strictEqual(stored_sub['refresh_status']['skipped_count'], 2);
        assert.strictEqual(stored_sub['refresh_status']['phase'], 'complete');
    });
    it('Projects heavyweight queue records while retrieving subscription status', async function() {
        const original_get_records = db_api.getRecords;
        const sub = Object.assign({}, new_sub, {id: uuid(), name: 'projected_status_sub'});
        const refresh_started_at = Date.now() - 1000;
        const pending_uid = uuid();

        await db_api.insertRecordIntoTable('subscriptions', {
            ...sub,
            refresh_status: {
                active: false,
                phase: 'queued',
                discovered_count: 2,
                total_count: 2,
                new_items_count: 2,
                queued_count: 2,
                started_at: refresh_started_at
            }
        });
        await archive_api.addToArchive('youtube', 'archived-pending-video', 'video', 'Archived pending video', null, sub.id);
        await db_api.insertRecordIntoTable('download_queue', {
            uid: pending_uid,
            url: 'https://example.com/not-a-source-url',
            type: 'video',
            title: 'Archived pending video',
            sub_id: sub.id,
            running: false,
            finished: false,
            error: null,
            prefetched_info: [{
                extractor: 'youtube',
                id: 'archived-pending-video',
                title: 'Archived pending video',
                formats: [{
                    manifest: 'unused-heavy-format-data'
                }]
            }],
            unused_heavy_payload: 'unused-heavy-queue-data'
        });
        await db_api.insertRecordIntoTable('download_queue', {
            uid: uuid(),
            url: 'https://www.youtube.com/watch?v=skipped-video',
            type: 'video',
            title: 'Skipped video',
            sub_id: sub.id,
            running: false,
            finished: true,
            error: 'Join this channel to get access to members-only content',
            error_summary: 'Join this channel to get access to members-only content',
            error_type: 'join_only',
            timestamp_start: Date.now(),
            prefetched_info: [{
                formats: [{
                    manifest: 'unused-heavy-finished-data'
                }]
            }],
            unused_heavy_payload: 'unused-heavy-finished-queue-data'
        });

        const captured_calls = [];
        try {
            db_api.getRecords = async (...args) => {
                captured_calls.push(args);
                return await original_get_records(...args);
            };

            const refreshed_sub = await subscriptions_api.getSubscription(sub.id);

            assert(refreshed_sub);
            assert.strictEqual(refreshed_sub['refresh_status']['pending_download_count'], 0);
            assert.strictEqual(refreshed_sub['refresh_status']['skipped_count'], 2);
        } finally {
            db_api.getRecords = original_get_records;
        }

        const pending_read = captured_calls.find(call =>
            call[0] === 'download_queue'
            && call[1] && call[1].finished === false
            && call[2] === false
        );
        const skipped_read = captured_calls.find(call =>
            call[0] === 'download_queue'
            && call[1] && call[1].finished === true
            && call[1].error
            && call[2] === false
        );
        const archive_read = captured_calls.find(call => call[0] === 'archives');

        assert(pending_read);
        assert(pending_read[5].includes('prefetched_info.0.id'));
        assert(!pending_read[5].includes('prefetched_info'));
        assert(!pending_read[5].includes('unused_heavy_payload'));
        assert(skipped_read);
        assert.deepStrictEqual(skipped_read[5], [
            'error',
            'error_summary',
            'error_type',
            'timestamp_start'
        ]);
        assert(archive_read);
        assert.deepStrictEqual(archive_read[5], ['extractor', 'id']);
    });
    it('Uses Mongo-compatible nested array projections for pending subscription downloads', async function() {
        const original_get_records = db_api.getRecords;
        const original_is_using_mongo_db = db_api.isUsingMongoDB;
        const sub = Object.assign({}, new_sub, {id: uuid(), name: 'mongo_projection_sub'});
        const captured_calls = [];

        await db_api.insertRecordIntoTable('subscriptions', sub);

        try {
            db_api.isUsingMongoDB = () => true;
            db_api.getRecords = async (...args) => {
                captured_calls.push(args);
                return await original_get_records(...args);
            };

            const refreshed_sub = await subscriptions_api.getSubscription(sub.id);
            assert(refreshed_sub);
        } finally {
            db_api.getRecords = original_get_records;
            db_api.isUsingMongoDB = original_is_using_mongo_db;
        }

        const pending_read = captured_calls.find(call =>
            call[0] === 'download_queue'
            && call[1] && call[1].finished === false
            && call[2] === false
        );
        assert(pending_read);
        assert(pending_read[5].includes('prefetched_info.id'));
        assert(!pending_read[5].includes('prefetched_info.0.id'));
    });
    it('Update subscription', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        const sub_update = Object.assign({}, new_sub, {name: 'updated_name'});
        await subscriptions_api.updateSubscription(sub_update);
        const updated_sub = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert(updated_sub['name'] === 'updated_name');
    });
    it('Update subscription applies a partial update over the stored settings', async function () {
        await subscriptions_api.subscribe(Object.assign({}, new_sub, {maxQuality: '1080', custom_args: '--verbose'}), null, true);

        assert.strictEqual(await subscriptions_api.updateSubscription({id: new_sub['id'], paused: false}), true);

        const updated_sub = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert.strictEqual(updated_sub['paused'], false);
        assert.strictEqual(updated_sub['maxQuality'], '1080');
        assert.strictEqual(updated_sub['custom_args'], '--verbose');
        assert.strictEqual(updated_sub['name'], 'test_sub');
    });
    it('Update subscription leaves the fields the backend owns alone', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        const refresh_status = {active: true, phase: 'collecting', discovered_count: 7};
        await db_api.updateRecord('subscriptions', {id: new_sub['id']}, {
            downloading: true,
            refresh_status: refresh_status,
            artwork_file: `${new_sub['id']}.jpg`,
            artwork_updated_at: 1234
        });

        // What a page holding a copy from before the check started would send back.
        const stale_update = Object.assign({}, new_sub, {
            paused: true,
            downloading: false,
            refresh_status: {active: false, phase: 'idle', discovered_count: 0},
            file_count: 99,
            thumbnail_file_uid: 'not-a-file',
            artwork_file: '../../users.json',
            artwork_updated_at: 1
        });
        assert.strictEqual(await subscriptions_api.updateSubscription(stale_update), true);

        const updated_sub = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert.strictEqual(updated_sub['paused'], true);
        assert.strictEqual(updated_sub['downloading'], true);
        assert.strictEqual(updated_sub['refresh_status'].phase, 'collecting');
        assert.strictEqual(updated_sub['refresh_status'].discovered_count, 7);
        assert.strictEqual(updated_sub['file_count'], undefined);
        assert.strictEqual(updated_sub['thumbnail_file_uid'], undefined);
        assert.strictEqual(updated_sub['artwork_file'], `${new_sub['id']}.jpg`);
        assert.strictEqual(updated_sub['artwork_updated_at'], 1234);
    });
    it('Update subscription refuses an update that names no subscription', async function () {
        assert.strictEqual(await subscriptions_api.updateSubscription(null), false);
        assert.strictEqual(await subscriptions_api.updateSubscription({paused: true}), false);
        assert.strictEqual(await subscriptions_api.updateSubscription({id: 'missing-sub', paused: true}), false);
    });
    it('Summarises subscriptions with what their cards show', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        const older_file = {uid: uuid(), sub_id: new_sub['id'], title: 'Older', thumbnailPath: 'video/older.jpg', registered: 100};
        const newest_file = {uid: uuid(), sub_id: new_sub['id'], title: 'Newest', thumbnailPath: 'video/newest.jpg', registered: 300};
        const without_thumbnail = {uid: uuid(), sub_id: new_sub['id'], title: 'No thumbnail', registered: 400};
        await db_api.insertRecordsIntoTable('files', [older_file, newest_file, without_thumbnail]);
        await db_api.insertRecordIntoTable('download_queue', {
            uid: uuid(), sub_id: new_sub['id'], running: true, finished: false, timestamp_start: Date.now()
        });
        await db_api.insertRecordIntoTable('download_queue', {
            uid: uuid(), sub_id: new_sub['id'], running: false, finished: false, timestamp_start: Date.now()
        });

        const summaries = await subscriptions_api.getSubscriptionSummaries(null);

        assert.strictEqual(summaries.length, 1);
        const summary = summaries[0];
        assert.strictEqual(summary.file_count, 3);
        // The newest file that has a thumbnail, not simply the newest file.
        assert.strictEqual(summary.thumbnail_file_uid, newest_file.uid);
        assert.strictEqual(summary.refresh_status.pending_download_count, 2);
        assert.strictEqual(summary.refresh_status.running_download_count, 1);
        assert.strictEqual(summary.downloading, true);
        assert.strictEqual(summary.videos, undefined);
        assert.strictEqual(summary.child_process, undefined);
    });
    it('Summarises a subscription that has downloaded nothing yet', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);

        const [summary] = await subscriptions_api.getSubscriptionSummaries(null);

        assert.strictEqual(summary.file_count, 0);
        assert.strictEqual(summary.thumbnail_file_uid, null);
        assert.strictEqual(summary.refresh_status.phase, 'idle');
        assert.strictEqual(summary.downloading, false);
    });
    it('Backfills and appends to an automatic subscription playlist', async function () {
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'automatic_playlist_sub',
            auto_create_playlist: false
        });
        const first_file = {
            uid: uuid(),
            sub_id: sub.id,
            title: 'First file',
            thumbnailURL: 'https://example.com/first.jpg',
            duration: 30,
            registered: 100
        };
        const second_file = {
            uid: uuid(),
            sub_id: sub.id,
            title: 'Second file',
            thumbnailURL: 'https://example.com/second.jpg',
            duration: 45,
            registered: 200
        };
        const third_file = {
            uid: uuid(),
            sub_id: sub.id,
            title: 'Third file',
            thumbnailURL: 'https://example.com/third.jpg',
            duration: 60,
            registered: 300
        };

        await subscriptions_api.subscribe(sub, null, true);
        await db_api.insertRecordIntoTable('files', second_file);
        await db_api.insertRecordIntoTable('files', first_file);

        const enabled_sub = Object.assign({}, sub, {auto_create_playlist: true});
        assert.strictEqual(await subscriptions_api.updateSubscription(enabled_sub), true);

        let playlists = await db_api.getRecords('playlists', {source_sub_id: sub.id});
        assert.strictEqual(playlists.length, 1);
        assert.strictEqual(playlists[0].name, sub.name);
        assert.deepStrictEqual(playlists[0].uids, [first_file.uid, second_file.uid]);
        assert.strictEqual(playlists[0].duration, 75);

        await db_api.updateRecord('playlists', {id: playlists[0].id}, {
            uids: [...playlists[0].uids, 'deleted-file']
        });
        await db_api.insertRecordIntoTable('files', third_file);
        await Promise.all([
            files_api.syncSubscriptionPlaylist(sub.id, null, third_file.uid),
            files_api.syncSubscriptionPlaylist(sub.id, null, third_file.uid)
        ]);

        playlists = await db_api.getRecords('playlists', {source_sub_id: sub.id});
        assert.strictEqual(playlists.length, 1);
        assert.deepStrictEqual(playlists[0].uids, [first_file.uid, second_file.uid, third_file.uid]);
        assert.strictEqual(playlists[0].duration, 135);
    });
    it('Update subscription property', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        const sub_update = Object.assign({}, new_sub, {name: 'updated_name'});
        await subscriptions_api.updateSubscriptionPropertyMultiple([sub_update], {name: 'updated_name'});
        const updated_sub = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert(updated_sub['name'] === 'updated_name');
    });
    it('Write subscription metadata', async function() {
        const metadata_path = path.join('subscriptions', 'channels', 'test_sub', 'subscription_backup.json');
        if (fs.existsSync(metadata_path)) fs.unlinkSync(metadata_path);
        await subscriptions_api.subscribe(new_sub, null, true);
        assert(fs.existsSync(metadata_path));
    });
    it('Writes subscription metadata into the sanitized folder used for downloads', async function() {
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'Full Documentaries | FRONTLINE',
            isPlaylist: true
        });
        const expected_subscription_path = path.join('subscriptions', 'playlists', 'Full Documentaries - FRONTLINE');
        const raw_subscription_path = path.join('subscriptions', 'playlists', 'Full Documentaries | FRONTLINE');
        const metadata_path = path.join(expected_subscription_path, 'subscription_backup.json');

        config_api.setConfigItem('ytdl_replace_invalid_filename_chars', true);
        config_api.setConfigItem('ytdl_invalid_filename_replacement', '-');

        try {
            await fs.remove(expected_subscription_path);
            await fs.remove(raw_subscription_path);

            const success = subscriptions_api.writeSubscriptionMetadata(sub);
            const download_options = subscriptions_api.generateOptionsForSubscriptionDownload(sub, null);
            await db_api.insertRecordIntoTable('subscriptions', sub);
            const subscription_dir = (await db_api.getFileDirectoriesAndDBs()).find(dir => dir.sub_id === sub.id);

            assert.strictEqual(success, true);
            assert.strictEqual(fs.existsSync(metadata_path), true);
            assert.strictEqual(fs.existsSync(path.join(raw_subscription_path, 'subscription_backup.json')), false);
            assert.strictEqual(download_options.customFileFolderPath, expected_subscription_path);
            assert.strictEqual(download_options.customArchivePath, path.join('subscriptions', 'archives', 'Full Documentaries - FRONTLINE'));
            assert(subscription_dir);
            assert.strictEqual(subscription_dir.basePath, expected_subscription_path);
            assert.strictEqual(subscription_dir.archive_path, path.join('subscriptions', 'archives', 'Full Documentaries - FRONTLINE'));
        } finally {
            await fs.remove(expected_subscription_path);
            await fs.remove(raw_subscription_path);
        }
    });
    it('Writes flat subscription metadata outside the downloads folder', async function() {
        const original_subscriptions_base_path = config_api.getConfigItem('ytdl_subscriptions_base_path');
        const test_base_path = path.join('appdata', 'flat-subscription-metadata');
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'flat_metadata_sub',
            isPlaylist: false,
            use_subfolder: false
        });
        const metadata_path = path.join(test_base_path, 'channels', '.metadata', 'flat_metadata_sub', 'subscription_backup.json');
        const root_metadata_path = path.join(test_base_path, 'channels', 'subscription_backup.json');

        config_api.setConfigItem('ytdl_subscriptions_base_path', test_base_path);

        try {
            await fs.remove(test_base_path);

            const success = subscriptions_api.writeSubscriptionMetadata(sub);
            const download_options = subscriptions_api.generateOptionsForSubscriptionDownload(sub, null);
            await db_api.insertRecordIntoTable('subscriptions', sub);
            const subscription_dir = (await db_api.getFileDirectoriesAndDBs()).find(dir => dir.sub_id === sub.id);

            assert.strictEqual(success, true);
            assert.strictEqual(fs.existsSync(metadata_path), true);
            assert.strictEqual(fs.existsSync(root_metadata_path), false);
            assert.strictEqual(download_options.customFileFolderPath, path.join(test_base_path, 'channels'));
            assert(subscription_dir);
            assert.strictEqual(subscription_dir.basePath, path.join(test_base_path, 'channels'));
        } finally {
            config_api.setConfigItem('ytdl_subscriptions_base_path', original_subscriptions_base_path);
            await fs.remove(test_base_path);
        }
    });
    it('Moves subscription files when toggling the subscription name folder setting', async function() {
        const original_subscriptions_base_path = config_api.getConfigItem('ytdl_subscriptions_base_path');
        const test_base_path = path.join('appdata', 'subscription-folder-toggle');
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'move_sub',
            isPlaylist: false,
            use_subfolder: true
        });
        const nested_dir = path.join(test_base_path, 'channels', 'move_sub');
        const flat_dir = path.join(test_base_path, 'channels');
        const nested_media_path = path.join(nested_dir, 'Episode 1.mp4');
        const nested_info_path = path.join(nested_dir, 'Episode 1.info.json');
        const nested_thumbnail_path = path.join(nested_dir, 'Episode 1.jpg');
        const flat_media_path = path.join(flat_dir, 'Episode 1.mp4');
        const flat_info_path = path.join(flat_dir, 'Episode 1.info.json');
        const flat_thumbnail_path = path.join(flat_dir, 'Episode 1.jpg');
        const file_uid = uuid();

        config_api.setConfigItem('ytdl_subscriptions_base_path', test_base_path);

        try {
            await fs.remove(test_base_path);
            await fs.outputFile(nested_media_path, 'video');
            await fs.outputJSON(nested_info_path, {id: 'episode-1', extractor: 'youtube'});
            await fs.outputFile(nested_thumbnail_path, 'thumb');
            await db_api.insertRecordIntoTable('subscriptions', sub);
            await db_api.insertRecordIntoTable('files', {
                uid: file_uid,
                sub_id: sub.id,
                path: nested_media_path,
                isAudio: false,
                url: 'https://example.com/episode-1',
                title: 'Episode 1'
            });

            const flat_sub_update = Object.assign({}, sub, {use_subfolder: false});
            const flattened = await subscriptions_api.updateSubscription(flat_sub_update);

            assert.strictEqual(flattened, true);
            assert.strictEqual(fs.existsSync(flat_media_path), true);
            assert.strictEqual(fs.existsSync(flat_info_path), true);
            assert.strictEqual(fs.existsSync(flat_thumbnail_path), true);
            assert.strictEqual(fs.existsSync(nested_media_path), false);
            assert.strictEqual(fs.existsSync(nested_dir), false);
            assert.strictEqual(fs.existsSync(path.join(flat_dir, '.metadata', 'move_sub', 'subscription_backup.json')), true);

            let moved_file = await db_api.getRecord('files', {uid: file_uid});
            assert.strictEqual(moved_file.path, flat_media_path);

            const nested_sub_update = Object.assign({}, flat_sub_update, {use_subfolder: true});
            const nested = await subscriptions_api.updateSubscription(nested_sub_update);

            assert.strictEqual(nested, true);
            assert.strictEqual(fs.existsSync(nested_media_path), true);
            assert.strictEqual(fs.existsSync(nested_info_path), true);
            assert.strictEqual(fs.existsSync(nested_thumbnail_path), true);
            assert.strictEqual(fs.existsSync(flat_media_path), false);
            assert.strictEqual(fs.existsSync(path.join(nested_dir, 'subscription_backup.json')), true);
            assert.strictEqual(fs.existsSync(path.join(flat_dir, '.metadata', 'move_sub', 'subscription_backup.json')), false);

            moved_file = await db_api.getRecord('files', {uid: file_uid});
            assert.strictEqual(moved_file.path, nested_media_path);
        } finally {
            config_api.setConfigItem('ytdl_subscriptions_base_path', original_subscriptions_base_path);
            await fs.remove(test_base_path);
        }
    });
    it('Does not remove other flat subscription files when unsubscribing with delete mode', async function() {
        const original_subscriptions_base_path = config_api.getConfigItem('ytdl_subscriptions_base_path');
        const test_base_path = path.join('appdata', 'flat-subscription-unsubscribe');
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'flat_delete_sub',
            use_subfolder: false
        });
        const other_sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'flat_keep_sub',
            use_subfolder: false
        });
        const delete_file_path = path.join(test_base_path, 'channels', 'Delete Me.mp4');
        const keep_file_path = path.join(test_base_path, 'channels', 'Keep Me.mp4');

        config_api.setConfigItem('ytdl_subscriptions_base_path', test_base_path);

        try {
            await fs.remove(test_base_path);
            await fs.outputFile(delete_file_path, 'delete');
            await fs.outputFile(keep_file_path, 'keep');
            await db_api.insertRecordIntoTable('subscriptions', sub);
            await db_api.insertRecordIntoTable('subscriptions', other_sub);
            await db_api.insertRecordIntoTable('files', {
                uid: 'delete-flat-file',
                sub_id: sub.id,
                path: delete_file_path,
                isAudio: false,
                url: 'https://example.com/delete',
                title: 'Delete Me'
            });
            await db_api.insertRecordIntoTable('files', {
                uid: 'keep-flat-file',
                sub_id: other_sub.id,
                path: keep_file_path,
                isAudio: false,
                url: 'https://example.com/keep',
                title: 'Keep Me'
            });

            const result = await subscriptions_api.unsubscribe(sub.id, true);

            assert.strictEqual(result.success, true);
            assert.strictEqual(fs.existsSync(delete_file_path), false);
            assert.strictEqual(fs.existsSync(keep_file_path), true);
            assert.strictEqual(!!(await db_api.getRecord('subscriptions', {id: sub.id})), false);
            assert.strictEqual(!!(await db_api.getRecord('subscriptions', {id: other_sub.id})), true);
        } finally {
            config_api.setConfigItem('ytdl_subscriptions_base_path', original_subscriptions_base_path);
            await fs.remove(test_base_path);
        }
    });
    it('Does not let path separators split subscription metadata folders', async function() {
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'Folder/Playlist',
            isPlaylist: true
        });
        const expected_subscription_path = path.join('subscriptions', 'playlists', 'Folder_Playlist');
        const nested_subscription_path = path.join('subscriptions', 'playlists', 'Folder');
        const metadata_path = path.join(expected_subscription_path, 'subscription_backup.json');

        try {
            await fs.remove(expected_subscription_path);
            await fs.remove(nested_subscription_path);

            const success = subscriptions_api.writeSubscriptionMetadata(sub);

            assert.strictEqual(success, true);
            assert.strictEqual(fs.existsSync(metadata_path), true);
            assert.strictEqual(fs.existsSync(path.join(nested_subscription_path, 'Playlist', 'subscription_backup.json')), false);
        } finally {
            await fs.remove(expected_subscription_path);
            await fs.remove(nested_subscription_path);
        }
    });
    it('Streams subscription videos with flat playlist metadata and queues them in batches before discovery completes', async function() {
        const original_runYoutubeDLLineStream = youtubedl_api.runYoutubeDLLineStream;
        const sub = Object.assign({}, new_sub, {id: uuid(), name: 'batched_sub'});
        const fake_outputs = Array.from({length: 65}, (_, index) => ({
            webpage_url: `https://www.youtube.com/watch?v=video-${index}`,
            title: `Video ${index}`,
            extractor: 'youtube',
            id: `video-${index}`,
            playlist_count: 65,
            playlist_index: index + 1
        }));
        let captured_args = null;
        let resolve_stream = null;
        let callback_resolved = false;

        youtubedl_api.runYoutubeDLLineStream = async (requested_url, args, line_handlers = {}) => {
            captured_args = args;
            return {
                child_process: {pid: 4321},
                callback: new Promise(resolve => {
                    resolve_stream = () => {
                        callback_resolved = true;
                        resolve({err: null});
                    };

                    setTimeout(() => {
                        for (const output_json of fake_outputs) {
                            if (typeof line_handlers.onStdoutLine === 'function') {
                                line_handlers.onStdoutLine(JSON.stringify(output_json));
                            }
                        }
                    }, 0);
                })
            };
        };

        try {
            await subscriptions_api.subscribe(sub, null, true);
            const started = await subscriptions_api.getVideosForSub(sub.id);
            assert.strictEqual(started, true);

            const queued_before_completion = await waitForCondition(async () => {
                if (callback_resolved) return false;
                const in_progress_sub = await subscriptions_api.getSubscription(sub.id);
                return !!(in_progress_sub
                    && in_progress_sub.refresh_status.phase === 'queueing'
                    && in_progress_sub.refresh_status.queued_count > 0
                    && in_progress_sub.refresh_status.queued_count < fake_outputs.length
                    && in_progress_sub.refresh_status.discovered_count === fake_outputs.length);
            });
            assert.strictEqual(queued_before_completion, true);
            assert.strictEqual(callback_resolved, false);

            const in_progress_sub = await subscriptions_api.getSubscription(sub.id);
            const queued_before_completion_count = in_progress_sub.refresh_status.queued_count;
            assert(in_progress_sub);
            assert(queued_before_completion_count > 0);
            assert(queued_before_completion_count < fake_outputs.length);

            const queued_downloads_before_completion = await db_api.getRecords('download_queue', {sub_id: sub.id});
            assert(queued_downloads_before_completion.length > 0);
            assert(queued_downloads_before_completion.length < fake_outputs.length);

            resolve_stream();

            const completed = await waitForCondition(async () => {
                const refreshed_sub = await subscriptions_api.getSubscription(sub.id);
                return !!(refreshed_sub && !refreshed_sub.downloading);
            });
            assert.strictEqual(completed, true);

            assert(captured_args.includes('--flat-playlist'));
            assert(captured_args.includes('--dump-json'));
            assert(!captured_args.includes('-o'));
            assert(!captured_args.includes('--write-info-json'));
            assert(!captured_args.includes('--print-json'));

            const queued_downloads = await db_api.getRecords('download_queue', {sub_id: sub.id});
            assert.strictEqual(queued_downloads.length, fake_outputs.length);
            assert(queued_downloads.every(download => download.prefetched_info === null));
            assert(queued_downloads.every(download => download.options.concurrentQueueGroupKey === 'subscription-downloads'));
            assert(queued_downloads.every(download => download.options.concurrentQueueGroupLimit === downloader_api.getExclusivePlaylistConcurrencyLimit()));

            const refreshed_sub = await subscriptions_api.getSubscription(sub.id);
            assert(refreshed_sub);
            assert.strictEqual(refreshed_sub.refresh_status.phase, 'queued');
            assert.strictEqual(refreshed_sub.refresh_status.queued_count, fake_outputs.length);
        } finally {
            youtubedl_api.runYoutubeDLLineStream = original_runYoutubeDLLineStream;
        }
    });
    it('Compacts prefetched subscription formats while retaining expected-size fields', async function() {
        const original_runYoutubeDLLineStream = youtubedl_api.runYoutubeDLLineStream;
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'compacted_formats_sub',
            timerange: 'now-7days'
        });
        const fake_output = {
            webpage_url: 'https://www.youtube.com/watch?v=compacted-formats',
            _filename: 'subscriptions/channels/compacted_formats_sub/Compacted formats.mp4',
            title: 'Compacted formats',
            extractor: 'youtube',
            id: 'compacted-formats',
            format_id: '137+140',
            duration: 10,
            formats: [
                {
                    format_id: '137',
                    filesize: null,
                    filesize_approx: null,
                    duration: 10,
                    tbr: 800,
                    vbr: 750,
                    abr: 0,
                    url: `https://media.example/video?payload=${'v'.repeat(20000)}`,
                    fragments: Array.from({length: 100}, (_, index) => ({path: `fragment-${index}`}))
                },
                {
                    format_id: '140',
                    filesize: 500,
                    filesize_approx: 600,
                    duration: 10,
                    tbr: 128,
                    vbr: 0,
                    abr: 128,
                    url: `https://media.example/audio?payload=${'a'.repeat(20000)}`
                }
            ]
        };

        youtubedl_api.runYoutubeDLLineStream = async (requested_url, args, line_handlers = {}) => {
            if (typeof line_handlers.onStdoutLine === 'function') {
                line_handlers.onStdoutLine(JSON.stringify(fake_output));
            }
            return {
                child_process: {pid: 4321},
                callback: Promise.resolve({err: null})
            };
        };

        try {
            await subscriptions_api.subscribe(sub, null, true);
            const started = await subscriptions_api.getVideosForSub(sub.id);
            assert.strictEqual(started, true);

            const completed = await waitForCondition(async () => {
                const refreshed_sub = await subscriptions_api.getSubscription(sub.id);
                return !!(refreshed_sub && !refreshed_sub.downloading);
            });
            assert.strictEqual(completed, true);
        } finally {
            youtubedl_api.runYoutubeDLLineStream = original_runYoutubeDLLineStream;
        }

        const queued_downloads = await db_api.getRecords('download_queue', {sub_id: sub.id});
        assert.strictEqual(queued_downloads.length, 1);

        const prefetched_info = queued_downloads[0].prefetched_info;
        assert(Array.isArray(prefetched_info));
        assert.strictEqual(prefetched_info.length, 1);
        assert.deepStrictEqual(
            Object.keys(prefetched_info[0].formats[0]).sort(),
            ['abr', 'duration', 'filesize', 'filesize_approx', 'format_id', 'tbr', 'vbr'].sort()
        );
        assert.strictEqual(prefetched_info[0].formats[0].url, undefined);
        assert.strictEqual(prefetched_info[0].formats[0].fragments, undefined);
        assert.strictEqual(utils.getExpectedFileSize(prefetched_info), 1000500);
    });
    it('Applies global custom args when discovering subscription videos', async function() {
        const original_runYoutubeDLLineStream = youtubedl_api.runYoutubeDLLineStream;
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'global_args_sub',
            custom_args: '--sleep-interval,,2'
        });
        let captured_args = null;

        youtubedl_api.runYoutubeDLLineStream = async (requested_url, args) => {
            captured_args = args;
            return {
                child_process: {pid: 4321},
                callback: Promise.resolve({err: null})
            };
        };

        try {
            config_api.setConfigItem('ytdl_custom_args', '--resize-buffer');
            await subscriptions_api.subscribe(sub, null, true);
            const started = await subscriptions_api.getVideosForSub(sub.id);
            assert.strictEqual(started, true);

            const completed = await waitForCondition(async () => {
                const refreshed_sub = await subscriptions_api.getSubscription(sub.id);
                return !!(refreshed_sub && !refreshed_sub.downloading);
            });
            assert.strictEqual(completed, true);
        } finally {
            youtubedl_api.runYoutubeDLLineStream = original_runYoutubeDLLineStream;
        }

        const sleep_interval_index = captured_args.indexOf('--sleep-interval');
        assert(captured_args.includes('--resize-buffer'));
        assert(sleep_interval_index !== -1);
        assert.strictEqual(captured_args[sleep_interval_index + 1], '2');
    });
    it('Skips join-only flat playlist entries before queueing subscription downloads', async function() {
        const original_runYoutubeDLLineStream = youtubedl_api.runYoutubeDLLineStream;
        const original_skip_join_only = config_api.getConfigItem('ytdl_skip_join_only_videos');
        const sub = Object.assign({}, new_sub, {id: uuid(), name: 'skip_join_only_sub'});
        const public_output = {
            _type: 'url',
            ie_key: 'Youtube',
            extractor: 'youtube',
            extractor_key: 'Youtube',
            id: 'public-video',
            url: 'https://www.youtube.com/watch?v=public-video',
            webpage_url: 'https://www.youtube.com/watch?v=public-video',
            title: 'Public video',
            availability: null
        };
        const join_only_output = {
            _type: 'url',
            ie_key: 'Youtube',
            extractor: 'youtube',
            extractor_key: 'Youtube',
            id: 'join-only-video',
            url: 'https://www.youtube.com/watch?v=join-only-video',
            webpage_url: 'https://www.youtube.com/watch?v=join-only-video',
            title: 'Members-only video',
            availability: 'subscriber_only'
        };

        youtubedl_api.runYoutubeDLLineStream = async (requested_url, args, line_handlers = {}) => {
            if (typeof line_handlers.onStdoutLine === 'function') {
                line_handlers.onStdoutLine(JSON.stringify(public_output));
                line_handlers.onStdoutLine(JSON.stringify(join_only_output));
            }
            return {
                child_process: {pid: 4321},
                callback: Promise.resolve({err: null})
            };
        };

        try {
            config_api.setConfigItem('ytdl_skip_join_only_videos', true);
            await subscriptions_api.subscribe(sub, null, true);
            const started = await subscriptions_api.getVideosForSub(sub.id);
            assert.strictEqual(started, true);

            const completed = await waitForCondition(async () => {
                const refreshed_sub = await subscriptions_api.getSubscription(sub.id);
                return !!(refreshed_sub && !refreshed_sub.downloading);
            });
            assert.strictEqual(completed, true);
        } finally {
            youtubedl_api.runYoutubeDLLineStream = original_runYoutubeDLLineStream;
            config_api.setConfigItem('ytdl_skip_join_only_videos', original_skip_join_only);
        }

        const queued_downloads = await db_api.getRecords('download_queue', {sub_id: sub.id});
        assert.strictEqual(queued_downloads.length, 1);
        assert.strictEqual(queued_downloads[0].url, public_output.webpage_url);
        assert.strictEqual(await archive_api.existsInArchive('youtube', join_only_output.id, sub.type, sub.user_uid, sub.id), true);

        const refreshed_sub = await subscriptions_api.getSubscription(sub.id);
        assert.strictEqual(refreshed_sub.refresh_status.queued_count, 1);
        assert.strictEqual(refreshed_sub.refresh_status.skipped_count, 1);
        assert.strictEqual(refreshed_sub.refresh_status.new_items_count, 2);
    });
    it('Filters archived flat playlist entries from cached subscription archive state', async function() {
        const original_runYoutubeDLLineStream = youtubedl_api.runYoutubeDLLineStream;
        const original_existsInArchive = archive_api.existsInArchive;
        const sub = Object.assign({}, new_sub, {id: uuid(), name: 'cached_archive_sub'});
        const archived_output = {
            _type: 'url',
            ie_key: 'Youtube',
            extractor: 'youtube',
            extractor_key: 'Youtube',
            id: 'archived-video',
            url: 'https://www.youtube.com/watch?v=archived-video',
            webpage_url: 'https://www.youtube.com/watch?v=archived-video',
            title: 'Archived video',
            availability: null
        };
        const public_output = {
            _type: 'url',
            ie_key: 'Youtube',
            extractor: 'youtube',
            extractor_key: 'Youtube',
            id: 'public-video',
            url: 'https://www.youtube.com/watch?v=public-video',
            webpage_url: 'https://www.youtube.com/watch?v=public-video',
            title: 'Public video',
            availability: null
        };

        youtubedl_api.runYoutubeDLLineStream = async (requested_url, args, line_handlers = {}) => {
            if (typeof line_handlers.onStdoutLine === 'function') {
                line_handlers.onStdoutLine(JSON.stringify(archived_output));
                line_handlers.onStdoutLine(JSON.stringify(public_output));
            }
            return {
                child_process: {pid: 4321},
                callback: Promise.resolve({err: null})
            };
        };

        try {
            await subscriptions_api.subscribe(sub, null, true);
            await archive_api.addToArchive('youtube', archived_output.id, sub.type, archived_output.title, sub.user_uid, sub.id);
            archive_api.existsInArchive = async () => {
                throw new Error('archive lookups should be served from the subscription context');
            };

            const started = await subscriptions_api.getVideosForSub(sub.id);
            assert.strictEqual(started, true);

            const completed = await waitForCondition(async () => {
                const refreshed_sub = await subscriptions_api.getSubscription(sub.id);
                return !!(refreshed_sub && !refreshed_sub.downloading);
            });
            assert.strictEqual(completed, true);
        } finally {
            youtubedl_api.runYoutubeDLLineStream = original_runYoutubeDLLineStream;
            archive_api.existsInArchive = original_existsInArchive;
        }

        const queued_downloads = await db_api.getRecords('download_queue', {sub_id: sub.id});
        assert.strictEqual(queued_downloads.length, 1);
        assert.strictEqual(queued_downloads[0].url, public_output.webpage_url);
    });
    it('Applies availability match filters while queueing flat subscription entries', async function() {
        const original_runYoutubeDLLineStream = youtubedl_api.runYoutubeDLLineStream;
        const sub = Object.assign({}, new_sub, {id: uuid(), name: 'availability_filter_sub'});
        const fake_outputs = [
            {
                _type: 'url',
                ie_key: 'Youtube',
                extractor: 'youtube',
                extractor_key: 'Youtube',
                id: 'public-video',
                url: 'https://www.youtube.com/watch?v=public-video',
                webpage_url: 'https://www.youtube.com/watch?v=public-video',
                title: 'Public video',
                availability: null
            },
            {
                _type: 'url',
                ie_key: 'Youtube',
                extractor: 'youtube',
                extractor_key: 'Youtube',
                id: 'join-only-video',
                url: 'https://www.youtube.com/watch?v=join-only-video',
                webpage_url: 'https://www.youtube.com/watch?v=join-only-video',
                title: 'Members-only video',
                availability: 'subscriber_only'
            },
            {
                _type: 'url',
                ie_key: 'Youtube',
                extractor: 'youtube',
                extractor_key: 'Youtube',
                id: 'private-video',
                url: 'https://www.youtube.com/watch?v=private-video',
                webpage_url: 'https://www.youtube.com/watch?v=private-video',
                title: 'Private video',
                availability: 'private'
            }
        ];
        let captured_args = null;

        youtubedl_api.runYoutubeDLLineStream = async (requested_url, args, line_handlers = {}) => {
            captured_args = args;
            if (typeof line_handlers.onStdoutLine === 'function') {
                for (const output_json of fake_outputs) {
                    line_handlers.onStdoutLine(JSON.stringify(output_json));
                }
            }
            return {
                child_process: {pid: 4321},
                callback: Promise.resolve({err: null})
            };
        };

        try {
            config_api.setConfigItem('ytdl_custom_args', '--match-filters,,availability=public');
            await subscriptions_api.subscribe(sub, null, true);
            const started = await subscriptions_api.getVideosForSub(sub.id);
            assert.strictEqual(started, true);

            const completed = await waitForCondition(async () => {
                const refreshed_sub = await subscriptions_api.getSubscription(sub.id);
                return !!(refreshed_sub && !refreshed_sub.downloading);
            });
            assert.strictEqual(completed, true);
        } finally {
            youtubedl_api.runYoutubeDLLineStream = original_runYoutubeDLLineStream;
        }

        assert(!captured_args.includes('--match-filters'));
        assert(!captured_args.includes('availability=public'));

        const queued_downloads = await db_api.getRecords('download_queue', {sub_id: sub.id});
        assert.strictEqual(queued_downloads.length, 1);
        assert.strictEqual(queued_downloads[0].url, fake_outputs[0].webpage_url);

        const archived_items = await db_api.getRecords('archives', {sub_id: sub.id});
        assert.strictEqual(archived_items.length, 0);
    });
    it('Uses full metadata discovery for timeranged subscriptions so date filters are honored', async function() {
        const original_runYoutubeDLLineStream = youtubedl_api.runYoutubeDLLineStream;
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'timeranged_sub',
            timerange: 'now-7days'
        });
        let captured_args = null;

        youtubedl_api.runYoutubeDLLineStream = async (requested_url, args) => {
            captured_args = args;
            return {
                child_process: {pid: 4321},
                callback: Promise.resolve({err: null})
            };
        };

        try {
            await subscriptions_api.subscribe(sub, null, true);
            const started = await subscriptions_api.getVideosForSub(sub.id);
            assert.strictEqual(started, true);

            const completed = await waitForCondition(async () => {
                const refreshed_sub = await subscriptions_api.getSubscription(sub.id);
                return !!(refreshed_sub && !refreshed_sub.downloading);
            });
            assert.strictEqual(completed, true);
        } finally {
            youtubedl_api.runYoutubeDLLineStream = original_runYoutubeDLLineStream;
        }

        const dateafter_index = captured_args.indexOf('--dateafter');
        assert(dateafter_index !== -1);
        assert.strictEqual(captured_args[dateafter_index + 1], 'now-7days');
        assert(!captured_args.includes('--flat-playlist'));
        assert(captured_args.includes('--dump-json'));
        assert(captured_args.includes('-o'));
        assert(captured_args.includes('-f'));
    });
    it('Skips writing metadata for subscriptions without a name', async function() {
        const nameless_sub = Object.assign({}, new_sub, {id: uuid(), name: null});
        const metadata_path = path.join('subscriptions', 'channels', 'null', 'subscription_backup.json');
        if (fs.existsSync(metadata_path)) fs.unlinkSync(metadata_path);

        const success = subscriptions_api.writeSubscriptionMetadata(nameless_sub);

        assert.strictEqual(success, false);
        assert.strictEqual(fs.existsSync(metadata_path), false);
    });
    it('Never adds extractor args to subscription download args on its own', async function() {
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        try {
            config_api.setConfigItem('ytdl_default_downloader', 'yt-dlp');

            const args = await subscriptions_api.generateArgsForSubscription(new_sub, null);
            assert(!args.includes('--extractor-args'));
        } finally {
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }
    });

    it('Passes a user configured extractor-args through to subscription args', async function() {
        const original_global_args = config_api.getConfigItem('ytdl_custom_args');
        try {
            config_api.setConfigItem('ytdl_custom_args', '--extractor-args,,youtube:player_client=default');

            const args = await subscriptions_api.generateArgsForSubscription(new_sub, null);
            const extractor_args_matches = args.filter(arg => arg === '--extractor-args');
            assert.strictEqual(extractor_args_matches.length, 1);
            assert.strictEqual(args[args.indexOf('--extractor-args') + 1], 'youtube:player_client=default');
        } finally {
            config_api.setConfigItem('ytdl_custom_args', original_global_args);
        }
    });

    async function checkAndWait(sub_id) {
        assert.strictEqual(await subscriptions_api.getVideosForSub(sub_id), true);
        assert(await waitForCondition(async () => {
            const refreshed_sub = await subscriptions_api.getSubscription(sub_id);
            return !!(refreshed_sub && !refreshed_sub.downloading);
        }));
    }

    it('Keeps the channel id and avatar from the channel record', async function () {
        const axios = require('axios');
        const original_get = axios.get;
        const sub = Object.assign({}, new_sub, {id: uuid(), name: null});
        const requested_images = [];
        youtubedl_api.runYoutubeDL = async () => ({
            child_process: null,
            callback: Promise.resolve({parsed_output: [{
                _type: 'playlist',
                title: 'Channel - Videos',
                uploader: 'Channel',
                channel_id: 'UCzofo-P8yMMCOv8rsPfIR-g',
                thumbnails: [
                    {id: 'banner', url: 'https://img.example/banner', width: 2560, height: 424},
                    {id: '7', url: 'https://img.example/avatar-900', width: 900, height: 900},
                    {id: '6', url: 'https://img.example/avatar-88', width: 88, height: 88},
                    {id: 'avatar_uncropped', url: 'https://img.example/avatar-full'}
                ]
            }], err: null})
        });
        axios.get = async (url) => {
            requested_images.push(url);
            return {headers: {'content-type': 'image/jpeg'}, data: Buffer.from('avatar-bytes')};
        };

        let artwork_path = null;
        try {
            const result = await subscriptions_api.subscribe(sub, null, false);
            assert.strictEqual(result.success, true);

            const stored_sub = await db_api.getRecord('subscriptions', {id: sub.id});
            assert.strictEqual(stored_sub.name, 'Channel');
            assert.strictEqual(stored_sub.channel_id, 'UCzofo-P8yMMCOv8rsPfIR-g');
            assert.strictEqual(stored_sub.artwork_file, `${sub.id}.jpg`);
            assert.strictEqual(stored_sub.artwork_source_url, 'https://img.example/avatar-900');
            assert(stored_sub.artwork_updated_at > 0);
            assert.deepStrictEqual(requested_images, ['https://img.example/avatar-900']);

            artwork_path = await subscriptions_api.getSubscriptionArtworkPath(sub.id);
            assert(artwork_path);
            assert.strictEqual(fs.readFileSync(artwork_path, 'utf8'), 'avatar-bytes');

            await subscriptions_api.unsubscribe(sub.id, false);
            assert.strictEqual(fs.existsSync(artwork_path), false);
        } finally {
            axios.get = original_get;
            if (artwork_path) fs.removeSync(artwork_path);
        }
    });

    it('Asks for the avatar on a check at most daily, and downloads it again only once it changes', async function () {
        const axios = require('axios');
        const original_get = axios.get;
        const original_runYoutubeDLLineStream = youtubedl_api.runYoutubeDLLineStream;
        const sub = Object.assign({}, new_sub, {id: uuid(), name: 'avatar_refresh_sub'});
        let avatar_url = 'https://img.example/avatar-a';
        let info_requests = 0;
        const requested_images = [];
        youtubedl_api.runYoutubeDL = async () => {
            info_requests += 1;
            return {child_process: null, callback: Promise.resolve({parsed_output: [{
                channel_id: 'UCzofo-P8yMMCOv8rsPfIR-g',
                thumbnails: [{url: avatar_url, width: 900, height: 900}]
            }], err: null})};
        };
        youtubedl_api.runYoutubeDLLineStream = async () => ({child_process: {pid: 4321}, callback: Promise.resolve({err: null})});
        axios.get = async (url) => {
            requested_images.push(url);
            return {headers: {'content-type': 'image/png'}, data: Buffer.from(url)};
        };

        try {
            await subscriptions_api.subscribe(sub, null, true);
            await checkAndWait(sub.id);
            assert.strictEqual(info_requests, 1);
            assert.deepStrictEqual(requested_images, ['https://img.example/avatar-a']);

            await checkAndWait(sub.id);
            assert.strictEqual(info_requests, 1, 'a second check the same day does not ask again');

            await db_api.updateRecord('subscriptions', {id: sub.id}, {source_info_checked_at: Date.now() - 2 * 24 * 60 * 60 * 1000});
            await checkAndWait(sub.id);
            assert.strictEqual(info_requests, 2);
            assert.strictEqual(requested_images.length, 1, 'the same avatar is not downloaded again');

            avatar_url = 'https://img.example/avatar-b';
            await db_api.updateRecord('subscriptions', {id: sub.id}, {source_info_checked_at: 0});
            await checkAndWait(sub.id);
            assert.deepStrictEqual(requested_images, ['https://img.example/avatar-a', 'https://img.example/avatar-b']);
            const artwork_path = await subscriptions_api.getSubscriptionArtworkPath(sub.id);
            assert(artwork_path.endsWith(`${sub.id}.png`));
            assert.strictEqual(fs.readFileSync(artwork_path, 'utf8'), 'https://img.example/avatar-b');
        } finally {
            axios.get = original_get;
            youtubedl_api.runYoutubeDLLineStream = original_runYoutubeDLLineStream;
            const artwork_path = await subscriptions_api.getSubscriptionArtworkPath(sub.id);
            if (artwork_path) fs.removeSync(artwork_path);
        }
    });

    it('Picks a channel avatar or a playlist cover from the source images', function () {
        const banner = {id: 'banner', url: 'https://img.example/banner', width: 2560, height: 424};
        const small_avatar = {id: '1', url: 'https://img.example/avatar-88', width: 88, height: 88};
        const large_avatar = {id: '2', url: 'https://img.example/avatar-900', width: 900, height: 900};
        const uncropped_avatar = {id: 'avatar_uncropped', url: 'https://img.example/avatar-full'};
        const pick = subscriptions_api.pickSubscriptionArtworkUrl;

        assert.strictEqual(pick({thumbnails: [banner, small_avatar, large_avatar, uncropped_avatar]}, false), large_avatar.url);
        // Without sizes only an image named as the avatar will do. A banner never stands in.
        assert.strictEqual(pick({thumbnails: [banner, uncropped_avatar]}, false), uncropped_avatar.url);
        assert.strictEqual(pick({thumbnails: [banner]}, false), null);
        assert.strictEqual(pick({thumbnails: [{url: 'file:///etc/passwd', width: 10, height: 10}]}, false), null);

        const playlist_covers = [
            {url: 'https://img.example/cover-320', width: 320, height: 180},
            {url: 'https://img.example/cover-800', width: 800, height: 450}
        ];
        assert.strictEqual(pick({thumbnails: playlist_covers}, true), 'https://img.example/cover-800');
        assert.strictEqual(pick({thumbnail: 'https://img.example/cover'}, true), 'https://img.example/cover');
        assert.strictEqual(pick(null, true), null);
    });

    it('Reads the lower bound of a date filter the way yt-dlp does', function () {
        const now = Date.UTC(2026, 2, 31, 15, 30);
        const bound = args => subscriptions_api.getSubscriptionDiscoveryDateLowerBound(args, now);

        assert.strictEqual(bound(['--dateafter', 'now-1week']), Date.UTC(2026, 2, 24));
        assert.strictEqual(bound(['--dateafter', 'now-3days']), Date.UTC(2026, 2, 28));
        assert.strictEqual(bound(['--dateafter', 'today']), Date.UTC(2026, 2, 31));
        assert.strictEqual(bound(['--dateafter', 'yesterday']), Date.UTC(2026, 2, 30));
        // Calendar months with the day clamped: a month before March 31st is February 28th.
        assert.strictEqual(bound(['--dateafter', 'now-1month']), Date.UTC(2026, 1, 28));
        assert.strictEqual(bound(['--dateafter', 'now-1year']), Date.UTC(2025, 2, 31));
        assert.strictEqual(bound(['--dateafter', '20260101']), Date.UTC(2026, 0, 1));
        assert.strictEqual(bound(['--dateafter=20260101']), Date.UTC(2026, 0, 1));
        // The last one given wins, and --date wins over --dateafter.
        assert.strictEqual(bound(['--dateafter', '20250101', '--dateafter', '20260101']), Date.UTC(2026, 0, 1));
        assert.strictEqual(bound(['--date', '20240505', '--dateafter', '20260101']), Date.UTC(2024, 4, 5));
        // No lower bound, or a form yt-dlp itself refuses.
        assert.strictEqual(bound(['--datebefore', '20260101']), null);
        assert.strictEqual(bound(['--dateafter', 'last tuesday']), null);
        assert.strictEqual(bound([]), null);
    });

    it('Leaves a margin before the cutoff that grows with the range', function () {
        const day = 24 * 60 * 60 * 1000;
        const now = Date.UTC(2026, 8, 26);
        assert.strictEqual(subscriptions_api.getSubscriptionListingDateThreshold(now - 7 * day, now), now - 10 * day);
        assert.strictEqual(subscriptions_api.getSubscriptionListingDateThreshold(now - 365 * day, now), now - 365 * day - 36.5 * day);
    });

    it('Dates listing entries by timestamp, or by upload date when that is all there is', function () {
        const lines = subscriptions_api.getListingEntriesDatedBefore([
            {ie_key: 'Youtube', id: 'by-timestamp', timestamp: Date.UTC(2025, 11, 1) / 1000},
            {ie_key: 'Youtube', id: 'by-upload-date', timestamp: null, upload_date: '20251201'},
            {ie_key: 'Youtube', id: 'recent', timestamp: Date.UTC(2026, 0, 2) / 1000},
            // A missing timestamp is not the epoch.
            {ie_key: 'Youtube', id: 'undated', timestamp: null, upload_date: null},
            {id: 'no-extractor', timestamp: 0},
            {extractor_key: 'Youtube', id: 'by-timestamp', timestamp: 0}
        ], Date.UTC(2026, 0, 1));

        assert.deepStrictEqual(lines, ['youtube by-timestamp', 'youtube by-upload-date']);
    });

    it('Lists a channel\'s uploads by date first, so a date filter does not fetch every older upload', async function () {
        const original_runYoutubeDLLineStream = youtubedl_api.runYoutubeDLLineStream;
        const day = 24 * 60 * 60;
        const now_seconds = Math.floor(Date.now() / 1000);
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'dated_listing_sub',
            timerange: 'now-1week',
            channel_id: 'UCzofo-P8yMMCOv8rsPfIR-g',
            source_info_checked_at: Date.now()
        });
        let listing_request = null;
        let discovery_args = null;
        let discovery_archive = null;
        youtubedl_api.runYoutubeDL = async (requested_url, args) => {
            listing_request = {url: requested_url, args: args};
            return {child_process: null, callback: Promise.resolve({parsed_output: [
                {ie_key: 'Youtube', id: 'new-video', timestamp: now_seconds - 2 * day},
                // Inside the margin: left for the exact check.
                {ie_key: 'Youtube', id: 'edge-video', timestamp: now_seconds - 9 * day},
                {ie_key: 'Youtube', id: 'old-video', timestamp: now_seconds - 30 * day},
                {ie_key: 'Youtube', id: 'old-short', timestamp: null, upload_date: '20200101'},
                {ie_key: 'Youtube', id: 'undated-short', timestamp: null, upload_date: null}
            ], err: null})};
        };
        youtubedl_api.runYoutubeDLLineStream = async (requested_url, args) => {
            discovery_args = args;
            const archive_index = args.indexOf('--download-archive');
            discovery_archive = archive_index === -1 ? '' : fs.readFileSync(args[archive_index + 1], 'utf8');
            return {child_process: {pid: 4321}, callback: Promise.resolve({err: null})};
        };

        try {
            await subscriptions_api.subscribe(sub, null, true);
            await checkAndWait(sub.id);
        } finally {
            youtubedl_api.runYoutubeDLLineStream = original_runYoutubeDLLineStream;
        }

        // A channel's own tabs leave Shorts undated; its uploads playlist dates everything.
        assert.strictEqual(listing_request.url, 'https://www.youtube.com/playlist?list=UUzofo-P8yMMCOv8rsPfIR-g');
        assert(listing_request.args.includes('--flat-playlist'));
        assert.strictEqual(listing_request.args[listing_request.args.indexOf('--extractor-args') + 1], 'youtubetab:approximate_date');

        assert.deepStrictEqual(discovery_archive.split('\n').filter(Boolean).sort(), ['youtube old-short', 'youtube old-video']);
        // yt-dlp still makes the exact call on everything the listing did not rule out.
        assert.strictEqual(discovery_args[discovery_args.indexOf('--dateafter') + 1], 'now-1week');
        assert(!discovery_args.includes('--flat-playlist'));
    });

    it('Merges the approximate date into extractor args the user set for the listing', async function () {
        const original_runYoutubeDLLineStream = youtubedl_api.runYoutubeDLLineStream;
        const sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'merged_extractor_args_sub',
            timerange: 'now-1week',
            custom_args: '--extractor-args,,youtubetab:skip=authcheck,,--extractor-args,,youtube:player_client=default',
            source_info_checked_at: Date.now()
        });
        let listing_args = null;
        youtubedl_api.runYoutubeDL = async (requested_url, args) => {
            listing_args = args;
            return {child_process: null, callback: Promise.resolve({parsed_output: [], err: null})};
        };
        youtubedl_api.runYoutubeDLLineStream = async () => ({child_process: {pid: 4321}, callback: Promise.resolve({err: null})});

        try {
            await subscriptions_api.subscribe(sub, null, true);
            await checkAndWait(sub.id);
        } finally {
            youtubedl_api.runYoutubeDLLineStream = original_runYoutubeDLLineStream;
        }

        const extractor_args = listing_args.filter((arg, index) => index > 0 && listing_args[index - 1] === '--extractor-args');
        assert.deepStrictEqual(extractor_args.sort(), ['youtube:player_client=default', 'youtubetab:skip=authcheck;approximate_date']);
    });

    it('Leaves discovery as it was when a dated listing cannot help', async function () {
        const original_runYoutubeDLLineStream = youtubedl_api.runYoutubeDLLineStream;
        const listing_requests = [];
        youtubedl_api.runYoutubeDL = async (requested_url) => {
            listing_requests.push(requested_url);
            return {child_process: null, callback: Promise.resolve({parsed_output: [], err: null})};
        };
        youtubedl_api.runYoutubeDLLineStream = async () => ({child_process: {pid: 4321}, callback: Promise.resolve({err: null})});

        try {
            for (const settings of [
                {name: 'no_date_filter_sub'},
                // Skipped entries would be where --break-on-existing stops.
                {name: 'break_on_existing_sub', timerange: 'now-1week', custom_args: '--break-on-existing'},
                // Entries added to the user's own archive would count as downloaded for good.
                {name: 'own_archive_sub', timerange: 'now-1week', custom_args: '--download-archive,,own-archive.txt'}
            ]) {
                const sub = Object.assign({}, new_sub, settings, {id: uuid(), source_info_checked_at: Date.now()});
                await subscriptions_api.subscribe(sub, null, true);
                await checkAndWait(sub.id);
            }
        } finally {
            youtubedl_api.runYoutubeDLLineStream = original_runYoutubeDLLineStream;
        }

        assert.deepStrictEqual(listing_requests, []);
    });

    it('Fresh uploads', async function() {

    });
});
