/* eslint-disable no-undef */
const { assert, path, fs, uuid, db_api, subscriptions_api, youtubedl_api, config_api } = require('./test-shared');

describe('Subscriptions', function() {
    const downloader_api = require('../downloader');
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
        config_api.setConfigItem('ytdl_subscriptions_redownload_fresh_uploads', false);
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
    it('Unsubscribe', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        await subscriptions_api.unsubscribe(new_sub);
        const sub_exists = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert(!sub_exists);
    });
    it('Delete subscription file', async function () {
        
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
