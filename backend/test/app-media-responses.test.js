const assert = require('assert');
const path = require('path');
const { createRouteHarness } = require('./helpers/app-routes');
const plain = value => JSON.parse(JSON.stringify(value));

describe('Media route responses', function() {
    let harness;
    afterEach(function() { if (harness) harness.close(); });

    describe('container downloads', function() {
        let files;
        let subscription;
        let playlist;
        let output;
        let archives;
        let removed;
        let filesystem;
        let options;
        beforeEach(function() {
            files = [{ uid: 'clip', path: '/media/clip.mp4' }];
            subscription = { id: 'sub', name: 'Channel' };
            playlist = { id: 'mix', name: 'Road trip', uids: ['missing', 'clip'] };
            output = 'appdata/container-test.zip';
            archives = [];
            removed = [];
            filesystem = { existsSync: () => false, unlinkSync: file => removed.push(file) };
            options = { headers: { 'Cache-Control': 'no-store' } };
            harness = createRouteHarness({ config: { ytdl_multi_user_mode: true }, dependencies: {
                'fs-extra': filesystem,
                './db': { initialize() {}, getRecords: async (table, filter) => {
                    assert.strictEqual(table, 'files');
                    assert.deepStrictEqual(plain(filter), { sub_id: 'sub', user_uid: 'alice' });
                    return files;
                } },
                './files': {
                    getPlaylist: async (id, owner) => { assert.strictEqual(owner, 'alice'); return playlist; },
                    getVideo: async uid => files.find(file => file.uid === uid)
                },
                './subscriptions': { getSubscription: async (id, owner) => { assert.strictEqual(owner, 'alice'); return subscription; } },
                './utils': {
                    isServableMediaFile: () => true,
                    sendFileOptions: () => options,
                    createContainerZipFile: async (name, records, owner, { signal }) => {
                        archives.push({ name, records, owner, signal });
                        return output;
                    }
                }
            }});
        });
        const request = body => ({ body: { uuid: 'spoofed', ...body }, user: { uid: 'alice' } });

        for (const type of ['playlist', 'subscription']) {
            it(`builds a ${type} archive, sends a display name and removes the temporary file`, async function() {
                let sent;
                const body = type === 'playlist' ? { playlist_id: 'mix' } : { sub_id: 'sub' };
                const { req, res } = await harness.request('post', '/api/downloadFileFromServer', request(body), {
                    download: (...args) => { sent = args; }
                });
                assert.strictEqual(sent[0], path.join(harness.root, output));
                assert.strictEqual(sent[1], type === 'playlist' ? 'Road trip.zip' : 'Channel.zip');
                assert.strictEqual(sent[2], options);
                assert.deepStrictEqual(plain(archives[0].records), files);
                assert.strictEqual(archives[0].owner, 'alice');
                assert.strictEqual(archives[0].signal.aborted, false);
                assert.strictEqual(req.listenerCount('aborted'), 0);
                assert.strictEqual(res.listenerCount('close'), 0);
                sent[3](null);
                assert.deepStrictEqual(removed, [sent[0]]);
            });
        }

        it('removes the archive after a send error and logs a cleanup failure', async function() {
            let afterSend;
            await harness.request('post', '/api/downloadFileFromServer', request({ playlist_id: 'mix' }), {
                download: (file, name, opts, callback) => { afterSend = callback; }
            });
            const failure = new Error('disconnected');
            filesystem.unlinkSync = () => { throw new Error('busy'); };
            afterSend(failure);
            assert(harness.messages.some(([, message]) => message === failure));
            assert(harness.messages.some(([, message]) => String(message).includes('Failed to remove file')));
        });

        it('returns missing containers and failed archives without attempting to send', async function() {
            const route = '/api/downloadFileFromServer';
            playlist = null;
            subscription = null;
            assert.strictEqual((await harness.request('post', route, request({ playlist_id: 'missing' }))).res.statusCode, 404);
            assert.strictEqual((await harness.request('post', route, request({ sub_id: 'sub' }))).res.statusCode, 404);
            playlist = { name: 'Empty', uids: [] };
            output = null;
            assert.strictEqual((await harness.request('post', route, request({ playlist_id: 'mix' }))).res.statusCode, 500);
            const result = await harness.request('post', route, { ...request({ playlist_id: 'mix' }), aborted: true });
            assert.strictEqual(result.res.statusCode, 200, 'an aborted request must not receive a second response');
        });
    });

    it('serves only a ready transcoded copy and advertises retry timing while pending', async function() {
        let copy = { status: 'pending' };
        const reads = [];
        const file = { uid: 'clip', path: '/media/original.mkv' };
        harness = createRouteHarness({ dependencies: {
            'fs-extra': { existsSync: value => value.startsWith('/media/'), statSync: () => ({ size: 10 }),
                createReadStream: value => { reads.push(value); return value; } },
            './files': { getVideo: async () => file },
            './playback-transcode': { getCopy: uid => { assert.strictEqual(uid, 'clip'); return copy; } },
            './utils': { isServableMediaFile: () => true, parseByteRange: () => null, pipeMediaFileToResponse: (stream, res) => res.send(stream) }
        }});
        const request = { playback: { uid: 'clip', owner: 'alice', transcode: true } };
        let response = await harness.request('get', '/api/stream', request);
        assert.strictEqual(response.res.statusCode, 503);
        assert.strictEqual(response.res.headers['Retry-After'], '10');
        copy = { status: 'failed' };
        assert.strictEqual((await harness.request('get', '/api/stream', request)).res.statusCode, 500);
        copy = { status: 'missing' };
        assert.strictEqual((await harness.request('get', '/api/stream', request)).res.statusCode, 404);
        assert.deepStrictEqual(reads, []);
        copy = { status: 'ready', path: '/media/copy.mp4' };
        response = await harness.request('get', '/api/stream', request, {
            writeHead(code, headers) { this.statusCode = code; this.headers = headers; }
        });
        assert.strictEqual(response.res.body, '/media/copy.mp4');
        assert.deepStrictEqual(reads, ['/media/copy.mp4']);
        assert.strictEqual(response.res.headers['Content-Type'], 'video/mp4');
    });

    it('normalizes subtitle indices and refuses missing files or tracks', async function() {
        let file = { uid: 'clip' };
        let sidecar = 'video/clip.vtt';
        let exists = true;
        const indices = [];
        harness = createRouteHarness({ dependencies: {
            'fs-extra': { existsSync: value => value.endsWith('.vtt') && exists },
            './files': { getVideo: async () => file, ensureSubtitleSidecarForFile: async (value, index) => { indices.push(index); return sidecar; } },
            './utils': { sendFileOptions: () => ({}) }
        }});
        const get = (query = {}) => harness.request('get', '/api/streamSubtitle', { query }, {
            sendFile(value) { this.file = value; }
        });
        assert.strictEqual((await get()).res.statusCode, 400);
        for (const index of ['-1', '1.5', 'bogus', '2']) {
            assert.strictEqual((await get({ uid: 'clip', index })).res.file, path.join(harness.root, sidecar));
        }
        assert.deepStrictEqual(indices, [0, 0, 0, 2]);
        exists = false;
        assert.strictEqual((await get({ uid: 'clip' })).res.statusCode, 404);
        sidecar = null;
        assert.strictEqual((await get({ uid: 'clip' })).res.statusCode, 404);
        file = null;
        assert.strictEqual((await get({ uid: 'clip' })).res.statusCode, 404);
    });

    for (const [route, moduleName, method] of [
        ['/api/thumbnail/:uid', './files', 'getThumbnailPathForUser'],
        ['/api/subscriptionArtwork/:sub_id', './subscriptions', 'getSubscriptionArtworkPath']
    ]) {
        it(`reports send failures for ${route} only before response headers are sent`, async function() {
            harness = createRouteHarness({ dependencies: {
                [moduleName]: { [method]: async () => '/art.jpg' }, './utils': { sendFileOptions: () => ({}) }
            }});
            for (const [error, headersSent, expected] of [[{ statusCode: 404 }, false, 404], [new Error('I/O'), false, 500], [new Error('late'), true, 200]]) {
                const { res } = await harness.request('get', route, {}, {
                    headersSent,
                    sendFile(file, options, callback) { assert.strictEqual(file, '/art.jpg'); callback(error); }
                });
                assert.strictEqual(res.statusCode, expected);
            }
        });
    }
});
