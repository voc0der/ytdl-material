const assert = require('assert');
const path = require('path');
const {startApp, addSampleMedia} = require('./helpers/app-process');

describe('Shadow access on a running server', function() {
    this.timeout(30000);
    let app;
    const tokens = {};
    const files = {};
    const as = (uid, route, method = 'post') => app.api[method](route).query({jwt: tokens[uid]});
    const update = change_object => as('admin', '/api/updateUser').send({change_object});
    const assign = (access = 'full', target_uid = 'bob') => update({uid: 'alice', shadow: {target_uid, access}}).expect(200);

    before(async function() {
        app = await startApp({env: {ytdl_multi_user_mode: 'true', ytdl_max_concurrent_downloads: '0'}});
        for (const uid of ['admin', 'alice', 'bob']) {
            await app.api.post('/api/auth/register').send({userid: uid, username: uid, password: `${uid}-password`}).expect(200);
            tokens[uid] = (await app.api.post('/api/auth/login').send({username: uid, password: `${uid}-password`}).expect(200)).body.token;
        }
        for (const uid of ['alice', 'bob']) {
            await addSampleMedia(path.join(app.media.users, uid, 'video'), {info: {id: `${uid}-clip`, title: `${uid}'s clip`, webpage_url: `https://example.com/${uid}`}});
        }
        await as('admin', '/api/runTask').send({task_key: 'missing_db_records'}).expect(200);
        for (const uid of ['alice', 'bob']) {
            [files[uid]] = (await as(uid, '/api/getMp4s', 'get').expect(200)).body.mp4s;
            assert(files[uid]);
        }
    });
    after(async function() { if (app) await app.stop(); });
    beforeEach(async function() { await update({uid: 'alice', shadow: null}).expect(200); });

    it('validates targets and access before changing any account fields', async function() {
        for (const shadow of [{target_uid: 'alice', access: 'full'}, {target_uid: 'missing', access: 'full'},
            {target_uid: 'bob', access: 'unknown'}, {target_uid: 'bob', access: '__proto__'}, {}, false]) {
            await update({uid: 'alice', name: 'wrong', shadow}).expect(400);
        }
        const users = (await as('admin', '/api/getUsers').send({}).expect(200)).body.users;
        assert.strictEqual(users.find(user => user.uid === 'alice').name, 'alice');
        await as('alice', '/api/updateUser').send({change_object: {uid: 'alice', shadow: {target_uid: 'bob', access: 'full'}}}).expect(403);
        await assign();
        await update({uid: 'bob', shadow: {target_uid: 'alice', access: 'full'}}).expect(400);
        await update({uid: 'bob', shadow: {target_uid: 'admin', access: 'full'}}).expect(400);
        await update({uid: 'admin', shadow: {target_uid: 'alice', access: 'full'}}).expect(400);
    });

    it('logs in as the target library while keeping JWTs tied to the real caller', async function() {
        await assign();
        const login = (await app.api.post('/api/auth/login').send({username: 'alice', password: 'alice-password'}).expect(200)).body;
        assert.strictEqual(login.user.uid, 'bob');
        assert.strictEqual(login.user.role, 'shadow');
        assert.strictEqual(login.user.shadow_session.actor_uid, 'alice');
        assert.strictEqual(login.user.passhash, undefined);
        assert.strictEqual(JSON.parse(Buffer.from(login.token.split('.')[1], 'base64url')).user, 'alice');
        assert(login.permissions.includes('filemanager'));
        assert(!login.permissions.includes('settings'));
        const renewed = (await as('alice', '/api/auth/jwtAuth').send({}).expect(200)).body;
        assert.strictEqual(renewed.user.uid, 'bob');
        assert.strictEqual(JSON.parse(Buffer.from(renewed.token.split('.')[1], 'base64url')).user, 'alice');
        const library = (await as('alice', '/api/getMp4s', 'get').expect(200)).body.mp4s;
        assert.deepStrictEqual(library.map(file => file.uid), [files.bob.uid]);
        await as('alice', '/api/stream', 'get').query({uid: files.bob.uid}).set('Range', 'bytes=0-0').expect(206);
        await as('alice', '/api/stream', 'get').query({uid: files.alice.uid}).expect(404);
    });

    it('adds and edits target content, leaving the caller library untouched', async function() {
        await assign();
        const created = (await as('alice', '/api/createPlaylist').send({playlistName: 'From Alice', uids: [files.bob.uid]}).expect(200)).body.new_playlist;
        assert.strictEqual(created.user_uid, 'bob');
        assert((await as('bob', '/api/getPlaylists').send({}).expect(200)).body.playlists.some(list => list.id === created.id));
        await as('alice', '/api/updateFile').send({uid: files.bob.uid, change_obj: {favorite: true}}).expect(200);
        const file = (await as('bob', '/api/getFile').send({uid: files.bob.uid}).expect(200)).body.file;
        assert.strictEqual(file.favorite, true);
        const queued = (await as('alice', '/api/downloadFile').send({url: 'https://example.com/new-media', type: 'video'}).expect(200)).body.download;
        assert.strictEqual(queued.user_uid, 'bob');
        const downloads = (await as('alice', '/api/downloads').send({}).expect(200)).body.downloads;
        assert(downloads.some(download => download.uid === queued.uid));
        await update({uid: 'alice', shadow: null}).expect(200);
        assert(!(await as('alice', '/api/getPlaylists').send({}).expect(200)).body.playlists.some(list => list.id === created.id));
    });

    it('refuses read-only mutations, including POST routes without permission guards', async function() {
        await assign('read_only');
        const renewed = (await as('alice', '/api/auth/jwtAuth').send({}).expect(200)).body;
        assert.strictEqual(renewed.user.shadow_session.access, 'read_only');
        await as('alice', '/api/getSubscriptions').send({}).expect(200);
        await as('alice', '/api/getAllFiles').send({}).expect(200);
        await as('alice', '/api/getMp4s', 'head').expect(200);
        await as('alice', '/api/getPlaylists').send({}).expect(200);
        await as('alice', '/api/stream', 'get').query({uid: files.bob.uid}).set('Range', 'bytes=0-0').expect(206);
        for (const route of ['downloadFile', 'downloadFiles', 'deleteFile', 'updateFile', 'deleteAllFiles',
            'createPlaylist', 'updatePlaylist', 'deletePlaylist', 'addFileToPlaylist', 'subscribe',
            'unsubscribe', 'updateSubscription', 'deleteSubscriptionFile', 'checkSubscription',
            'incrementViewCount', 'updateConcurrentStream', 'deleteNotification', 'setNotificationsToRead',
            'setLibrarySharing', 'enableSharing', 'createPlaybackLink', 'retryDuplicateDownload', 'pauseDownload']) {
            await as('alice', `/api/${route}`).send({uid: files.bob.uid, file_uid: files.bob.uid}).expect(403);
        }
        await as('alice', '/API/DELETEFILE/').send({uid: files.bob.uid}).expect(403);
        await as('bob', '/api/stream', 'get').query({uid: files.bob.uid}).set('Range', 'bytes=0-0').expect(206);
    });

    it('does not inherit admin privileges or target credentials, even in full mode', async function() {
        await update({uid: 'bob', role: 'admin'}).expect(200);
        try {
            await assign();
            for (const route of ['getUsers', 'getRoles', 'setConfig', 'runTask', 'restartServer', 'setLibrarySharing', 'auth/changePassword']) {
                await as('alice', `/api/${route}`).send({user_uid: 'bob', new_password: 'wrong'}).expect(403);
            }
            const bobToken = (await as('bob', '/api/generateAPIToken').send({label: 'Bob private token'}).expect(200)).body;
            assert(!(await as('alice', '/api/listAPITokens').send({}).expect(200)).body.tokens.some(token => token.id === bobToken.id));
            const config = (await as('alice', '/api/config', 'get').expect(200)).body.config_file;
            assert.strictEqual(config.YtdlMaterial.API.telegram_bot_token, undefined);
        } finally {
            await update({uid: 'bob', role: 'user'}).expect(200);
        }
    });

    it('honors modular permission overrides within the shadow policy', async function() {
        await assign();
        await as('admin', '/api/changeUserPermissions').send({user_uid: 'alice', permission: 'filemanager', new_value: 'no'}).expect(200);
        try {
            await as('alice', '/api/deleteFile').send({uid: files.bob.uid}).expect(403);
            const session = (await as('alice', '/api/auth/jwtAuth').send({}).expect(200)).body;
            assert(!session.permissions.includes('filemanager'));
        } finally {
            await as('admin', '/api/changeUserPermissions').send({user_uid: 'alice', permission: 'filemanager', new_value: 'default'}).expect(200);
        }
    });

    it('applies assignments and revocations to existing API tokens and keeps new tokens owned by the caller', async function() {
        const token = (await as('alice', '/api/generateAPIToken').send({label: 'Alice token'}).expect(200)).body.token;
        const bearer = route => app.api.post(route).set('Authorization', `Bearer ${token}`);
        await assign('read_only');
        const library = await app.api.get('/api/getMp4s').set('Authorization', `Bearer ${token}`).expect(200);
        assert.deepStrictEqual(library.body.mp4s.map(file => file.uid), [files.bob.uid]);
        await bearer('/api/createPlaylist').send({playlistName: 'No', uids: []}).expect(403);
        await bearer('/api/stopShadow').send({}).expect(403);
        await bearer('/api/generateAPIToken').send({}).expect(403);
        await assign('full');
        const created = (await bearer('/api/createPlaylist').send({playlistName: 'Yes', uids: [files.bob.uid]}).expect(200)).body.new_playlist;
        assert.strictEqual(created.user_uid, 'bob');
        const ownToken = (await as('alice', '/api/generateAPIToken').send({label: 'Still Alice'}).expect(200)).body.token;
        await update({uid: 'alice', shadow: null}).expect(200);
        for (const credential of [token, ownToken]) {
            const restored = (await app.api.get('/api/getMp4s').set('Authorization', `Bearer ${credential}`).expect(200)).body;
            assert.deepStrictEqual(restored.mp4s.map(file => file.uid), [files.alice.uid]);
        }
    });

    it('keeps a non-administrator on the assignment until an administrator ends it', async function() {
        await assign('read_only');
        await as('alice', '/api/stopShadow').send({uid: 'bob'}).expect(403);
        const shadowed = (await as('alice', '/api/auth/jwtAuth').send({}).expect(200)).body;
        assert.strictEqual(shadowed.user.uid, 'bob');
        assert.strictEqual(shadowed.user.shadow_session.can_stop, false);
        await update({uid: 'alice', shadow: null}).expect(200);
        const restored = (await as('alice', '/api/auth/jwtAuth').send({}).expect(200)).body;
        assert.strictEqual(restored.user.uid, 'alice');
        assert.strictEqual(restored.user.role, 'user');
        assert.strictEqual(restored.user.shadow, null);
        assert(restored.permissions.includes('filemanager'));
        assert.deepStrictEqual((await as('alice', '/api/getMp4s', 'get').expect(200)).body.mp4s.map(file => file.uid), [files.alice.uid]);
    });

    it('suspends an administrator’s powers while shadowing and restores them on exit', async function() {
        await update({uid: 'admin', shadow: {target_uid: 'bob', access: 'read_only'}}).expect(200);
        try {
            await as('admin', '/api/getUsers').send({}).expect(403);
            const shadowed = (await as('admin', '/api/auth/jwtAuth').send({}).expect(200)).body;
            assert.strictEqual(shadowed.user.shadow_session.can_stop, true);
            const config = (await as('admin', '/api/config', 'get').expect(200)).body.config_file;
            assert.strictEqual(config.YtdlMaterial.API.telegram_bot_token, undefined);
        } finally {
            const session = (await as('admin', '/api/stopShadow').send({}).expect(200)).body;
            assert.strictEqual(session.user.uid, 'admin');
            assert.strictEqual(session.user.role, 'admin');
        }
        await as('admin', '/api/getUsers').send({}).expect(200);
    });

    it('deletes target media in full mode without deleting the caller media', async function() {
        await assign();
        await as('alice', '/api/deleteFile').send({uid: files.bob.uid}).expect(200);
        assert.deepStrictEqual((await as('bob', '/api/getMp4s', 'get').expect(200)).body.mp4s, []);
        await update({uid: 'alice', shadow: null}).expect(200);
        await as('alice', '/api/stream', 'get').query({uid: files.alice.uid}).set('Range', 'bytes=0-0').expect(206);
    });

    it('ends assignments to a deleted account, so a new account with its uid inherits none', async function() {
        await assign();
        await as('admin', '/api/deleteUser').send({uid: 'bob'}).expect(200);
        const users = (await as('admin', '/api/getUsers').send({}).expect(200)).body.users;
        assert.strictEqual(users.find(user => user.uid === 'alice').shadow, null);
        await app.api.post('/api/auth/register').send({userid: 'bob', username: 'bob', password: 'new-bob-password'}).expect(200);
        const session = (await as('alice', '/api/auth/jwtAuth').send({}).expect(200)).body;
        assert.strictEqual(session.user.uid, 'alice');
        assert.strictEqual(session.user.shadow_session, undefined);
        assert.deepStrictEqual((await as('alice', '/api/getMp4s', 'get').expect(200)).body.mp4s.map(file => file.uid), [files.alice.uid]);
    });
});

