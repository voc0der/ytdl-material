const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const { startApp } = require('./helpers/app-process');

// The cookie test route allows ten requests a minute from one client. These are refused as
// incomplete before anything runs, so they only count toward that limit.
async function cookieTests(app, forwarded_for, count = 1) {
    const statuses = [];
    for (let i = 0; i < count; i++) {
        const req = app.api.post('/api/testCookies').send({});
        if (forwarded_for) req.set('X-Forwarded-For', forwarded_for);
        statuses.push((await req).status);
    }
    return statuses;
}

const TEN_THEN_LIMITED = [...Array(10).fill(400), 429];

const readDatabase = app => fs.readJSONSync(path.join(app.root, 'appdata', 'local_db.json'));

/*************************************************
 * What the container's environment changes about
 * how the server runs: the permissions it creates
 * files with, which proxies it believes about the
 * client's address, which it accepts requests from
 * at all, and who owns files nobody did.
 ************************************************/
describe('Settings from the environment', function() {
    this.timeout(30000);

    describe('Trusted proxies and the file mask', function() {
        let app;

        before(async function() {
            app = await startApp({env: {ytdl_trust_proxy: ' loopback, ::1 ', ytdl_umask: '0o027'}});
        });

        after(async function() {
            if (app) await app.stop();
        });

        it('limits each client a trusted proxy forwards for on its own', async function() {
            assert.deepStrictEqual(await cookieTests(app, '203.0.113.1', 11), TEN_THEN_LIMITED);
            assert.deepStrictEqual(await cookieTests(app, '203.0.113.2'), [400]);
        });

        it('creates files with the mask, and shows both settings as they were given', async function() {
            await app.api.post('/api/runTask').send({task_key: 'backup_local_db'}).expect(200);
            const backup_dir = path.join(app.root, 'appdata', 'db_backup');
            const [backup] = fs.readdirSync(backup_dir);
            assert.strictEqual(fs.statSync(path.join(backup_dir, backup)).mode & 0o777, 0o640);

            const {server_runtime} = (await app.api.get('/api/config').expect(200)).body;
            assert.strictEqual(server_runtime.trust_proxy, 'loopback, ::1');
            assert.strictEqual(server_runtime.umask, 0o027);
        });
    });

    describe('A count of trusted proxies, in upper-case variables', function() {
        let app;

        before(async function() {
            // Not octal, so read as the decimal 18, which is 022.
            app = await startApp({env: {YTDL_TRUST_PROXY: '1', YTDL_UMASK: '18'}});
        });

        after(async function() {
            if (app) await app.stop();
        });

        it('believes only the address the nearest proxy added', async function() {
            assert.deepStrictEqual(await cookieTests(app, '198.51.100.7, 203.0.113.1', 11), TEN_THEN_LIMITED);
            // Whatever a client writes in front of it changes nothing.
            assert.deepStrictEqual(await cookieTests(app, '198.51.100.99, 203.0.113.1'), [429]);
            assert.deepStrictEqual(await cookieTests(app, '198.51.100.7, 203.0.113.2'), [400]);

            const {server_runtime} = (await app.api.get('/api/config').expect(200)).body;
            assert.strictEqual(server_runtime.trust_proxy, '1');
            assert.strictEqual(server_runtime.umask, 0o022);
        });
    });

    describe('A reverse proxy whitelist', function() {
        let app;

        afterEach(async function() {
            if (app) await app.stop();
            app = null;
        });

        it('turns away a request that did not come through a listed proxy, except a health check', async function() {
            app = await startApp({env: {ytdl_reverse_proxy_whitelist: '10.0.0.0/8, 192.168.1.10'}});

            const refused = await app.api.get('/api/config').expect(403);
            assert.strictEqual(refused.text, 'Access forbidden');
            await app.api.get('/healthz').expect(200);
            assert.match(app.output(), /Access denied for reverse proxy IP 127\.0\.0\.1 - not in whitelist/);
        });

        it('trusts the proxies it lists to say who the client is', async function() {
            app = await startApp({env: {ytdl_reverse_proxy_whitelist: '127.0.0.1/32, ::1'}});

            assert.deepStrictEqual(await cookieTests(app, '203.0.113.1', 11), TEN_THEN_LIMITED);
            assert.deepStrictEqual(await cookieTests(app, '203.0.113.2'), [400]);
            assert.match(app.output(), /trust proxy configured from reverse proxy whitelist/);
        });

        // express throws on an entry that is not an address, which stopped the server from
        // starting, and failed a Settings save only after the entry had been saved.
        it('starts with an entry that is not an address, warning about it and trusting the rest', async function() {
            app = await startApp({env: {ytdl_reverse_proxy_whitelist: '127.0.0.1, nginx-proxy, ::1'}});

            assert.deepStrictEqual(await cookieTests(app, '203.0.113.1', 11), TEN_THEN_LIMITED);
            assert.deepStrictEqual(await cookieTests(app, '203.0.113.2'), [400]);
            assert.match(app.output(), /Invalid CIDR range in whitelist: nginx-proxy/);
        });

        it('saves such an entry from the settings, and keeps serving', async function() {
            app = await startApp();
            const {config_file} = (await app.api.get('/api/config').expect(200)).body;
            config_file.YtdlMaterial.Host.reverse_proxy_whitelist = '127.0.0.1, nginx-proxy';

            const saved = await app.api.post('/api/setConfig').send({new_config_file: config_file}).expect(200);

            assert.deepStrictEqual(saved.body, {success: true});
            assert.deepStrictEqual(await cookieTests(app, '203.0.113.1', 11), TEN_THEN_LIMITED);
            assert.deepStrictEqual(await cookieTests(app, '203.0.113.2'), [400]);
        });
    });

    describe('The URL the app is reached at', function() {
        let app;

        afterEach(async function() {
            if (app) await app.stop();
            app = null;
        });

        const allowedOrigin = async () => (await app.api.get('/api/versionInfo').expect(200)).headers['access-control-allow-origin'];

        it('reads one written without its scheme as http', async function() {
            app = await startApp({env: {ytdl_url: '192.168.1.10:8998'}});

            assert.strictEqual(await allowedOrigin(), 'http://192.168.1.10:8998');
        });

        it('saves one from the settings, and falls back from one that is not a web address', async function() {
            app = await startApp();
            const {config_file} = (await app.api.get('/api/config').expect(200)).body;

            config_file.YtdlMaterial.Host.url = 'ytdl.example.test';
            await app.api.post('/api/setConfig').send({new_config_file: config_file}).expect(200);
            assert.strictEqual(await allowedOrigin(), 'http://ytdl.example.test');

            config_file.YtdlMaterial.Host.url = 'ftp://files.example.test';
            await app.api.post('/api/setConfig').send({new_config_file: config_file}).expect(200);
            assert.strictEqual(await allowedOrigin(), 'http://example.com');
            assert.match(app.output(), /The configured URL 'ftp:\/\/files\.example\.test' is not a web address/);
        });
    });

    describe('Giving unowned files to a user at startup', function() {
        const USERS = [
            {uid: 'alice', name: 'Alice', role: 'user'},
            {uid: 'bob', name: 'Bob', role: 'user'}
        ];
        let app;

        afterEach(async function() {
            if (app) await app.stop();
            app = null;
        });

        async function startWith(target, tables) {
            return await startApp({
                env: {ytdl_oidc_migrate_videos: target},
                prepare: ({root}) => fs.outputJSON(path.join(root, 'appdata', 'local_db.json'), {users: USERS, ...tables})
            });
        }

        it('gives the files and playlists nobody owns to the user named, by name or uid', async function() {
            app = await startWith('Alice', {
                files: [{uid: 'unowned-file', title: 'Unowned'}, {uid: 'bobs-file', title: 'Bob\'s', user_uid: 'bob'}],
                playlists: [{id: 'unowned-playlist', name: 'Unowned', uids: [], user_uid: null}]
            });

            const db = readDatabase(app);
            assert.deepStrictEqual(db.files.map(file => [file.uid, file.user_uid]), [['unowned-file', 'alice'], ['bobs-file', 'bob']]);
            assert.deepStrictEqual(db.playlists.map(playlist => [playlist.id, playlist.user_uid]), [['unowned-playlist', 'alice']]);
            assert.match(app.output(), /Migrated 1 unassigned videos\/files and 1 unassigned playlists to user 'alice'/);
        });

        const refusals = [
            ['a value that is not a uid', '../alice', /Invalid ytdl_oidc_migrate_videos value '\.\.\/alice'/],
            ['a user who does not exist', 'carol', /requested migration to 'carol', but no such user exists/],
            ['nothing left to give', 'alice', /No unassigned videos\/files or playlists exist/]
        ];
        for (const [what, target, message] of refusals) {
            it(`stops startup, saying why, for ${what}`, async function() {
                await assert.rejects(startWith(target, {files: [{uid: 'owned-file', user_uid: 'bob'}]}), error => {
                    assert.match(error.message, /exited during startup \(code 1/);
                    assert.match(error.message, message);
                    return true;
                });
            });
        }
    });
});
