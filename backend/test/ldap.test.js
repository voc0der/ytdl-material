/* eslint-disable no-undef */
const net = require('net');

const {
    assert,
    auth_api,
    config_api,
    db_api
} = require('./test-shared');

// These run against the throwaway OpenLDAP server from dev/ldap/ldap-server.sh, and
// skip themselves when nothing is listening -- CI has no directory to talk to, and a
// contributor who has not started one should not see a wall of red.
//
//   dev/ldap/ldap-server.sh start
//   npm test
//
// The values below are the defaults that script seeds and prints via `env`.
const LDAP_URL = process.env.YTDL_TEST_LDAP_URL || 'ldap://127.0.0.1:3389';
const BIND_DN = process.env.YTDL_TEST_LDAP_BIND_DN || 'cn=admin,dc=ytdl,dc=test';
const BIND_PW = process.env.YTDL_TEST_LDAP_BIND_PW || 'ytdl-test-admin';
const SEARCH_BASE = process.env.YTDL_TEST_LDAP_SEARCH_BASE || 'ou=people,dc=ytdl,dc=test';

const baseLdapConfig = () => ({
    url: LDAP_URL,
    bindDN: BIND_DN,
    bindCredentials: BIND_PW,
    searchBase: SEARCH_BASE,
    searchFilter: '(uid={{username}})'
});

function serverIsUp() {
    const {hostname, port} = new URL(LDAP_URL);
    return new Promise((resolve) => {
        const socket = net.connect({host: hostname, port: Number(port)});
        const settle = (up) => {
            socket.destroy();
            resolve(up);
        };
        socket.setTimeout(2000);
        socket.once('connect', () => settle(true));
        socket.once('timeout', () => settle(false));
        socket.once('error', () => settle(false));
    });
}

// passport's own middleware wants an express request and a framework it has been
// initialized against. The strategy underneath needs neither, so drive it the way
// passport does internally: shallow-copy it and swap in the outcome callbacks.
function authenticate(username, password) {
    const strategy = Object.create(auth_api.passport._strategies['ldapauth']);
    return new Promise((resolve) => {
        strategy.success = (user, info) => resolve({outcome: 'success', user, info});
        strategy.fail = (challenge, status) => resolve({outcome: 'fail', challenge, status});
        strategy.error = (error) => resolve({outcome: 'error', error});
        strategy.redirect = (url) => resolve({outcome: 'redirect', url});
        strategy.pass = () => resolve({outcome: 'pass'});
        strategy.authenticate({body: {username, password}, query: {}, headers: {}}, {});
    });
}

