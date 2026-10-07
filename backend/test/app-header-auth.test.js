const assert = require('assert');

const { startApp } = require('./helpers/app-process');

/*************************************************
 * Header sign-in through the real server: that a
 * server set up for it alongside OIDC or LDAP does
 * not start at all, and that one set up properly
 * signs people in, shuts the password routes, and
 * keeps its settings out of the settings page's
 * reach.
 ************************************************/
describe('Header sign-in on a running server', function() {
    this.timeout(60000);

    const HEADER_AUTH = {
        ytdl_multi_user_mode: 'true',
        ytdl_header_auth_enabled: 'true',
        ytdl_header_auth_trusted_proxies: '127.0.0.1, ::1',
        ytdl_header_auth_groups_header: 'Remote-Groups'
    };

    for (const [situation, env, message] of [
        ['alongside OIDC', {ytdl_oidc_enabled: 'true'}, /Header sign-in startup failed: .*together with OIDC/],
        ['alongside LDAP', {ytdl_auth_method: 'ldap'}, /Header sign-in startup failed: .*together with LDAP/]
    ]) {
        it('does not start ' + situation, async function() {
            await assert.rejects(startApp({env: {...HEADER_AUTH, ...env}}), error => {
                assert.match(error.message, /exited during startup \(code 1/);
                assert.match(error.message, message);
                return true;
            });
        });
    }

    describe('Set up properly', function() {
        let app;
        const signIn = (name, groups = '') => app.api.post('/api/auth/header/login').set('Remote-User', name).set('Remote-Groups', groups);

        before(async function() {
            app = await startApp({env: HEADER_AUTH});
        });

        after(async function() {
            if (app) await app.stop();
        });

        it('signs in whoever the proxy names, with a session the rest of the API accepts', async function() {
            const res = await signIn('alice', 'users,admin').expect(200);
            assert.strictEqual(res.headers['cache-control'], 'no-store');
            assert.strictEqual(res.body.user.uid, 'alice');
            assert.strictEqual(res.body.user.role, 'admin');
            assert.strictEqual(res.body.user.passhash, undefined);

            const session = await app.api.post('/api/auth/jwtAuth').query({jwt: res.body.token}).send({}).expect(200);
            assert.strictEqual(session.body.user.uid, 'alice');
            assert.strictEqual((await signIn('bob').expect(200)).body.user.role, 'user');
        });

        it('refuses a request that names nobody', async function() {
            await app.api.post('/api/auth/header/login').expect(401);
        });

        it('shuts password sign-in and registration', async function() {
            await app.api.post('/api/auth/register').send({userid: 'carol', username: 'carol', password: 'x'}).expect(403);
            await app.api.post('/api/auth/login').send({username: 'alice', password: 'x'}).expect(403);
        });

        it('tells an anonymous caller only that it is on', async function() {
            const config = (await app.api.get('/api/config').expect(200)).body.config_file.YtdlMaterial;
            assert.deepStrictEqual(config.Users.header_auth, {enabled: true, auto_register: true});
        });

        it('shows its status to administrators only', async function() {
            const alice = (await signIn('alice', 'admin').expect(200)).body.token;
            const bob = (await signIn('bob').expect(200)).body.token;

            await app.api.get('/api/auth/header/status').expect(401);
            await app.api.get('/api/auth/header/status').query({jwt: bob}).expect(403);
            const status = (await app.api.get('/api/auth/header/status').query({jwt: alice})
                .set('Remote-User', 'alice').set('Remote-Groups', 'admin').expect(200)).body;
            assert.deepStrictEqual(status.request, {peer: '127.0.0.1', trusted: true, values: ['alice'], group_values: ['admin']});
            assert.strictEqual(status.admin_group, 'admin');
        });

        it('keeps its settings when the settings page saves, and refuses a save the server could not start with', async function() {
            const alice = (await signIn('alice', 'admin').expect(200)).body.token;
            const config = (await app.api.get('/api/config').query({jwt: alice}).expect(200)).body.config_file;
            const save = (changes) => {
                const new_config_file = JSON.parse(JSON.stringify(config));
                changes(new_config_file.YtdlMaterial);
                return app.api.post('/api/setConfig').query({jwt: alice}).send({new_config_file});
            };

            await save(root => { root.Users.header_auth.enabled = false; root.Users.header_auth.trusted_proxies = '0.0.0.0/0'; }).expect(200);
            const saved = (await app.api.get('/api/config').query({jwt: alice}).expect(200)).body.config_file.YtdlMaterial;
            assert.strictEqual(saved.Users.header_auth.enabled, true);
            assert.strictEqual(saved.Users.header_auth.trusted_proxies, '127.0.0.1, ::1');

            const ldap = await save(root => { root.Users.auth_method = 'ldap'; }).expect(400);
            assert.match(ldap.body.error, /together with LDAP/);
            await save(root => { root.Users.oidc.enabled = true; }).expect(400);
            await save(root => { root.Advanced.multi_user_mode = false; }).expect(400);
        });
    });
});
