const assert = require('assert');
const path = require('path');
const { createRouteHarness } = require('./helpers/app-routes');

const plain = value => JSON.parse(JSON.stringify(value));

describe('Server integration responses', function() {
    let harness;
    afterEach(function() { if (harness) harness.close(); });

    describe('OIDC callbacks', function() {
        let oidc;
        let auth;
        let allowed;
        let account;
        beforeEach(function() {
            allowed = true;
            account = { uid: 'alice' };
            oidc = {
                isEnabled: () => true,
                createAuthorizationURL: async (returnTo, handoff) => `https://id.example.test/?state=${encodeURIComponent(returnTo)}`
                    + (handoff === undefined ? '' : `&handoff=${encodeURIComponent(handoff)}`),
                consumeAuthorizationCallback: async () => ({ claims: { sub: 'identity' }, return_to: '/downloads?tab=active' }),
                isClaimsAllowed: () => allowed,
                getConfiguration: () => ({ auto_register: true, groups_claim: 'groups' })
            };
            auth = {
                initialize() {}, passport: { initialize() {}, authenticate() {}, authorize() {} },
                upsertOIDCUser: async (claims, options) => {
                    assert.strictEqual(claims.sub, 'identity');
                    assert.strictEqual(options.auto_register, true);
                    assert.strictEqual(options.groups_claim, 'groups');
                    return account;
                },
                getAuthResponseObject: async user => { assert.strictEqual(user, account); return { token: 'token+/=' }; }
            };
            harness = createRouteHarness({ dependencies: { './authentication/oidc': oidc, './authentication/auth': auth } });
            harness.context.getOrigin = () => 'https://media.example.test';
        });

        it('redirects sign-in with a preserved return path and handles provider failures', async function() {
            let result = await harness.request('get', '/api/auth/oidc/login', { query: { returnTo: '/subscriptions' } });
            assert.strictEqual(result.res.location, 'https://id.example.test/?state=%2Fsubscriptions');
            result = await harness.request('get', '/api/auth/oidc/login');
            assert.strictEqual(result.res.location, 'https://id.example.test/?state=%2F');
            // The browser's handoff value goes to the module, which decides whether it is usable.
            result = await harness.request('get', '/api/auth/oidc/login', { query: { returnTo: '/', handoff: 'tab-value' } });
            assert.strictEqual(result.res.location, 'https://id.example.test/?state=%2F&handoff=tab-value');
            oidc.createAuthorizationURL = async () => { throw new Error('provider offline'); };
            assert.strictEqual((await harness.request('get', '/api/auth/oidc/login')).res.statusCode, 500);
        });

        it('issues an encoded session redirect after a permitted callback', async function() {
            const { res } = await harness.request('get', '/api/auth/oidc/callback');
            assert.strictEqual(res.location, 'https://media.example.test/login#oidc_token=token%2B%2F%3D&redirect=%2Fdownloads%3Ftab%3Dactive');
            oidc.consumeAuthorizationCallback = async () => ({ claims: { sub: 'identity' } });
            assert.match((await harness.request('get', '/api/auth/oidc/callback')).res.location, /&redirect=%2F$/);
        });

        it('sends back the handoff value of the browser that started the sign-in', async function() {
            oidc.consumeAuthorizationCallback = async () => ({ claims: { sub: 'identity' }, return_to: '/', handoff: 'tab-kept_value-0123456789' });
            const { res } = await harness.request('get', '/api/auth/oidc/callback');
            assert.strictEqual(res.location, 'https://media.example.test/login#oidc_token=token%2B%2F%3D&redirect=%2F&handoff=tab-kept_value-0123456789');
        });

        it('refuses disallowed groups and missing accounts without issuing a session', async function() {
            allowed = false;
            auth.upsertOIDCUser = async () => { throw new Error('must not register a rejected identity'); };
            assert.strictEqual((await harness.request('get', '/api/auth/oidc/callback')).res.statusCode, 403);
            allowed = true;
            auth.upsertOIDCUser = async () => null;
            assert.strictEqual((await harness.request('get', '/api/auth/oidc/callback')).res.statusCode, 403);
        });

        it('returns unauthorized on callback failure and hides disabled endpoints', async function() {
            oidc.consumeAuthorizationCallback = async () => { throw new Error('invalid state'); };
            assert.strictEqual((await harness.request('get', '/api/auth/oidc/callback')).res.statusCode, 401);
            oidc.isEnabled = () => false;
            for (const route of ['/api/auth/oidc/login', '/api/auth/oidc/callback']) {
                assert.strictEqual((await harness.request('get', route)).res.statusCode, 404);
            }
        });
    });

    it('serves saved chat and downloads absent chat using the authenticated owner', async function() {
        const calls = [];
        let chat = ['saved'];
        harness = createRouteHarness({ dependencies: { './twitch': {
            getTwitchChatByFileID: async (...args) => { calls.push(['lookup', ...args]); return chat; },
            downloadTwitchChatByVODID: async (...args) => { calls.push(['download', ...args]); return ['downloaded']; }
        } }});
        const body = { id: 'clip', type: 'video', vodId: 'vod', uuid: 'spoofed', sub: 'sub' };
        const request = { body, user: { uid: 'alice' } };
        assert.deepStrictEqual((await harness.request('post', '/api/getFullTwitchChat', request)).res.body.chat, ['saved']);
        assert.deepStrictEqual((await harness.request('post', '/api/downloadTwitchChatByVODID', request)).res.body.chat, ['saved']);
        chat = null;
        assert.deepStrictEqual((await harness.request('post', '/api/downloadTwitchChatByVODID', request)).res.body.chat, ['downloaded']);
        assert.deepStrictEqual(calls, [
            ['lookup', 'clip', 'video', 'alice', 'alice', 'sub'], ['lookup', 'clip', 'video', 'alice', 'alice', 'sub'],
            ['lookup', 'clip', 'video', 'alice', 'alice', 'sub'], ['download', 'vod', 'clip', 'video', 'alice', 'sub']
        ]);
    });

    it('generates thumbnails with an owner filter and returns actionable failures', async function() {
        let file = { uid: 'clip' };
        let generated = { thumbnail_path: '/art.jpg', thumbnail_updated_at: 123, method: 'frame', seek_seconds: 8 };
        harness = createRouteHarness({ config: { ytdl_multi_user_mode: true }, dependencies: {
            './db': { initialize() {}, getRecord: async (table, filter) => {
                assert.strictEqual(table, 'files');
                assert.deepStrictEqual(plain(filter), { uid: 'clip', user_uid: 'alice' });
                return file;
            } },
            './thumbnails': { generateThumbnailForFile: async (value, options) => {
                assert.strictEqual(value, file);
                assert.strictEqual(options.timestamp_seconds, 8);
                return generated;
            } }
        }});
        const request = { user: { uid: 'alice' }, body: { uid: 'clip', timestamp_seconds: 8 } };
        assert.deepStrictEqual(plain((await harness.request('post', '/api/generateThumbnail', request)).res.body), {
            success: true, thumbnailPath: '/art.jpg', thumbnail_updated_at: 123, method: 'frame', seek_seconds: 8
        });
        generated = null;
        assert.match((await harness.request('post', '/api/generateThumbnail', request)).res.body.error, /Could not generate/);
        file = null;
        assert.match((await harness.request('post', '/api/generateThumbnail', request)).res.body.error, /could not be found/);
    });

    it('distinguishes empty, single and multiple format results and rejects invalid searches', async function() {
        let result = [{ format_id: '137' }];
        let searches = 0;
        harness = createRouteHarness({ dependencies: { './downloader': {
            getVideoInfoByURL: async (url, args, user, options) => {
                assert.strictEqual(url, 'https://example.test/clip');
                assert.strictEqual(options.forceYtDlp, true);
                return result;
            },
            searchVideos: async query => { assert.strictEqual(query, 'space'); searches++; return result; }
        } }});
        const formats = () => harness.request('post', '/api/getFileFormats', { body: { url: 'https://example.test/clip' } });
        assert.deepStrictEqual((await formats()).res.body.result, result[0]);
        for (const value of [[], [{}, {}], null]) {
            result = value;
            assert.strictEqual((await formats()).res.body.result, null);
        }
        for (const query of ['', ' ', 123, 'x'.repeat(201)]) {
            assert.strictEqual((await harness.request('post', '/api/searchVideos', { body: { query } })).res.statusCode, 400);
        }
        assert.strictEqual(searches, 0);
        assert.strictEqual((await harness.request('post', '/api/searchVideos', { body: { query: ' space ' } })).res.statusCode, 500);
        result = [{ title: 'Space' }];
        assert.deepStrictEqual((await harness.request('post', '/api/searchVideos', { body: { query: 'space' } })).res.body.results, result);
    });

    it('moves uploaded cookies only from appdata and checks the resulting file', async function() {
        let exists = true;
        const moves = [];
        harness = createRouteHarness({ dependencies: { 'fs-extra': {
            existsSync: () => false,
            pathExists: async () => exists,
            rename: async (...args) => moves.push(args)
        } }});
        const route = '/api/uploadCookies';
        assert.strictEqual((await harness.request('post', route)).res.statusCode, 400);
        assert.strictEqual((await harness.request('post', route, { file: { path: '/outside.txt' } })).res.statusCode, 400);
        const upload = path.join(harness.root, 'appdata/upload');
        assert.strictEqual((await harness.request('post', route, { file: { path: upload } })).res.body.success, true);
        assert.deepStrictEqual(moves, [[upload, path.join(harness.root, 'appdata/cookies.txt')]]);
        exists = false;
        assert.strictEqual((await harness.request('post', route, { file: { path: upload } })).res.statusCode, 500);
        assert.strictEqual(moves.length, 1);
    });
});