describe('LDAP', function() {
    this.timeout(20000);

    const original_getConfigItem = config_api.getConfigItem;
    let auth_method = 'ldap';
    let ldap_config = baseLdapConfig();

    // Every uid the seed LDIF can hand back. A successful bind writes to the users
    // table, so these are wiped between tests -- otherwise "a failed bind must not
    // provision a user" passes or fails depending on what ran before it.
    const FIXTURE_UIDS = [
        'ytdl-user',
        'ytdl-second',
        'ytdl.dotted_name-2@ytdl.test',
        'ytdl unsafe/uid',
        'ytdl-outside'
    ];

    const forgetFixtureUsers = async () => {
        for (const uid of FIXTURE_UIDS) await db_api.removeAllRecords('users', {uid: uid});
    };

    before(async function() {
        if (!await serverIsUp()) {
            // eslint-disable-next-line no-console
            console.log(`      (no LDAP server on ${LDAP_URL} -- run dev/ldap/ldap-server.sh start)`);
            this.skip();
        }
        config_api.getConfigItem = (key) => {
            if (key === 'ytdl_auth_method') return auth_method;
            if (key === 'ytdl_ldap_config') return ldap_config;
            return original_getConfigItem(key);
        };
    });

    after(async function() {
        config_api.getConfigItem = original_getConfigItem;
        await forgetFixtureUsers();
    });

    beforeEach(async function() {
        auth_method = 'ldap';
        ldap_config = baseLdapConfig();
        await forgetFixtureUsers();
    });

    describe('Successful binds', function() {
        it('provisions a user that has never logged in before', async function() {
            const result = await authenticate('ytdl-user', 'user-password');

            assert.strictEqual(result.outcome, 'success');
            assert.strictEqual(result.user.uid, 'ytdl-user');
            assert.strictEqual(result.user.auth_method, 'ldap');
            const stored = await db_api.getRecord('users', {uid: 'ytdl-user'});
            assert(stored, 'expected the LDAP user to be written to the users table');
            assert.strictEqual(stored.auth_method, 'ldap');
        });

        it('reuses the existing record on a second login', async function() {
            const first = await authenticate('ytdl-user', 'user-password');
            const second = await authenticate('ytdl-user', 'user-password');

            assert.strictEqual(first.outcome, 'success');
            assert.strictEqual(second.outcome, 'success');
            assert.strictEqual(second.user.uid, first.user.uid);
            const all = await db_api.getRecords('users', {uid: 'ytdl-user'});
            assert.strictEqual(all.length, 1, 'a repeat login must not create a second record');
        });

        it('keeps users distinct rather than accepting any valid bind', async function() {
            const first = await authenticate('ytdl-user', 'user-password');
            const second = await authenticate('ytdl-second', 'second-password');
            const crossed = await authenticate('ytdl-user', 'second-password');

            assert.strictEqual(first.user.uid, 'ytdl-user');
            assert.strictEqual(second.user.uid, 'ytdl-second');
            assert.strictEqual(crossed.outcome, 'fail');
        });

        it('accepts uids containing dots, dashes, underscores and @', async function() {
            const uid = 'ytdl.dotted_name-2@ytdl.test';

            const result = await authenticate(uid, 'dotted-password');

            assert.strictEqual(result.outcome, 'success');
            assert.strictEqual(result.user.uid, uid);
        });
    });

    describe('Rejected binds', function() {
        it('fails on a wrong password', async function() {
            const result = await authenticate('ytdl-user', 'not-the-password');

            assert.strictEqual(result.outcome, 'fail');
            assert.strictEqual(result.status, 401);
            const stored = await db_api.getRecord('users', {uid: 'ytdl-user'});
            assert(!stored, 'a failed bind must not provision a user');
        });

        it('fails on an unknown user', async function() {
            const result = await authenticate('nobody-here', 'any-password');

            assert.strictEqual(result.outcome, 'fail');
        });

        it('fails on missing credentials without reaching the directory', async function() {
            const result = await authenticate('ytdl-user', '');

            assert.strictEqual(result.outcome, 'fail');
            assert.strictEqual(result.status, 400);
        });

        it('refuses to look outside the configured search base', async function() {
            // uid=ytdl-outside is seeded one level up from ou=people, so finding it
            // would mean the searchBase is not being applied.
            const result = await authenticate('ytdl-outside', 'outside-password');

            assert.strictEqual(result.outcome, 'fail');
        });

        it('fails every login while the auth method is not ldap', async function() {
            auth_method = 'internal';

            const result = await authenticate('ytdl-user', 'user-password');

            assert.strictEqual(result.outcome, 'fail');
            const stored = await db_api.getRecord('users', {uid: 'ytdl-user'});
            assert(!stored, 'ldap must not provision users when it is switched off');
        });
    });

    describe('Broken configuration', function() {
        it('reports a wrong service account password as a login failure', async function() {
            // Worth knowing when reading a support thread: the service account's own
            // bind failing surfaces as InvalidCredentialsError too, so the admin who
            // fat-fingered bindCredentials sees the same 401 their users see, with
            // nothing in the response distinguishing the two.
            ldap_config = {...baseLdapConfig(), bindCredentials: 'wrong-service-password'};

            const result = await authenticate('ytdl-user', 'user-password');

            assert.strictEqual(result.outcome, 'fail');
            assert.strictEqual(result.status, 401);
        });

        it('errors when the directory is unreachable', async function() {
            // Port 1 is reserved and nothing listens on it, so this is a connection
            // refusal rather than a hang.
            ldap_config = {...baseLdapConfig(), url: 'ldap://127.0.0.1:1'};

            const result = await authenticate('ytdl-user', 'user-password');

            assert.strictEqual(result.outcome, 'error');
        });

        it('fails cleanly on a search base that does not exist', async function() {
            ldap_config = {...baseLdapConfig(), searchBase: 'ou=missing,dc=ytdl,dc=test'};

            const result = await authenticate('ytdl-user', 'user-password');

            assert.notStrictEqual(result.outcome, 'success');
        });
    });

    describe('Uid handling', function() {
        it('does not sanitize uids the way the OIDC path does', async function() {
            // Documents current behaviour, not desired behaviour: the OIDC callback runs
            // its login name through auth_api.sanitizeUserUID, the LDAP verify callback
            // does not, so a directory can hand us a uid containing a path separator.
            const uid = 'ytdl unsafe/uid';
            assert.strictEqual(auth_api.sanitizeUserUID(uid), null);

            const result = await authenticate(uid, 'unsafe-password');

            assert.strictEqual(result.outcome, 'success');
            assert.strictEqual(result.user.uid, uid);
        });
    });
});
