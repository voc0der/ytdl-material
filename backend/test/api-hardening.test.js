/* eslint-disable no-undef */
const path = require('path');

const {
    assert,
    auth_api,
    config_api,
    utils
} = require('./test-shared');

describe('API hardening', function() {
    describe('Media path containment', function() {
        // Stored paths are what the downloader wrote, which is relative to the backend's
        // working directory and inside one of the four configured roots. These assertions
        // exist mostly to prove the containment check does not reject that ordinary shape.
        it('accepts paths inside each configured media root', function() {
            const roots = {
                'ytdl_video_folder_path': config_api.getConfigItem('ytdl_video_folder_path'),
                'ytdl_audio_folder_path': config_api.getConfigItem('ytdl_audio_folder_path'),
                'ytdl_users_base_path': config_api.getConfigItem('ytdl_users_base_path'),
                'ytdl_subscriptions_base_path': config_api.getConfigItem('ytdl_subscriptions_base_path')
            };

            for (const [key, root] of Object.entries(roots)) {
                assert(root, `expected ${key} to be configured`);
                assert(utils.isPathInsideMediaRoots(path.join(root, 'example.mp4')),
                    `a file directly inside ${key} should be accepted`);
                assert(utils.isPathInsideMediaRoots(path.join(root, 'nested', 'deeper', 'example.mp4')),
                    `a file nested inside ${key} should be accepted`);
            }
        });

        it('accepts an absolute path that resolves into a root', function() {
            const root = config_api.getConfigItem('ytdl_video_folder_path');

            assert(utils.isPathInsideMediaRoots(path.resolve(root, 'example.mp4')));
        });

        it('rejects traversal out of a root', function() {
            const root = config_api.getConfigItem('ytdl_video_folder_path');

            assert(!utils.isPathInsideMediaRoots(path.join(root, '..', '..', 'etc', 'passwd')));
            assert(!utils.isPathInsideMediaRoots(path.join(root, '..', 'app.js')));
        });

        it('rejects absolute paths outside every root', function() {
            assert(!utils.isPathInsideMediaRoots('/etc/passwd'));
            assert(!utils.isPathInsideMediaRoots('/'));
        });

        it('rejects values that are not usable paths', function() {
            assert(!utils.isPathInsideMediaRoots(''));
            assert(!utils.isPathInsideMediaRoots('   '));
            assert(!utils.isPathInsideMediaRoots(null));
            assert(!utils.isPathInsideMediaRoots(undefined));
            assert(!utils.isPathInsideMediaRoots(42));
            assert(!utils.isPathInsideMediaRoots(['video/x.mp4']));
        });

        it('does not treat a sibling directory with a shared prefix as contained', function() {
            // 'videos-backup' starts with 'video' as a string but is not inside it.
            const root = config_api.getConfigItem('ytdl_video_folder_path');
            const sibling = path.resolve(root).replace(/\/$/, '') + '-backup';

            assert(!utils.isPathInsideMediaRoots(path.join(sibling, 'example.mp4')));
        });
    });

    describe('User records leaving the process', function() {
        const userWithHash = () => ({
            uid: 'someone',
            name: 'Someone',
            passhash: '$2a$10$abcdefghijklmnopqrstuv',
            role: 'user',
            permissions: [],
            permission_overrides: []
        });

        it('strips the password hash', function() {
            const sanitized = auth_api.sanitizeUserForResponse(userWithHash());

            assert.strictEqual(sanitized.passhash, undefined);
            assert.strictEqual(sanitized.uid, 'someone');
            assert.strictEqual(sanitized.role, 'user');
        });

        it('does not mutate the record it was given', function() {
            const original = userWithHash();

            auth_api.sanitizeUserForResponse(original);

            assert.strictEqual(original.passhash, '$2a$10$abcdefghijklmnopqrstuv',
                'sanitizing a record must not damage the copy the caller is still using');
        });

        it('handles a list of users', function() {
            const sanitized = auth_api.sanitizeUsersForResponse([userWithHash(), userWithHash()]);

            assert.strictEqual(sanitized.length, 2);
            for (const user of sanitized) assert.strictEqual(user.passhash, undefined);
        });

        it('passes through values that are not user records', function() {
            assert.strictEqual(auth_api.sanitizeUserForResponse(null), null);
            assert.strictEqual(auth_api.sanitizeUserForResponse(undefined), undefined);
            assert.deepStrictEqual(auth_api.sanitizeUsersForResponse(null), null);
        });

        it('keeps the hash out of the login response', async function() {
            // getAuthResponseObject signs a JWT, which needs the secret initialize() loads.
            auth_api.initialize();
            const user = await auth_api.registerUser('hardening_test_user', 'hardening_test_user', 'test_pass');
            assert(user, 'precondition: the test user should register');

            try {
                const auth_response = await auth_api.getAuthResponseObject(user);

                assert.strictEqual(auth_response.user.passhash, undefined);
                assert(auth_response.user.uid, 'the response should still carry the user');
                assert(auth_response.token, 'the response should still carry a token');
            } finally {
                await auth_api.deleteUser('hardening_test_user');
            }
        });
    });
});

