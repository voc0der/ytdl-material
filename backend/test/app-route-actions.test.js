const assert = require('assert');
const { createRouteHarness } = require('./helpers/app-routes');
const plain = value => JSON.parse(JSON.stringify(value));

// Routes whose success path was only ever reached through the full server, which runs in
// another process. The handlers are called directly with their collaborators replaced.
describe('Server route actions', function() {
    let harness;
    afterEach(function() { if (harness) harness.close(); harness = null; });

    it('hands an owned download to the downloader and refuses one owned by someone else', async function() {
        const calls = [];
        const downloader = {};
        for (const name of ['clearDownload', 'pauseDownload', 'resumeDownload', 'cancelDownload']) {
            downloader[name] = async uid => { calls.push([name, uid]); return true; };
        }
        downloader.restartDownload = async uid => { calls.push(['restartDownload', uid]); return { uid: 'restarted' }; };
        harness = createRouteHarness({ config: { ytdl_multi_user_mode: true }, dependencies: {
            './db': { initialize() {}, getRecords: async (table, filter) =>
                table === 'download_queue' && filter.uid === 'mine' && filter.user_uid === 'alice' ? [{ uid: 'mine' }] : [] },
            './downloader': downloader
        }});
        const control = (route, user) => harness.request('post', `/api/${route}`, { user: { uid: user }, body: { download_uid: 'mine' } });

        for (const route of ['clearDownload', 'pauseDownload', 'resumeDownload', 'cancelDownload']) {
            assert.deepStrictEqual(plain((await control(route, 'bob')).res.body), { success: false });
            assert.deepStrictEqual(plain((await control(route, 'alice')).res.body), { success: true });
        }
        assert.deepStrictEqual(plain((await control('restartDownload', 'alice')).res.body), { success: true, new_download_uid: 'restarted' });
        assert.deepStrictEqual(calls, [
            ['clearDownload', 'mine'], ['pauseDownload', 'mine'], ['resumeDownload', 'mine'], ['cancelDownload', 'mine'],
            ['restartDownload', 'mine']
        ]);
    });

    it('asks for the advanced download permission before taking custom arguments from an account', async function() {
        const queued = [];
        const granted = { alice: ['advanced_download'], bob: [] };
        harness = createRouteHarness({ config: { ytdl_multi_user_mode: true }, dependencies: {
            './authentication/auth': { ...require('../authentication/auth'), initialize() {},
                userHasPermission: async (uid, permission) => granted[uid].includes(permission) },
            './downloader': { createDownloads: async (url, type, options, user_uid) => {
                queued.push([user_uid, options.customArgs]);
                return [{ uid: `download-${queued.length}` }];
            } }
        }});
        const download = fields => harness.request('post', '/api/downloadFile', {
            setTimeout() {}, body: { url: 'https://example.com/clip', customArgs: '--embed-subs' }, ...fields
        });

        let { res } = await download({});
        assert.deepStrictEqual([res.statusCode, plain(res.body)], [401, { success: false, error: 'Authentication required' }]);
        ({ res } = await download({ user: { uid: 'bob' } }));
        assert.deepStrictEqual([res.statusCode, plain(res.body)], [403, { success: false, error: 'Missing the \'advanced_download\' permission' }]);
        // A shadow session carries its own permissions and never asks the account's.
        ({ res } = await download({ user: { uid: 'bob' }, shadow_permissions: ['advanced_download'] }));
        assert.strictEqual(res.body.download.uid, 'download-1');
        ({ res } = await download({ user: { uid: 'alice' } }));
        assert.strictEqual(res.body.download.uid, 'download-2');
        assert.deepStrictEqual(queued, [['bob', '--embed-subs'], ['alice', '--embed-subs']]);

        ({ res } = await download({ user: { uid: 'alice' }, body: { url: 'https://example.com/clip' } }));
        assert.strictEqual(res.body.download.uid, 'download-3');
    });

    it('answers a server error when the downloader queues nothing', async function() {
        harness = createRouteHarness({ dependencies: { './downloader': { createDownloads: async () => [] } } });
        const { res } = await harness.request('post', '/api/downloadFile', { setTimeout() {}, body: { url: 'https://example.com/clip' } });
        assert.strictEqual(res.statusCode, 500);
    });

    it('turns sharing on and off for playlists without accounts, but not for a subscription', async function() {
        const updates = [];
        harness = createRouteHarness({ dependencies: {
            './db': { initialize() {}, updateRecord: async (table, filter, update) => { updates.push([table, filter, update]); return true; } }
        }});
        const toggle = (route, body) => harness.request('post', `/api/${route}`, { body });

        assert.strictEqual((await toggle('enableSharing', { uid: 'list', is_playlist: true })).res.body.success, true);
        assert.strictEqual((await toggle('disableSharing', { uid: 'list', is_playlist: true })).res.body.success, true);
        assert.strictEqual((await toggle('disableSharing', { uid: 'channel', type: 'subscription' })).res.body.success, false);
        assert.deepStrictEqual(plain(updates), [
            ['playlists', { id: 'list' }, { sharingEnabled: true }],
            ['playlists', { id: 'list' }, { sharingEnabled: false }]
        ]);
    });

    it('lists only the signed-in account\'s audio and playlists', async function() {
        const queries = [];
        harness = createRouteHarness({ dependencies: {
            './db': { initialize() {}, getRecords: async (table, filter = {}) => {
                queries.push([table, filter]);
                return filter.user_uid ? [{ table, owner: filter.user_uid }] : [{ table, owner: 'everyone' }];
            } }
        }});
        const { res } = await harness.request('get', '/api/getMp3s', { user: { uid: 'alice' } });
        assert.deepStrictEqual(plain(res.body), { mp3s: [{ table: 'files', owner: 'alice' }], playlists: [{ table: 'playlists', owner: 'alice' }] });
        assert.deepStrictEqual(plain(queries.slice(-2)), [['files', { user_uid: 'alice', isAudio: true }], ['playlists', { user_uid: 'alice' }]]);
    });

    it('runs the administrator\'s maintenance actions and reports what they return', async function() {
        const calls = [];
        harness = createRouteHarness({ dependencies: {
            './youtube-dl': { ...require('../youtube-dl'), killAllDownloads: async () => { calls.push(['kill']); return { success: true, killed: 2 }; } },
            './files': { deleteOrphanFiles: async owner => { calls.push(['orphans', owner]); return { success: true, deleted: 3 }; } }
        }});
        harness.context.updateServer = async tag => { calls.push(['update', tag]); return true; };

        assert.strictEqual((await harness.request('get', '/api/updaterStatus')).res.statusCode, 404);
        assert.deepStrictEqual(plain((await harness.request('post', '/api/killAllDownloads')).res.body), { success: true, killed: 2 });
        assert.deepStrictEqual(plain((await harness.request('post', '/api/deleteOrphanFiles', { user: { uid: 'admin' } })).res.body), { success: true, deleted: 3 });
        assert.deepStrictEqual(plain((await harness.request('post', '/api/updateServer', { body: { tag: 'v9.9.9' } })).res.body), { success: true });
        assert.deepStrictEqual(calls, [['kill'], ['orphans', 'admin'], ['update', 'v9.9.9']]);
    });

    it('tests a Redis connection string against Redis rather than the database', async function() {
        const tested = [];
        harness = createRouteHarness({ dependencies: {
            './redis-store': { ...require('../redis-store'), testConnectionString: async value => { tested.push(value); return { success: false, error: 'refused' }; } },
            './db': { initialize() {}, connectToDB: async () => { throw new Error('the database was asked'); } }
        }});
        const { res } = await harness.request('post', '/api/testConnectionString', { body: { connection_string: 'redis://cache:6379' } });
        assert.deepStrictEqual(plain(res.body), { success: false, error: 'refused' });
        assert.deepStrictEqual(tested, ['redis://cache:6379']);
    });

    it('keeps account changes to the modes they belong to', async function() {
        const changed = [];
        harness = createRouteHarness({ dependencies: {
            './authentication/auth': { ...require('../authentication/auth'), initialize() {},
                changeUserPassword: async (uid, password) => { changed.push([uid, password]); return true; } },
            './authentication/oidc': { ...require('../authentication/oidc'), isEnabled: () => true }
        }});

        // Without accounts there is nobody to prove anything to.
        let { res } = await harness.request('post', '/api/auth/changePassword', { body: { user_uid: 'admin', new_password: 'next' } });
        assert.deepStrictEqual(plain(res.body), { success: true });
        assert.deepStrictEqual(changed, [['admin', 'next']]);

        ({ res } = await harness.request('post', '/api/setLibrarySharing', { user: { uid: 'admin' }, body: { enabled: true } }));
        assert.deepStrictEqual([res.statusCode, res.body.error], [400, 'Libraries are only shared in multi-user mode, where there is more than one.']);

        ({ res } = await harness.request('post', '/api/auth/register', { body: { userid: 'eve', username: 'eve', password: 'pw' } }));
        assert.deepStrictEqual([res.statusCode, res.body], [403, 'Registration is disabled when OIDC is enabled.']);
    });

    it('refuses a Telegram link whose address cannot be parsed', async function() {
        const downloads = [];
        harness = createRouteHarness({ config: {
            ytdl_use_telegram_API: true, ytdl_telegram_webhook_secret: 'secret', ytdl_telegram_chat_id: '123'
        }, dependencies: { './downloader': { createDownload: (...args) => downloads.push(args) } } });
        const { res } = await harness.request('post', '/api/telegramRequest', {
            get: () => 'secret', body: { message: { text: 'https://example.com:99999/clip', chat: { id: 123 } } }
        });
        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(downloads, []);
        assert(harness.messages.some(([level, message]) => level === 'error' && message === 'Invalid Telegram request received! URL protocol is not allowed.'));
    });
});
