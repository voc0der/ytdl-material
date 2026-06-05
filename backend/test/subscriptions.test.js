/* eslint-disable no-undef */
const { assert, path, fs, uuid, db_api, subscriptions_api, archive_api, youtubedl_api, config_api } = require('./test-shared');

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
    beforeEach(async function() {
        await db_api.removeAllRecords('subscriptions');
        await db_api.removeAllRecords('download_queue');
        await db_api.removeAllRecords('files');
        await db_api.removeAllRecords('archives');
        config_api.setConfigItem('ytdl_allow_subscriptions', true);
        config_api.setConfigItem('ytdl_subscriptions_redownload_fresh_uploads', false);
        config_api.setConfigItem('ytdl_custom_args', '');
        config_api.setConfigItem('ytdl_skip_join_only_videos', false);
        config_api.setConfigItem('ytdl_replace_invalid_filename_chars', false);
        config_api.setConfigItem('ytdl_invalid_filename_chars', '\\/:*?"<>|');
        config_api.setConfigItem('ytdl_invalid_filename_replacement', '_');
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
        const playlist_end_index = captured_args.indexOf('--playlist-end');
        assert(captured_args.includes('--resize-buffer'));
        assert(sleep_interval_index !== -1);
        assert.strictEqual(captured_args[sleep_interval_index + 1], '2');
        assert(playlist_end_index !== -1);
        assert.strictEqual(captured_args[playlist_end_index + 1], '1');
    });
    it('Unsubscribe', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        await subscriptions_api.unsubscribe(new_sub);
        const sub_exists = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert(!sub_exists);
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
    it('Checks valid subscriptions in round-robin order', async function() {
        const original_get_videos_for_sub = subscriptions_api.getVideosForSub;
        const checked_sub_ids = [];
        const sub_one = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'round_robin_sub_one',
            paused: false
        });
        const sub_two = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'round_robin_sub_two',
            url: 'https://www.youtube.com/channel/round-robin-two',
            paused: false
        });
        const paused_sub = Object.assign({}, new_sub, {
            id: uuid(),
            name: 'round_robin_paused_sub',
            url: 'https://www.youtube.com/channel/round-robin-paused',
            paused: true
        });

        subscriptions_api.getVideosForSub = async (sub_id) => {
            checked_sub_ids.push(sub_id);
            return true;
        };

        try {
            subscriptions_api.resetSubscriptionCheckCursor();
            await db_api.insertRecordIntoTable('subscriptions', sub_one);
            await db_api.insertRecordIntoTable('subscriptions', sub_two);
            await db_api.insertRecordIntoTable('subscriptions', paused_sub);

            const first_result = await subscriptions_api.checkNextSubscription();
            const second_result = await subscriptions_api.checkNextSubscription();

            assert.strictEqual(first_result.checked, true);
            assert.strictEqual(second_result.checked, true);
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
    it('Update subscription', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        const sub_update = Object.assign({}, new_sub, {name: 'updated_name'});
        await subscriptions_api.updateSubscription(sub_update);
        const updated_sub = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert(updated_sub['name'] === 'updated_name');
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
    it('Fresh uploads', async function() {

    });
});