describe('Permission resolution', function() {
    const {assert, auth_api, db_api} = require('./test-shared');

    const ROLE_KEY = 'hardening_test_role';
    const USER_UID = 'hardening_perm_user';

    // The role grants filemanager and subscriptions; overrides are set per test.
    const givenUser = async (permissions, permission_overrides) => {
        await db_api.removeAllRecords('users', {uid: USER_UID});
        await db_api.insertRecordIntoTable('users', {
            uid: USER_UID,
            name: USER_UID,
            role: ROLE_KEY,
            permissions: permissions,
            permission_overrides: permission_overrides
        });
    };

    before(async function() {
        await db_api.removeAllRecords('roles', {key: ROLE_KEY});
        await db_api.insertRecordIntoTable('roles', {
            key: ROLE_KEY,
            permissions: ['filemanager', 'subscriptions']
        });
    });

    after(async function() {
        await db_api.removeAllRecords('roles', {key: ROLE_KEY});
        await db_api.removeAllRecords('users', {uid: USER_UID});
    });

    it('grants what the role grants when there are no overrides', async function() {
        await givenUser([], []);

        assert.strictEqual(await auth_api.userHasPermission(USER_UID, 'filemanager'), true);
        assert.strictEqual(await auth_api.userHasPermission(USER_UID, 'tasks_manager'), false);
        assert.deepStrictEqual(await auth_api.userPermissions(USER_UID), ['filemanager', 'subscriptions']);
    });

    it('honours a positive override for something the role lacks', async function() {
        await givenUser(['tasks_manager'], ['tasks_manager']);

        assert.strictEqual(await auth_api.userHasPermission(USER_UID, 'tasks_manager'), true);
        assert((await auth_api.userPermissions(USER_UID)).includes('tasks_manager'));
    });

    it('honours a negative override for something the role grants', async function() {
        await givenUser([], ['filemanager']);

        assert.strictEqual(await auth_api.userHasPermission(USER_UID, 'filemanager'), false);
        assert(!(await auth_api.userPermissions(USER_UID)).includes('filemanager'));
    });

    it('reports a permission once when the role and a positive override agree', async function() {
        // The list resolver used to fall through after a positive override and push the
        // same permission a second time from the role check.
        await givenUser(['filemanager'], ['filemanager']);

        const permissions = await auth_api.userPermissions(USER_UID);

        assert.deepStrictEqual(permissions, [...new Set(permissions)], 'permissions must not repeat');
        assert.strictEqual(permissions.filter(p => p === 'filemanager').length, 1);
    });

    it('agrees with itself across both resolvers', async function() {
        await givenUser(['tasks_manager'], ['tasks_manager', 'subscriptions']);

        const listed = await auth_api.userPermissions(USER_UID);
        for (const permission of ['filemanager', 'subscriptions', 'tasks_manager', 'settings']) {
            assert.strictEqual(await auth_api.userHasPermission(USER_UID, permission), listed.includes(permission),
                `userHasPermission and userPermissions disagree about ${permission}`);
        }
    });

    it('fails closed when the role record is missing', async function() {
        await db_api.removeAllRecords('users', {uid: USER_UID});
        await db_api.insertRecordIntoTable('users', {
            uid: USER_UID, name: USER_UID, role: 'role_that_does_not_exist',
            permissions: [], permission_overrides: []
        });

        assert.strictEqual(await auth_api.userHasPermission(USER_UID, 'filemanager'), false);
        assert.deepStrictEqual(await auth_api.userPermissions(USER_UID), []);
    });

    it('fails closed for a user that does not exist', async function() {
        assert.strictEqual(await auth_api.userHasPermission('no_such_user_at_all', 'filemanager'), false);
        assert.deepStrictEqual(await auth_api.userPermissions('no_such_user_at_all'), []);
    });

    it('tolerates a record with missing permission arrays', async function() {
        await db_api.removeAllRecords('users', {uid: USER_UID});
        await db_api.insertRecordIntoTable('users', {uid: USER_UID, name: USER_UID, role: ROLE_KEY});

        assert.strictEqual(await auth_api.userHasPermission(USER_UID, 'filemanager'), true);
        assert.strictEqual(await auth_api.userHasPermission(USER_UID, 'settings'), false);
    });
});

