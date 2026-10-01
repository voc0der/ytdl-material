const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const { startApp, addSampleMedia, BACKEND } = require('./helpers/app-process');

const PASSWORDS = {admin: 'admin-password', alice: 'alice-password', bob: 'bob-password'};

/*************************************************
 * Accounts on a multi-user server, through the real
 * routes: passwords hashed and checked by bcryptjs
 * through passport-local, sessions signed by
 * jsonwebtoken and read back by passport-jwt, API
 * tokens, and every guard in between.
 *
 * Runs in order, as an install would be set up:
 * the administrator registers first, then users,
 * and each describe builds on the accounts the one
 * before it made.
 *
 * Everything under /api/auth except jwtAuth and
 * adminExists shares one allowance of 25 requests
 * per 15 minutes per address. This suite uses 22
 * before the last test spends what is left.
 ************************************************/
describe('Accounts on a multi-user server', function() {
    this.timeout(30000);

    let app;
    const tokens = {};

    // The browser session is a JWT in the query string.
    const as = (user, method, route) => app.api[method](route).query({jwt: tokens[user]});
    const login = (username, password) => app.api.post('/api/auth/login').send({username, password});

    before(async function() {
        app = await startApp({env: {ytdl_multi_user_mode: 'true'}});
    });

    after(async function() {
        if (app) await app.stop();
    });

    describe('Before anyone has registered', function() {
        it('says there is no administrator yet', async function() {
            const res = await app.api.post('/api/auth/adminExists').send({}).expect(200);
            assert.deepStrictEqual(res.body, {exists: false});
        });

        it('turns away anonymous callers', async function() {
            await app.api.get('/api/getMp4s').expect(401);
            await app.api.post('/api/getAllFiles').send({}).expect(401);
        });

        it('refuses an anonymous cookie upload before reading it', async function() {
            const strays = () => fs.readdirSync(path.join(BACKEND, 'appdata')).filter(name => /^[0-9a-f]{32}$/.test(name));
            const before = strays();
            await app.api.post('/api/uploadCookies').attach('cookies', Buffer.from('cookies'), 'cookies.txt').expect(401);
            assert.deepStrictEqual(strays(), before);
        });

        it('gives an anonymous caller the config with its secrets removed', async function() {
            const res = await app.api.get('/api/config').expect(200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.server_runtime, null);
            assert.strictEqual(res.body.config_file.YtdlMaterial.API.telegram_bot_token, undefined);
            assert.strictEqual(res.body.config_file.YtdlMaterial.API.youtube_API_key, undefined);
            assert.strictEqual(res.body.config_file.YtdlMaterial.Advanced.multi_user_mode, true);
        });
    });

    describe('Registering', function() {
        it('registers the administrator, then users', async function() {
            for (const uid of ['admin', 'alice', 'bob']) {
                const res = await app.api.post('/api/auth/register').send({userid: uid, username: uid, password: PASSWORDS[uid]}).expect(200);
                assert.strictEqual(res.body.user.uid, uid);
                assert.strictEqual(res.body.user.passhash, undefined);
            }
            const res = await app.api.post('/api/auth/adminExists').send({}).expect(200);
            assert.deepStrictEqual(res.body, {exists: true});
        });

        it('refuses a taken name, an empty password and a uid that is a path', async function() {
            await app.api.post('/api/auth/register').send({userid: 'alice', username: 'alice', password: 'again'}).expect(409);
            await app.api.post('/api/auth/register').send({userid: 'carol', username: 'carol', password: ''}).expect(409);
            await app.api.post('/api/auth/register').send({userid: '../carol', username: 'carol', password: 'x'}).expect(409);
        });
    });

    describe('Signing in', function() {
        it('refuses a wrong password', async function() {
            await login('alice', 'not-her-password').expect(401);
            await login('nobody', 'anything').expect(401);
        });

        it('returns a session token and the account\'s permissions', async function() {
            for (const uid of ['admin', 'alice', 'bob']) {
                const res = await login(uid, PASSWORDS[uid]).expect(200);
                assert.strictEqual(res.body.user.uid, uid);
                assert.strictEqual(res.body.user.passhash, undefined);
                assert(Array.isArray(res.body.permissions));
                assert(Array.isArray(res.body.available_permissions));
                assert.strictEqual(typeof res.body.token, 'string');
                tokens[uid] = res.body.token;
            }
            assert.strictEqual((await as('admin', 'post', '/api/auth/jwtAuth').send({}).expect(200)).body.user.role, 'admin');
            assert.strictEqual((await as('alice', 'post', '/api/auth/jwtAuth').send({}).expect(200)).body.user.role, 'user');
        });

        it('renews a session from a valid token only', async function() {
            const renewed = await as('alice', 'post', '/api/auth/jwtAuth').send({}).expect(200);
            assert.strictEqual(renewed.body.user.uid, 'alice');
            assert.strictEqual(typeof renewed.body.token, 'string');

            const [header, payload, signature] = tokens.alice.split('.');
            const forged_payload = Buffer.from(JSON.stringify({user: 'admin'})).toString('base64url');
            for (const jwt of ['not-a-token', `${header}.${forged_payload}.${signature}`, `${header}.${payload}.${signature.slice(0, -2)}xx`]) {
                await app.api.post('/api/auth/jwtAuth').query({jwt}).send({}).expect(401);
                await app.api.get('/api/getMp4s').query({jwt}).expect(401);
            }
        });

        it('shows a signed-in user the config, with the admin\'s secrets left out', async function() {
            const alice = (await as('alice', 'get', '/api/config').expect(200)).body;
            assert.notStrictEqual(alice.server_runtime, null);
            assert.strictEqual(alice.config_file.YtdlMaterial.API.telegram_bot_token, undefined);

            const admin = (await as('admin', 'get', '/api/config').expect(200)).body;
            assert.strictEqual(admin.config_file.YtdlMaterial.API.telegram_bot_token, '');
        });
    });

    describe('What each account can do', function() {
        it('keeps user management to the administrator', async function() {
            await as('alice', 'post', '/api/getUsers').send({}).expect(403);
            await as('alice', 'post', '/api/uploadCookies').attach('cookies', Buffer.from('cookies'), 'cookies.txt').expect(403);

            const {users} = (await as('admin', 'post', '/api/getUsers').send({}).expect(200)).body;
            assert.deepStrictEqual(users.map(user => user.uid).sort(), ['admin', 'alice', 'bob']);
            assert(users.every(user => user.passhash === undefined));

            const {roles} = (await as('admin', 'post', '/api/getRoles').send({}).expect(200)).body;
            assert.deepStrictEqual(roles.map(role => role.key).sort(), ['admin', 'user']);
        });

        it('grants and revokes a permission for one user', async function() {
            await as('bob', 'post', '/api/downloads').send({}).expect(403);

            const granted = await as('admin', 'post', '/api/changeUserPermissions').send({user_uid: 'bob', permission: 'downloads_manager', new_value: 'yes'}).expect(200);
            assert.strictEqual(granted.body.success, true);
            await as('bob', 'post', '/api/downloads').send({}).expect(200);

            await as('admin', 'post', '/api/changeUserPermissions').send({user_uid: 'bob', permission: 'downloads_manager', new_value: 'no'}).expect(200);
            await as('bob', 'post', '/api/downloads').send({}).expect(403);

            await as('admin', 'post', '/api/changeUserPermissions').send({user_uid: 'bob'}).expect(400);
        });

        it('changes what a role may do', async function() {
            await as('admin', 'post', '/api/changeRolePermissions').send({role: 'user', permission: 'filemanager', new_value: 'no'}).expect(200);
            try {
                await as('alice', 'post', '/api/getDuplicateSummary').send({}).expect(403);
            } finally {
                await as('admin', 'post', '/api/changeRolePermissions').send({role: 'user', permission: 'filemanager', new_value: 'yes'}).expect(200);
            }
            await as('alice', 'post', '/api/getDuplicateSummary').send({}).expect(200);
            await as('admin', 'post', '/api/changeRolePermissions').send({role: 'user'}).expect(400);
        });

        it('renames a user', async function() {
            const rename = (name) => as('admin', 'post', '/api/updateUser').send({change_object: {uid: 'bob', name}}).expect(200);
            const name = async () => (await as('admin', 'post', '/api/getUsers').send({}).expect(200)).body.users.find(user => user.uid === 'bob').name;

            await rename('Robert');
            assert.strictEqual(await name(), 'Robert');
            // The name is what he signs in with, which later tests still need.
            await rename('bob');
            assert.strictEqual(await name(), 'bob');
        });
    });

    describe('Each account\'s own library', function() {
        let file;

        before(async function() {
            await addSampleMedia(path.join(app.media.users, 'alice', 'video'), {info: {id: 'alice-clip', title: 'Alice\'s clip', webpage_url: 'https://example.com/a'}});
            await as('admin', 'post', '/api/runTask').send({task_key: 'missing_db_records'}).expect(200);
            [file] = (await as('alice', 'get', '/api/getMp4s').expect(200)).body.mp4s;
            assert(file, 'expected the import task to register the file for alice');
        });

        it('belongs to whoever it was imported for', async function() {
            assert.strictEqual(file.user_uid, 'alice');
            assert.deepStrictEqual((await as('bob', 'get', '/api/getMp4s').expect(200)).body.mp4s, []);
            assert.deepStrictEqual((await as('bob', 'post', '/api/getFile').send({uid: file.uid}).expect(200)).body, {success: false});
        });

        it('streams only to its owner', async function() {
            await as('alice', 'get', '/api/stream').query({uid: file.uid}).set('Range', 'bytes=0-0').expect(206);
            await as('bob', 'get', '/api/stream').query({uid: file.uid}).expect(404);
            await app.api.get('/api/stream').query({uid: file.uid}).expect(401);
        });

        it('opens to a share link while sharing is on, and only then', async function() {
            const shared = {uuid: 'alice', uid: file.uid};
            await app.api.post('/api/getFile').send(shared).expect(401);

            await as('alice', 'post', '/api/enableSharing').send({uid: file.uid, is_playlist: false}).expect(200);
            const res = await app.api.post('/api/getFile').send(shared).expect(200);
            assert.strictEqual(res.body.file.uid, file.uid);
            await app.api.get('/api/stream').query(shared).set('Range', 'bytes=0-0').expect(206);
            await app.api.post('/api/incrementViewCount').send({file_uid: file.uid, uuid: 'alice'}).expect(200);

            await as('alice', 'post', '/api/disableSharing').send({uid: file.uid, is_playlist: false}).expect(200);
            await app.api.post('/api/getFile').send(shared).expect(401);
            await app.api.post('/api/incrementViewCount').send({file_uid: file.uid, uuid: 'alice'}).expect(401);
        });

        it('lets another user browse it once its owner shares the library', async function() {
            const browse = () => as('bob', 'post', '/api/getAllFiles').query({library: 'alice'}).send({});
            await browse().expect(403);

            await as('alice', 'post', '/api/setLibrarySharing').send({enabled: 'yes'}).expect(400);
            const shared = await as('alice', 'post', '/api/setLibrarySharing').send({enabled: true}).expect(200);
            assert.deepStrictEqual(shared.body, {success: true});

            const {libraries} = (await as('bob', 'post', '/api/getSharedLibraries').send({}).expect(200)).body;
            assert(libraries.some(library => library.uid === 'alice'));
            const res = await browse().expect(200);
            assert.deepStrictEqual(res.body.files.map(item => item.uid), [file.uid]);

            await as('alice', 'post', '/api/setLibrarySharing').send({enabled: false}).expect(200);
            await browse().expect(403);
        });
    });

    describe('API tokens', function() {
        const bearer = (token, method, route) => app.api[method](route).set('Authorization', `Bearer ${token}`);
        let issued;

        it('issues a token once, and lists it without the secret', async function() {
            const res = await as('alice', 'post', '/api/generateAPIToken').send({label: 'scripts'}).expect(200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(typeof res.body.token, 'string');
            issued = res.body;

            const {tokens: listed} = (await as('alice', 'post', '/api/listAPITokens').send({}).expect(200)).body;
            assert.deepStrictEqual(listed.map(token => [token.id, token.label, token.type]), [[issued.id, 'scripts', 'api']]);
            assert(listed.every(token => token.token === undefined && token.hash === undefined));
        });

        it('stands in for the session on API routes', async function() {
            const {mp4s} = (await bearer(issued.token, 'get', '/api/getMp4s').expect(200)).body;
            assert.strictEqual(mp4s.length, 1);
            await bearer('ytdl_not-a-real-token', 'get', '/api/getMp4s').expect(401);
        });

        it('cannot manage tokens itself', async function() {
            await bearer(issued.token, 'post', '/api/generateAPIToken').send({label: 'another'}).expect(403);
            await bearer(issued.token, 'post', '/api/listAPITokens').send({}).expect(403);
        });

        it('only opens the feed when issued for it', async function() {
            const rss = (await as('alice', 'post', '/api/generateAPIToken').send({label: 'reader', type: 'rss'}).expect(200)).body;
            await bearer(rss.token, 'get', '/api/getMp4s').expect(401);
            // Past the token check to the feed itself, which is switched off.
            await bearer(rss.token, 'get', '/api/rss').expect(403);

            await as('alice', 'post', '/api/generateAPIToken').send({label: 'odd', type: 'admin'}).expect(400);
        });

        it('stops working once revoked', async function() {
            const res = await as('alice', 'post', '/api/revokeAPIToken').send({token_id: issued.id}).expect(200);
            assert.deepStrictEqual(res.body, {success: true});
            await bearer(issued.token, 'get', '/api/getMp4s').expect(401);
        });
    });

    describe('Passwords', function() {
        const change = (user, body) => as(user, 'post', '/api/auth/changePassword').send(body);

        it('makes a user prove the password they are replacing', async function() {
            await change('alice', {new_password: 'alice-new', current_password: 'wrong'}).expect(403);
            await change('alice', {new_password: ''}).expect(400);

            const res = await change('alice', {new_password: 'alice-new', current_password: PASSWORDS.alice}).expect(200);
            assert.deepStrictEqual(res.body, {success: true});
            await login('alice', PASSWORDS.alice).expect(401);
            await login('alice', 'alice-new').expect(200);
        });

        it('lets only the administrator reset somebody else\'s', async function() {
            await change('alice', {user_uid: 'bob', new_password: 'taken-over'}).expect(403);
            await change('admin', {user_uid: 'bob', new_password: 'bob-reset'}).expect(200);
            await login('bob', 'bob-reset').expect(200);
        });
    });

    describe('Closing registration', function() {
        let config_file;

        before(async function() {
            config_file = (await as('admin', 'get', '/api/config').expect(200)).body.config_file;
            const closed = JSON.parse(JSON.stringify(config_file));
            closed.YtdlMaterial.Users.allow_registration = false;
            await as('admin', 'post', '/api/setConfig').send({new_config_file: closed}).expect(200);
        });

        after(async function() {
            await as('admin', 'post', '/api/setConfig').send({new_config_file: config_file}).expect(200);
        });

        it('turns strangers away, but not the administrator adding an account', async function() {
            await app.api.post('/api/auth/register').send({userid: 'carol', username: 'carol', password: 'carol-password'}).expect(409);
            await as('alice', 'post', '/api/auth/register').send({userid: 'carol', username: 'carol', password: 'carol-password'}).expect(409);
            const res = await as('admin', 'post', '/api/auth/register').send({userid: 'carol', username: 'carol', password: 'carol-password'}).expect(200);
            assert.strictEqual(res.body.user.uid, 'carol');
        });
    });

    describe('Deleting an account', function() {
        it('ends its sessions and its tokens', async function() {
            const token = (await as('bob', 'post', '/api/generateAPIToken').send({label: 'bob'}).expect(200)).body.token;
            const res = await as('admin', 'post', '/api/deleteUser').send({uid: 'bob'}).expect(200);
            assert.deepStrictEqual(res.body, {success: true});

            await as('bob', 'get', '/api/getMp4s').expect(401);
            await app.api.get('/api/getMp4s').set('Authorization', `Bearer ${token}`).expect(401);
            await login('bob', 'bob-reset').expect(401);
        });
    });

    // Last: it spends the sign-in allowance for the rest of the window.
    describe('Rate limiting sign-ins', function() {
        it('refuses sign-ins once the allowance is spent, but still answers the exempt routes', async function() {
            let res;
            for (let attempt = 0; attempt < 30; attempt++) {
                res = await login('alice', 'guessing');
                if (res.status === 429) break;
                assert.strictEqual(res.status, 401);
            }
            assert.strictEqual(res.status, 429);
            assert.deepStrictEqual(res.body, {success: false, error: 'Too many authentication requests. Please wait and try again.'});
            assert.strictEqual(res.headers['ratelimit-limit'], '25');

            await app.api.post('/api/auth/adminExists').send({}).expect(200);
            await as('alice', 'post', '/api/auth/jwtAuth').send({}).expect(200);
        });
    });
});