describe('Shadow resolution', function() {
    require('./test-shared');
    const shadow = require('../authentication/shadow');

    it('fails closed on an assignment whose target no longer exists', async function() {
        const access = await shadow.resolve({uid: 'shadow_unit_actor', name: 'Actor', role: 'user',
            shadow: {target_uid: 'shadow_unit_missing', access: 'full'}});
        assert.strictEqual(access.user.shadow_session.unavailable, true);
        assert.strictEqual(access.user.shadow_session.can_stop, false);
        assert.deepStrictEqual(access.permissions, []);
    });
});

describe('Shadow access with header sign-in', function() {
    this.timeout(30000);
    let app;
    before(async function() {
        app = await startApp({env: {
            ytdl_multi_user_mode: 'true', ytdl_header_auth_enabled: 'true',
            ytdl_header_auth_trusted_proxies: '127.0.0.1, ::1', ytdl_header_auth_groups_header: 'Remote-Groups'
        }});
    });
    after(async function() { if (app) await app.stop(); });

    it('preserves the assignment when provider sign-in refreshes the account role', async function() {
        const signIn = (name, groups = '') => app.api.post('/api/auth/header/login')
            .set('Remote-User', name).set('Remote-Groups', groups).expect(200);
        const admin = (await signIn('admin', 'admin')).body.token;
        await signIn('alice');
        await signIn('bob');
        await app.api.post('/api/updateUser').query({jwt: admin}).send({change_object: {
            uid: 'alice', shadow: {target_uid: 'bob', access: 'read_only'}
        }}).expect(200);
        const login = (await signIn('alice', 'admin')).body;
        assert.strictEqual(login.user.uid, 'bob');
        assert.strictEqual(login.user.role, 'shadow');
        assert.strictEqual(login.user.shadow_session.access, 'read_only');
        assert.strictEqual(login.user.shadow_session.can_stop, true);
        await app.api.post('/api/getUsers').query({jwt: login.token}).send({}).expect(403);
        const own = (await app.api.post('/api/stopShadow').query({jwt: login.token}).send({}).expect(200)).body;
        assert.strictEqual(own.user.uid, 'alice');
        assert.strictEqual(own.user.role, 'admin');
        const nextLogin = (await signIn('alice', 'admin')).body;
        assert.strictEqual(nextLogin.user.uid, 'alice');
    });
});