describe('Config redaction', function() {
    const {assert, config_api} = require('./test-shared');

    it('removes every path on the sensitive list', function() {
        const redacted = config_api.getRedactedConfigFile();
        assert(redacted, 'precondition: there should be a config file');

        for (const sensitive_path of config_api.SENSITIVE_CONFIG_PATHS) {
            const parts = sensitive_path.split('.');
            const field = parts.pop();
            let node = redacted;
            for (const part of parts) node = node && node[part];
            if (!node) continue; // section absent entirely, nothing to leak
            assert(!(field in node), `${sensitive_path} should not survive redaction`);
        }
    });

    it('covers the secrets that actually exist in the config', function() {
        // Guards against the list drifting behind the config: anything whose key looks
        // like a credential should be on it.
        const full = config_api.getConfigFile();
        const listed = new Set(config_api.SENSITIVE_CONFIG_PATHS);
        const exempt = new Set(Object.keys(config_api.CLIENT_VISIBLE_CONFIG_PATHS));
        const missing = [];

        const walk = (node, trail) => {
            if (!node || typeof node !== 'object' || Array.isArray(node)) return;
            for (const [key, value] of Object.entries(node)) {
                const dotted = `${trail}.${key}`;
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    walk(value, dotted);
                } else if (/secret|token|_key$|credential|password/i.test(key) && !/^use_/.test(key)) {
                    if (!listed.has(dotted) && !exempt.has(dotted)) missing.push(dotted);
                }
            }
        };
        walk(full.YtdlMaterial, 'YtdlMaterial');

        assert.deepStrictEqual(missing, [],
            'these look like credentials but are not redacted. Add them to SENSITIVE_CONFIG_PATHS, '
            + 'or to CLIENT_VISIBLE_CONFIG_PATHS with the reason a client needs them.');
    });

    it('keeps the fields the login page needs', function() {
        const redacted = config_api.getRedactedConfigFile();

        assert.notStrictEqual(redacted.YtdlMaterial.Advanced.multi_user_mode, undefined);
        assert.notStrictEqual(redacted.YtdlMaterial.Users.auth_method, undefined);
        assert.notStrictEqual(redacted.YtdlMaterial.Users.allow_registration, undefined);
    });

    it('does not damage the live config', function() {
        const before = JSON.stringify(config_api.getConfigFile());

        config_api.getRedactedConfigFile();

        assert.strictEqual(JSON.stringify(config_api.getConfigFile()), before,
            'redaction must work on a copy');
    });
});

describe('Config fields the client still needs', function() {
    const {assert, config_api} = require('./test-shared');

    it('leaves the browser-side search key in place', function() {
        // main.component reads this to run the search in the browser. Redacting it does
        // not protect anything the logged-in user cannot already see, and it does break
        // search for everyone who is not an administrator.
        const redacted = config_api.getRedactedConfigFile();

        assert('youtube_API_key' in redacted.YtdlMaterial.API);
    });

    it('leaves the downloading agent in place', function() {
        const redacted = config_api.getRedactedConfigFile();

        assert('custom_downloading_agent' in redacted.YtdlMaterial.Advanced);
    });

    it('still redacts the secrets nothing outside settings reads', function() {
        const redacted = config_api.getRedactedConfigFile();

        assert(!('API_key' in redacted.YtdlMaterial.API));
        assert(!('gotify_app_token' in redacted.YtdlMaterial.API));
        assert(!('telegram_bot_token' in redacted.YtdlMaterial.API));
        assert(!('bindCredentials' in redacted.YtdlMaterial.Users.ldap_config));
        assert(!('client_secret' in redacted.YtdlMaterial.Users.oidc));
    });
});
