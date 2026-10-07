const express = require('express');
const request = require('supertest');

const { assert, auth_api, config_api, db_api } = require('./test-shared');
const header_auth = require('../authentication/header-auth');

/*************************************************
 * Header sign-in hands out an account to whoever a
 * header names, so nearly everything here is about
 * when the headers are not to be believed: from
 * the wrong address, sent twice, naming something
 * that is not a uid, or switched on beside another
 * way of signing in.
 *
 * supertest connects over loopback, so 127.0.0.1
 * is the trusted proxy in these tests, and any
 * other address makes the same connection an
 * untrusted one.
 ************************************************/
describe('Header sign-in', function() {
    const original_getConfigItem = config_api.getConfigItem;
    const PREFIX = 'header_test_';
    const ALICE = PREFIX + 'alice';

    const BASE_SETTINGS = {
        ytdl_multi_user_mode: true,
        ytdl_oidc_enabled: false,
        ytdl_auth_method: 'internal',
        ytdl_header_auth_enabled: true,
        ytdl_header_auth_trusted_proxies: '127.0.0.1, ::1',
        ytdl_header_auth_user_header: 'Remote-User',
        ytdl_header_auth_auto_register: true,
        ytdl_header_auth_groups_header: 'Remote-Groups',
        ytdl_header_auth_admin_group: 'admin',
        ytdl_header_auth_allowed_groups: ''
    };
    let settings = {...BASE_SETTINGS};

    function configure(overrides = {}) {
        settings = {...BASE_SETTINGS, ...overrides};
        return header_auth.initialize();
    }

    function server({trust_proxy = false} = {}) {
        const app = express();
        if (trust_proxy) app.set('trust proxy', true);
        app.post('/login', async (req, res) => {
            const result = await header_auth.signIn(req);
            if (result.error) {
                res.status(result.status).send({error: result.error});
                return;
            }
            res.send({uid: result.user.uid, role: result.user.role, auth_method: result.user.auth_method});
        });
        app.get('/status', (req, res) => res.send(header_auth.getStatus(req)));
        return app;
    }

    const signIn = (name, options) => {
        const req = request(server(options)).post('/login');
        return name === undefined ? req : req.set('Remote-User', name);
    };

    async function removeTestUsers() {
        for (const user of await db_api.getRecords('users')) {
            if (String(user.uid).startsWith(PREFIX) || String(user.name).startsWith(PREFIX)) {
                await db_api.removeAllRecords('users', {uid: user.uid});
            }
        }
    }

    const usersNamed = async (uid) => db_api.getRecords('users', {uid: uid});

    before(function() {
        config_api.getConfigItem = (key) => key in settings ? settings[key] : original_getConfigItem(key);
    });

    beforeEach(async function() {
        await removeTestUsers();
        configure();
    });

    after(async function() {
        settings = {...BASE_SETTINGS, ytdl_header_auth_enabled: false};
        header_auth.initialize();
        config_api.getConfigItem = original_getConfigItem;
        await removeTestUsers();
    });

    describe('Starting up', function() {
        it('stays off unless it is switched on, and then answers no request', async function() {
            for (const enabled of [false, undefined, '', 'yes', '1']) {
                assert.strictEqual(configure({ytdl_header_auth_enabled: enabled}), false, JSON.stringify(enabled));
                assert.strictEqual(header_auth.isEnabled(), false);
            }
            await signIn(ALICE).expect(404);
            assert.deepStrictEqual(await usersNamed(ALICE), []);
        });

        it('switches on with a usable configuration', function() {
            assert.strictEqual(configure({ytdl_header_auth_enabled: 'true'}), true);
            assert.strictEqual(header_auth.isEnabled(), true);
        });

        const refusals = [
            ['without multi-user mode', {ytdl_multi_user_mode: false}, /multi-user mode/],
            ['alongside OIDC', {ytdl_oidc_enabled: true}, /together with OIDC/],
            ['alongside LDAP', {ytdl_auth_method: 'ldap'}, /together with LDAP/],
            ['without a trusted proxy', {ytdl_header_auth_trusted_proxies: ''}, /trusted_proxies is empty/],
            ['with a host name for a proxy', {ytdl_header_auth_trusted_proxies: '10.0.0.1, traefik'}, /not IP addresses or CIDR ranges: traefik/],
            ['trusting every IPv4 address', {ytdl_header_auth_trusted_proxies: '0.0.0.0/0'}, /trusts every address/],
            ['trusting every IPv6 address', {ytdl_header_auth_trusted_proxies: '10.0.0.1, ::/0'}, /trusts every address/],
            ['with a header name that is not one', {ytdl_header_auth_user_header: 'Remote User'}, /not a valid header name/],
            ['reading a header that means something else', {ytdl_header_auth_user_header: 'Authorization'}, /already means something else/],
            ['reading the address a proxy forwards', {ytdl_header_auth_user_header: 'x-forwarded-for'}, /already means something else/],
            ['with a groups header name that is not one', {ytdl_header_auth_groups_header: 'Remote Groups'}, /groups_header "Remote Groups" is not a valid header name/],
            ['reading groups from a header that means something else', {ytdl_header_auth_groups_header: 'Cookie'}, /groups_header cannot be Cookie/],
            ['reading groups from the header that names the user', {ytdl_header_auth_groups_header: 'remote-user'}, /that header names the user/],
            ['with allowed groups but no groups header', {ytdl_header_auth_groups_header: '', ytdl_header_auth_allowed_groups: 'media'}, /allowed_groups needs ytdl_header_auth_groups_header/]
        ];
        for (const [situation, overrides, message] of refusals) {
            it('refuses to start ' + situation, function() {
                assert.throws(() => configure(overrides), message);
                assert.strictEqual(header_auth.isEnabled(), false, 'a refused start must not leave it half on');
            });
        }

        it('reads Remote-User when no header is named, and no groups until their header is', async function() {
            configure({ytdl_header_auth_user_header: '  ', ytdl_header_auth_groups_header: ''});
            const status = (await request(server()).get('/status').set('Remote-Groups', 'admin').expect(200)).body;
            assert.strictEqual(status.user_header, 'Remote-User');
            assert.strictEqual(status.groups_header, '');
            assert.deepStrictEqual(status.request.group_values, []);
            // A groups header nobody named may be the browser's own, not the proxy's.
            assert.deepStrictEqual((await signIn(ALICE).set('Remote-Groups', 'admin').expect(200)).body,
                {uid: ALICE, role: 'user', auth_method: 'header'});
            await signIn(ALICE).set('Remote-Groups', ['admin', 'admin']).expect(200);
        });

        it('makes admin the administrator group when none is named', async function() {
            configure({ytdl_header_auth_admin_group: ' '});
            assert.strictEqual((await request(server()).get('/status').expect(200)).body.admin_group, 'admin');
            assert.strictEqual((await signIn(ALICE).set('Remote-Groups', 'admin').expect(200)).body.role, 'admin');
        });
    });

    describe('Who is believed', function() {
        it('signs in a new name from a trusted proxy as an ordinary account with no password', async function() {
            const res = await signIn(ALICE).expect(200);
            assert.deepStrictEqual(res.body, {uid: ALICE, role: 'user', auth_method: 'header'});

            const [stored] = await usersNamed(ALICE);
            assert.strictEqual(stored.name, ALICE);
            assert.strictEqual(stored.passhash, null);
            assert.strictEqual(await auth_api.login(ALICE, ''), false);
        });

        it('ignores the header from any other address', async function() {
            configure({ytdl_header_auth_trusted_proxies: '10.0.0.1, fd00::/8'});
            await signIn(ALICE).expect(401);
            assert.deepStrictEqual(await usersNamed(ALICE), []);
        });

        it('goes by the connection, not by what the request says about where it came from', async function() {
            configure({ytdl_header_auth_trusted_proxies: '10.0.0.1'});
            await signIn(ALICE, {trust_proxy: true})
                .set('X-Forwarded-For', '10.0.0.1')
                .set('X-Real-IP', '10.0.0.1')
                .set('Forwarded', 'for=10.0.0.1')
                .expect(401);
            assert.deepStrictEqual(await usersNamed(ALICE), []);
        });

        it('refuses a request from the proxy that names nobody', async function() {
            await signIn().expect(401);
            await signIn('').expect(401);
        });

        it('refuses a header that arrives more than once', async function() {
            // What a proxy that adds its own value, rather than replacing the client's, sends.
            await signIn([PREFIX + 'mallory', ALICE]).expect(401);
            await signIn(['', ALICE]).expect(401);
            assert.deepStrictEqual(await usersNamed(ALICE), []);
        });

        it('refuses a groups header that arrives more than once', async function() {
            await signIn(ALICE).set('Remote-Groups', ['admin', 'users']).expect(401);
            await signIn(ALICE).set('Remote-Groups', ['admin', '']).expect(401);
            assert.deepStrictEqual(await usersNamed(ALICE), []);
        });

        it('refuses a name that could not be a uid', async function() {
            for (const name of ['..', '../' + ALICE, ALICE + '/x', ALICE + ' smith', ALICE + ',' + PREFIX + 'bob']) {
                await signIn(name).expect(403);
            }
            assert.deepStrictEqual((await db_api.getRecords('users')).filter(user => String(user.uid).includes(ALICE)), []);
        });

        it('reads the header it was told to, whatever its case, and no other', async function() {
            configure({ytdl_header_auth_user_header: 'X-authentik-username'});
            const res = await request(server()).post('/login').set('x-AUTHENTIK-USERNAME', ALICE).expect(200);
            assert.strictEqual(res.body.uid, ALICE);
            await signIn(PREFIX + 'bob').expect(401);
        });
    });

    describe('Which account', function() {
        it('signs in to the account with that uid and leaves its password alone', async function() {
            await auth_api.registerUser(ALICE, ALICE, 'alice-password');

            const res = await signIn(ALICE).expect(200);
            assert.deepStrictEqual(res.body, {uid: ALICE, role: 'user', auth_method: 'internal'});
            assert.strictEqual((await usersNamed(ALICE)).length, 1);
            // Still there for when header sign-in is switched off again.
            assert.strictEqual((await auth_api.login(ALICE, 'alice-password')).uid, ALICE);
        });

        it('never picks an account by its name', async function() {
            // An administrator can rename anyone to anything, so a name proves nothing.
            await auth_api.registerUser(PREFIX + 'carol', ALICE, 'carol-password');

            await signIn(ALICE).expect(403);
            assert.deepStrictEqual(await usersNamed(ALICE), []);
            assert.strictEqual((await db_api.getRecord('users', {uid: PREFIX + 'carol'})).name, ALICE);
        });

        it('only lets known names in while registering on first sign-in is off', async function() {
            configure({ytdl_header_auth_auto_register: false});
            await signIn(ALICE).expect(403);
            assert.deepStrictEqual(await usersNamed(ALICE), []);

            await auth_api.registerUser(ALICE, ALICE, 'alice-password');
            assert.strictEqual((await signIn(ALICE).expect(200)).body.uid, ALICE);
        });

        it('creates one account when two first sign-ins arrive together', async function() {
            const responses = await Promise.all([1, 2, 3, 4, 5].map(() => signIn(ALICE)));
            assert.deepStrictEqual(responses.map(res => res.status), [200, 200, 200, 200, 200]);
            assert.strictEqual((await usersNamed(ALICE)).length, 1);
        });

        it('fails the sign-in when the database will not create the account', async function() {
            const insert = db_api.insertRecordIntoTable;
            db_api.insertRecordIntoTable = async () => false;
            try {
                await signIn(ALICE).expect(403);
            } finally {
                db_api.insertRecordIntoTable = insert;
            }
            assert.deepStrictEqual(await usersNamed(ALICE), []);
        });
    });

    describe('Administrators', function() {
        it('makes members of the administrator group administrators', async function() {
            assert.strictEqual((await signIn(ALICE).set('Remote-Groups', 'users,admin').expect(200)).body.role, 'admin');
            assert.strictEqual((await signIn(PREFIX + 'dave').set('Remote-Groups', 'users').expect(200)).body.role, 'user');
            assert.strictEqual((await signIn(PREFIX + 'erin').expect(200)).body.role, 'user');
        });

        it('reads the groups header it was told to, split on commas or pipes, in any case', async function() {
            configure({ytdl_header_auth_groups_header: 'X-authentik-groups', ytdl_header_auth_admin_group: 'Media Admins'});
            assert.strictEqual((await signIn(ALICE).set('x-AUTHENTIK-GROUPS', 'users|media admins').expect(200)).body.role, 'admin');
            assert.strictEqual((await signIn(ALICE).set('Remote-Groups', 'Media Admins').expect(200)).body.role, 'user');
        });

        it('matches whole group names only', async function() {
            for (const groups of ['administrators', 'not-admin', 'admin users', 'admins|users']) {
                assert.strictEqual((await signIn(ALICE).set('Remote-Groups', groups).expect(200)).body.role, 'user', groups);
            }
        });

        it('takes the rights away from somebody no longer in the group, at their next sign-in', async function() {
            assert.strictEqual((await signIn(ALICE).set('Remote-Groups', 'admin').expect(200)).body.role, 'admin');

            assert.strictEqual((await signIn(ALICE).set('Remote-Groups', 'users').expect(200)).body.role, 'user');
            assert.strictEqual((await db_api.getRecord('users', {uid: ALICE})).role, 'user');
        });

        it('demotes an existing administrator who signs in through the proxy outside the group', async function() {
            await auth_api.registerUser(ALICE, ALICE, 'alice-password');
            await db_api.updateRecord('users', {uid: ALICE}, {role: 'admin'});

            assert.strictEqual((await signIn(ALICE).expect(200)).body.role, 'user');
        });

        it('fails the sign-in when the database will not change the role', async function() {
            await signIn(ALICE).expect(200);

            const update = db_api.updateRecord;
            db_api.updateRecord = async () => false;
            try {
                await signIn(ALICE).set('Remote-Groups', 'admin').expect(403);
            } finally {
                db_api.updateRecord = update;
            }
            assert.strictEqual((await db_api.getRecord('users', {uid: ALICE})).role, 'user');
        });
    });

    describe('Allowed groups', function() {
        it('lets in only members of a listed group, and makes no account for anybody else', async function() {
            configure({ytdl_header_auth_allowed_groups: 'media, family'});
            await signIn(ALICE).expect(403);
            // The administrator group is not one of them by itself.
            await signIn(ALICE).set('Remote-Groups', 'admin').expect(403);
            assert.deepStrictEqual(await usersNamed(ALICE), []);

            assert.strictEqual((await signIn(ALICE).set('Remote-Groups', 'users,FAMILY').expect(200)).body.uid, ALICE);
        });
    });

    describe('What the settings page is told', function() {
        it('reports the settings in force and what was made of the request', async function() {
            configure({ytdl_header_auth_allowed_groups: 'media, family', ytdl_header_auth_auto_register: false});
            const res = await request(server()).get('/status').set('Remote-User', ALICE).set('Remote-Groups', 'admin,media').expect(200);
            assert.deepStrictEqual(res.body, {
                enabled: true,
                user_header: 'Remote-User',
                groups_header: 'Remote-Groups',
                trusted_proxies: ['127.0.0.1', '::1'],
                auto_register: false,
                admin_group: 'admin',
                allowed_groups: ['media', 'family'],
                request: {peer: '127.0.0.1', trusted: true, values: [ALICE], group_values: ['admin,media']}
            });
        });

        it('says when the request did not come from a trusted proxy, or named nobody', async function() {
            configure({ytdl_header_auth_trusted_proxies: '10.0.0.1'});
            const res = await request(server()).get('/status').expect(200);
            assert.deepStrictEqual(res.body.request, {peer: '127.0.0.1', trusted: false, values: [], group_values: []});
        });

        it('says only that it is off when it is off', async function() {
            configure({ytdl_header_auth_enabled: false});
            assert.deepStrictEqual((await request(server()).get('/status').expect(200)).body, {enabled: false});
        });
    });

    describe('Checking a config before it is saved', function() {
        const config = (overrides = {}) => ({
            Advanced: {multi_user_mode: true},
            Users: {auth_method: 'internal', oidc: {enabled: false}},
            ...overrides
        });

        it('accepts one it could start with', function() {
            assert.strictEqual(header_auth.findConflictInConfig(config()), null);
        });

        it('refuses OIDC, LDAP, or no multi-user mode beside header sign-in', function() {
            assert.match(header_auth.findConflictInConfig(config({Users: {auth_method: 'internal', oidc: {enabled: true}}})), /OIDC/);
            assert.match(header_auth.findConflictInConfig(config({Users: {auth_method: 'internal', oidc: {enabled: 'true'}}})), /OIDC/);
            assert.match(header_auth.findConflictInConfig(config({Users: {auth_method: 'ldap', oidc: {enabled: false}}})), /LDAP/);
            assert.match(header_auth.findConflictInConfig(config({Advanced: {multi_user_mode: false}})), /multi-user mode/);
            assert.match(header_auth.findConflictInConfig({}), /multi-user mode/);
        });
    });
});
