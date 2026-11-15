const assert = require('assert');
const { createRouteHarness } = require('./helpers/app-routes');
const plain = value => JSON.parse(JSON.stringify(value));

// Route answers that only a failure, a missing record or an unusual caller reaches. Each handler
// is called directly with the collaborators it would fail on replaced.
describe('Server route edges', function() {
    let harness;
    afterEach(function() { if (harness) harness.close(); harness = null; });
    const logged = level => harness.messages.filter(([message_level]) => message_level === level).map(([, message]) => String(message));

    it('refuses to build arguments with custom ones for someone who has not signed in', async function() {
        harness = createRouteHarness({ config: { ytdl_multi_user_mode: true } });
        const { res } = await harness.request('post', '/api/generateArgs', { body: { url: 'https://example.com/clip', customArgs: '--embed-subs' } });
        assert.deepStrictEqual([res.statusCode, plain(res.body)], [401, { success: false, error: 'Authentication required' }]);
    });

    describe('counting a view from a share link', function() {
        let counted;
        beforeEach(function() {
            counted = [];
            harness = createRouteHarness({ config: { ytdl_multi_user_mode: true }, dependencies: {
                './files': {
                    getPlaylist: async (id, owner, shared) => id === 'mix' && owner === 'alice' && shared ? { uids: ['clip'] } : null,
                    getVideo: async (uid, owner) => ({ uid, user_uid: owner, local_view_count: 2 })
                },
                './db': { initialize() {}, setVideoProperty: async (uid, change, owner) => { counted.push([uid, change, owner]); return true; } }
            }});
        });
        const view = body => harness.request('post', '/api/incrementViewCount', { body: { file_uid: 'clip', ...body } });

        it('asks who shared it', async function() {
            assert.strictEqual((await view({})).res.statusCode, 401);
        });

        it('counts a file the shared playlist holds, and nothing it does not', async function() {
            assert.strictEqual((await view({ uuid: 'alice', playlist_id: 'mix' })).res.statusCode, 200);
            assert.strictEqual((await view({ uuid: 'alice', playlist_id: 'other' })).res.statusCode, 401);
            assert.deepStrictEqual(plain(counted), [['clip', { local_view_count: 3 }, 'alice']]);
        });
    });

    it('takes settings saved under the config\'s old top-level name', async function() {
        const saved = [];
        const config = require('../config');
        const values = { ytdl_multi_user_mode: false, ytdl_reverse_proxy_whitelist: '' };
        harness = createRouteHarness({ dependencies: {
            './config.js': { ...config, initialize() {}, configExistsCheck() {}, getConfigItem: key => values[key],
                getConfigFile: () => ({ YtdlMaterial: { Users: {} } }),
                setConfigFile: file => { saved.push(plain(file)); return true; } }
        }});
        const legacy_root = ['Youtube', 'DLMaterial'].join('');

        const { res } = await harness.request('post', '/api/setConfig', { body: { new_config_file: { [legacy_root]: { Host: { url: 'https://example.com' } } } } });

        assert.deepStrictEqual(plain(res.body), { success: true });
        assert.deepStrictEqual(saved, [{ YtdlMaterial: { Host: { url: 'https://example.com' } } }]);
    });

    it('answers a server error when a subscription file cannot be deleted', async function() {
        harness = createRouteHarness({ dependencies: { './files': {
            getVideo: async uid => ({ uid, sub_id: 'sub' }), deleteFile: async () => false
        } } });
        const { res } = await harness.request('post', '/api/deleteSubscriptionFile', { body: { file_uid: 'clip' } });
        assert.strictEqual(res.statusCode, 500);
    });

    it('adds nothing to a playlist it cannot find', async function() {
        const updated = [];
        harness = createRouteHarness({ dependencies: { './files': {
            getPlaylist: async () => null, updatePlaylist: async playlist => { updated.push(playlist); return true; }
        } } });
        const { res } = await harness.request('post', '/api/addFileToPlaylist', { body: { playlist_id: 'gone', file_uid: 'clip' }, user: { uid: 'alice' } });
        assert.deepStrictEqual(plain(res.body), { success: false });
        assert.deepStrictEqual(updated, []);
    });

    it('refuses to send a file whose path is not a regular file in its owner\'s media folder', async function() {
        harness = createRouteHarness({ dependencies: {
            './files': { getVideo: async uid => ({ uid, path: '/etc/passwd', user_uid: null }) },
            './utils': { isServableMediaFile: () => false }
        }});
        const { res } = await harness.request('post', '/api/downloadFileFromServer', { body: { uid: 'clip' } });
        assert.strictEqual(res.statusCode, 404);
        assert.deepStrictEqual(logged('error'), ['Refusing to send clip: its path is not a regular file inside its owner\'s media folder.']);
    });

    it('answers a bad request for an archive that cannot be made', async function() {
        harness = createRouteHarness({ dependencies: { './archive': { generateArchive: async () => null } } });
        const { res } = await harness.request('post', '/api/downloadArchive', { body: { type: 'video' } });
        assert.strictEqual(res.statusCode, 400);
    });

    describe('streaming', function() {
        let servable;
        let exists;
        let piped;
        beforeEach(function() {
            servable = true;
            exists = true;
            piped = [];
            harness = createRouteHarness({ dependencies: {
                'fs-extra': { existsSync: file => String(file).startsWith('/media/') && exists, statSync: () => ({ size: 10 }), createReadStream: (file, range) => ({ file, range }) },
                './files': { getVideo: async uid => ({ uid, path: '/media/clip.mp4', user_uid: null }) },
                './utils': { isServableMediaFile: () => servable, parseByteRange: () => ({ start: 0, end: 4, length: 5 }),
                    pipeMediaFileToResponse: stream => piped.push(stream) }
            }});
        });
        const stream = fields => harness.request('get', '/api/stream', { query: { uid: 'clip' }, headers: { range: 'bytes=0-4' }, ...fields }, {
            writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
            end() { this.ended = true; }
        });

        it('refuses a file whose path is not a regular file in its owner\'s media folder', async function() {
            servable = false;
            const { res } = await stream();
            assert.deepStrictEqual([res.statusCode, res.body], [404, 'Media file not found']);
            assert.deepStrictEqual(logged('error'), ['Refusing to stream clip: its path is not a regular file inside its owner\'s media folder.']);
        });

        it('says when the file is gone from the disk', async function() {
            exists = false;
            const { res } = await stream();
            assert.deepStrictEqual([res.statusCode, res.body], [404, 'Media file not found']);
            assert.deepStrictEqual(logged('error'), ['File /media/clip.mp4 could not be found! UID: clip, ID: undefined']);
        });

        it('answers a HEAD for part of a file with its headers alone', async function() {
            const { res } = await stream({ method: 'HEAD' });
            assert.strictEqual(res.statusCode, 206);
            assert.strictEqual(res.headers['Content-Range'], 'bytes 0-4/10');
            assert.strictEqual(res.ended, true);
            assert.deepStrictEqual(piped, []);
        });
    });

    it('lists a download saved without an id by what it holds', async function() {
        const records = [[{ title: 'File', container: { uid: 'clip', title: 'Clip' } }], [{ title: 'Playlist', container: { id: 'mix', uids: ['a'] } }],
            [{ title: 'Odd', container: { name: 'neither' } }]];
        harness = createRouteHarness({ dependencies: { './db': { initialize() {}, getRecords: async () => records.shift() } } });

        const containers = [];
        for (let i = 0; i < 3; i++) {
            const { res } = await harness.request('post', '/api/download', { body: { download_uid: 'legacy' } });
            containers.push(plain(res.body.download.container));
            assert.strictEqual(res.body.download.error, null);
        }

        assert.deepStrictEqual(containers, [{ uid: 'clip' }, { id: 'mix', uids: [] }, null]);
    });

    describe('tasks', function() {
        it('lists a task this version no longer has as it was saved', async function() {
            harness = createRouteHarness({ dependencies: { './db': { initialize() {},
                getRecords: async () => [{ key: 'retired_task', next_invocation: 123, schedule: null }] } } });
            const { res } = await harness.request('post', '/api/getTasks');
            assert.deepStrictEqual(plain(res.body), { tasks: [{ key: 'retired_task', schedule: null }] });
            assert(harness.messages.some(([level, message]) => level === 'verbose' && message === 'Task retired_task does not exist!'));
        });

        it('answers at once for a task that runs in the background, and logs it if it fails', async function() {
            let fail;
            const failed = new Promise(resolve => { fail = resolve; });
            harness = createRouteHarness({ dependencies: {
                './db': { initialize() {}, getRecord: async (table, filter) => ({ key: filter.key }) },
                './tasks': { TASKS: { long_task: { runInBackground: true } }, executeRun: () => failed.then(() => { throw new Error('ran out of disk'); }) }
            }});

            const { res } = await harness.request('post', '/api/runTask', { body: { task_key: 'long_task' } });
            assert.deepStrictEqual(plain(res.body), { success: true });

            fail();
            await new Promise(resolve => setImmediate(resolve));
            assert.deepStrictEqual(logged('error'), ['Task \'long_task\' failed: ran out of disk']);
        });
    });

    describe('logs', function() {
        it('says where it looked when there is no log file', async function() {
            harness = createRouteHarness({ dependencies: { 'fs-extra': { existsSync: () => false, pathExists: async () => false } } });
            const { res } = await harness.request('post', '/api/logs', { body: {} });
            assert.deepStrictEqual(plain(res.body), { logs: null, success: false });
            assert.deepStrictEqual(logged('error'), ['Failed to find logs file at the expected location: appdata/logs/combined.log']);
        });

        it('reports a failure to clear them', async function() {
            harness = createRouteHarness({ dependencies: { 'fs-extra': { existsSync: () => false,
                writeFile: async () => { throw new Error('read-only file system'); } } } });
            const { res } = await harness.request('post', '/api/clearAllLogs');
            assert.deepStrictEqual(plain(res.body), { success: false });
            assert.deepStrictEqual(logged('error'), ['Error: read-only file system']);
        });
    });

    it('asks for a sign-in before changing a password when accounts are on', async function() {
        harness = createRouteHarness({ config: { ytdl_multi_user_mode: true } });
        const { res } = await harness.request('post', '/api/auth/changePassword', { body: { new_password: 'secret' } });
        assert.deepStrictEqual([res.statusCode, plain(res.body)], [401, { success: false, error: 'Authentication required' }]);
    });
});
