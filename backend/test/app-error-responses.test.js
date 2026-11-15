const assert = require('assert');
const { createRouteHarness } = require('./helpers/app-routes');
const plain = value => JSON.parse(JSON.stringify(value));

describe('Server error responses', function() {
    let harness;
    afterEach(function() { if (harness) harness.close(); });

    // It logged that registration failed, then registered the account anyway.
    it('refuses a registration without a user id or name', async function() {
        const registered = [];
        harness = createRouteHarness({ config: { ytdl_allow_registration: true }, dependencies: {
            './authentication/auth': { ...require('../authentication/auth'), initialize() {},
                registerUser: async (...args) => { registered.push(args); return { uid: args[0], name: args[1] }; } }
        }});
        for (const body of [{ userid: 'eve', password: 'pw' }, { username: 'eve', password: 'pw' }]) {
            assert.strictEqual((await harness.request('post', '/api/auth/register', { body })).res.statusCode, 409);
        }
        assert.deepStrictEqual(registered, []);
        assert.deepStrictEqual(harness.messages.filter(([level]) => level === 'error').map(([, message]) => message), [
            'Registration failed for user eve. Username or userid is invalid.',
            'Registration failed for user undefined. Username or userid is invalid.'
        ]);
    });

    it('accepts URLs only from the configured webhook chat and an existing requested owner', async function() {
        const downloads = [];
        const notifications = [];
        harness = createRouteHarness({ config: {
            ytdl_use_telegram_API: true, ytdl_telegram_webhook_secret: 'secret', ytdl_telegram_chat_id: '123'
        }, dependencies: {
            './db': { initialize() {}, getRecord: async (table, filter) => filter.uid === 'alice' ? { uid: 'alice' } : null },
            './downloader': { createDownload: (...args) => downloads.push(args) },
            './notifications': { sendTelegramNotification: payload => notifications.push(payload) }
        }});
        const request = (text, owner = 'alice', chat = 123) => harness.request('post', '/api/telegramRequest', {
            get: () => 'secret', body: { message: { text, chat: { id: chat } } }, query: { user_uid: owner }
        });
        assert.strictEqual((await request('Please download https://example.com/first and https://example.com/second')).res.statusCode, 200);
        assert.deepStrictEqual(plain(downloads), [['https://example.com/first', 'video', {}, 'alice']]);
        assert.strictEqual((await request('https://example.com/clip', 'unknown')).res.statusCode, 400);
        assert.strictEqual((await request('https://example.com/clip', 'alice', 999)).res.statusCode, 403);
        assert.strictEqual(downloads.length, 1);
        assert.strictEqual((await request('not a link')).res.statusCode, 400);
        assert.strictEqual(notifications.length, 1);
        assert.strictEqual(notifications[0].title, 'Invalid Telegram Request');
        assert.strictEqual((await request('https://example.com/clip', null)).res.statusCode, 200);
        assert.strictEqual(downloads[1][3], null);
    });

    it('limits active snips, records thrown failures and hides jobs from another owner', async function() {
        const jobs = [];
        harness = createRouteHarness({ dependencies: { './files': { snipFile: (uid, start, end, owner, progress) =>
            new Promise((resolve, reject) => jobs.push({ resolve, reject, progress, owner })) } } });
        const start = () => harness.request('post', '/api/snipFile', { user: { uid: 'alice' }, body: { uid: 'clip', start: 1, end: 3 } });
        const started = await Promise.all([start(), start(), start()]);
        assert.strictEqual((await start()).res.body.success, false);
        assert.strictEqual(jobs.length, 3);
        jobs[0].progress(45);
        const job_uid = started[0].res.body.job_uid;
        let status = await harness.request('post', '/api/getSnipStatus', { user: { uid: 'alice' }, body: { job_uid } });
        assert.strictEqual(status.res.body.percent, 45);
        assert.strictEqual((await harness.request('post', '/api/getSnipStatus', { user: { uid: 'bob' }, body: { job_uid } })).res.body.success, false);
        jobs[0].reject(new Error('encoder crashed'));
        await new Promise(resolve => setImmediate(resolve));
        status = await harness.request('post', '/api/getSnipStatus', { user: { uid: 'alice' }, body: { job_uid } });
        assert.strictEqual(status.res.body.status, 'failed');
        assert.strictEqual(status.res.body.error, 'Snip failed unexpectedly');
        // Completed jobs age out while running ones remain visible.
        const stored = harness.read('snipJobs');
        stored[job_uid].finished = Date.now() - 31 * 60 * 1000;
        harness.context.pruneSnipJobs();
        assert.strictEqual(stored[job_uid], undefined);
        assert.strictEqual(harness.context.countActiveSnipJobs(), 2);
        jobs[1].resolve({ success: false, error: 'invalid range' });
        jobs[2].resolve({ success: true, file: { uid: 'snip' } });
        await new Promise(resolve => setImmediate(resolve));
    });

    it('reports failed playlist deletion while preserving its partial counts', async function() {
        const db = { initialize() {}, getRecord: async () => ({ id: 'mix', uids: ['clip'] }), removeRecord: async () => true };
        harness = createRouteHarness({ dependencies: {
            './db': db, './files': { deleteFilesInBatches: async () => ({ deleted_count: 2, failed_count: 1 }) }
        }});
        const request = { body: { playlist_id: 'mix', delete_files: true } };
        const result = await harness.request('post', '/api/deletePlaylist', request);
        assert.deepStrictEqual(plain(result.res.body), { success: false, playlist_removed: true, deleted_file_count: 2, failed_file_count: 1 });
        db.removeRecord = async () => { throw new Error('database unavailable'); };
        assert.strictEqual((await harness.request('post', '/api/deletePlaylist', request)).res.body.success, false);
    });

    it('reports sharing write failures and refuses malformed file updates', async function() {
        harness = createRouteHarness({ dependencies: { './db': {
            initialize() {}, updateRecord: async () => { throw new Error('database unavailable'); }
        } }});
        for (const route of ['/api/enableSharing', '/api/disableSharing']) {
            assert.strictEqual((await harness.request('post', route, { body: { uid: 'clip' } })).res.body.success, false);
        }
        for (const change_obj of [null, 'title', []]) {
            assert.strictEqual((await harness.request('post', '/api/updateFile', { body: { uid: 'clip', change_obj } })).res.body.error, 'No changes provided');
        }
    });

    it('reports account update and deletion exceptions instead of successful mutations', async function() {
        const auth = require('../authentication/auth');
        harness = createRouteHarness({ dependencies: {
            './authentication/auth': { ...auth, initialize() {}, deleteUser: async () => { throw new Error('database unavailable'); } },
            './authentication/shadow': { updateUser: async () => { throw new Error('database unavailable'); } }
        }});
        for (const route of ['/api/updateUser', '/api/deleteUser']) {
            assert.strictEqual((await harness.request('post', route, { body: { uid: 'alice' } })).res.body.success, false);
        }
    });
});
