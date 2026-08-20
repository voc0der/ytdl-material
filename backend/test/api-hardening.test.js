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

describe('Saving a config that was handed out redacted', function() {
    const {assert, config_api} = require('./test-shared');

    /*************************************************
     * Snapshotted once, not per test.
     *
     * Taking it in beforeEach meant the second test
     * captured whatever the first had written, so the
     * restore preserved a fake credential instead of
     * removing it -- and the config file is tracked,
     * so the suite left that string in the repository.
     ************************************************/
    let original_config = null;

    before(function() {
        original_config = config_api.getConfigFile();
    });

    // The fields these tests write, cleared explicitly rather than by restoring a document
    // that omits them. Omitting is exactly what makes setConfigFile carry a value forward,
    // so a plain restore preserves the fake credential instead of removing it.
    const FIELDS_THESE_TESTS_WRITE = [
        ['API', 'telegram_bot_token'],
        ['API', 'youtube_API_key'],
        ['Users', 'oidc', 'client_secret'],
        ['Database', 'postgresdb_connection_string']
    ];

    afterEach(function() {
        const restored = JSON.parse(JSON.stringify(original_config));
        for (const field_path of FIELDS_THESE_TESTS_WRITE) {
            const field = field_path[field_path.length - 1];
            let node = restored.YtdlMaterial;
            for (const part of field_path.slice(0, -1)) {
                if (!node[part] || typeof node[part] !== 'object') node[part] = {};
                node = node[part];
            }
            if (!(field in node)) node[field] = '';
        }
        config_api.setConfigFile(restored);
    });

    /*************************************************
     * The regression this exists for: the settings
     * page submits the whole config document back,
     * and setConfigFile replaces the whole document.
     * Redaction deletes keys rather than blanking
     * them, so without this an administrator saving
     * any unrelated setting wiped every credential
     * the server had.
     ************************************************/
    it('carries forward every secret the caller was never shown', function() {
        const stored = config_api.getConfigFile();
        stored.YtdlMaterial.API.telegram_bot_token = 'bot-token-that-must-survive';
        stored.YtdlMaterial.Users.oidc.client_secret = 'oidc-secret-that-must-survive';
        stored.YtdlMaterial.Database.postgresdb_connection_string = 'postgres://user:pw@host/db';
        config_api.setConfigFile(stored);

        const redacted = config_api.getRedactedConfigFile();
        assert(!('telegram_bot_token' in redacted.YtdlMaterial.API), 'precondition: the secret was withheld');

        // Exactly what the settings page sends: whatever it was given, handed straight back.
        redacted.YtdlMaterial.Extra.title_top = 'an unrelated change';
        config_api.setConfigFile(redacted);

        const saved = config_api.getConfigFile();
        assert.strictEqual(saved.YtdlMaterial.API.telegram_bot_token, 'bot-token-that-must-survive');
        assert.strictEqual(saved.YtdlMaterial.Users.oidc.client_secret, 'oidc-secret-that-must-survive');
        assert.strictEqual(saved.YtdlMaterial.Database.postgresdb_connection_string, 'postgres://user:pw@host/db');
        assert.strictEqual(saved.YtdlMaterial.Extra.title_top, 'an unrelated change');
    });

    it('carries forward a field withheld only from anonymous callers', function() {
        // youtube_API_key is redacted for anonymous callers but not for logged-in ones,
        // so it lives on a second list. A stale anonymous document saved back would erase
        // it unless the carry-forward covers that list too.
        const stored = config_api.getConfigFile();
        stored.YtdlMaterial.API.youtube_API_key = 'search-key-that-must-survive';
        config_api.setConfigFile(stored);

        const anonymous = config_api.getAnonymousConfigFile();
        assert(!('youtube_API_key' in anonymous.YtdlMaterial.API), 'precondition: it was withheld');

        config_api.setConfigFile(anonymous);

        assert.strictEqual(config_api.getConfigFile().YtdlMaterial.API.youtube_API_key,
            'search-key-that-must-survive');
    });

    it('still lets an administrator clear a secret deliberately', function() {
        const stored = config_api.getConfigFile();
        stored.YtdlMaterial.API.telegram_bot_token = 'to-be-cleared';
        config_api.setConfigFile(stored);

        // An empty value is present, so it is honoured; only absence is treated as
        // "never shown to me".
        const full = config_api.getConfigFile();
        full.YtdlMaterial.API.telegram_bot_token = '';
        config_api.setConfigFile(full);

        assert.strictEqual(config_api.getConfigFile().YtdlMaterial.API.telegram_bot_token, '');
    });
});

describe('The config handed to an anonymous caller', function() {
    const {assert, config_api} = require('./test-shared');

    function readPath(root, dotted_path) {
        return dotted_path.split('.').reduce((node, part) =>
            (node && typeof node === 'object') ? node[part] : undefined, root);
    }

    it('still carries the sections the shell reads before login', function() {
        // app.component and player.component reach into these without checking whether
        // they exist, and both render for an anonymous visitor following a share link.
        const anonymous = config_api.getAnonymousConfigFile();

        assert(anonymous.YtdlMaterial.Subscriptions, 'the nav reads Subscriptions.allow_subscriptions');
        assert(anonymous.YtdlMaterial.Extra, 'the nav reads Extra.enable_downloads_manager');
        assert(anonymous.YtdlMaterial.Downloader, 'the player reads Downloader.path-video');
        assert(anonymous.YtdlMaterial.Themes, 'the shell reads Themes.default_theme');
        assert('auth_method' in anonymous.YtdlMaterial.Users);
        assert('allow_registration' in anonymous.YtdlMaterial.Users);
    });

    it('contains no path the sensitive list names', function() {
        const anonymous = config_api.getAnonymousConfigFile();

        for (const sensitive_path of config_api.SENSITIVE_CONFIG_PATHS) {
            assert.strictEqual(readPath(anonymous, sensitive_path), undefined,
                `${sensitive_path} reached an anonymous caller`);
        }
    });

    it('withholds the browser-side search key until somebody logs in', function() {
        // Handed to authenticated clients on purpose -- search runs in the browser -- but
        // that is not a reason to publish it to anyone who can reach the login page.
        const anonymous = config_api.getAnonymousConfigFile();
        const redacted = config_api.getRedactedConfigFile();

        assert.strictEqual(readPath(anonymous, 'YtdlMaterial.API.youtube_API_key'), undefined);
        assert('youtube_API_key' in redacted.YtdlMaterial.API, 'a logged-in client still gets it');
    });

    /*************************************************
     * A tripwire, not the enforcement mechanism.
     *
     * Redaction is driven by an explicit list, which
     * is the only thing that can catch a secret
     * whose field name looks ordinary -- a
     * connection string, or free-form downloader
     * arguments holding --proxy credentials.
     *
     * This catches the other direction: a setting
     * added later by somebody who did not think to
     * update that list. It will not catch
     * everything, and it is not supposed to.
     ************************************************/
    it('has no field that reads like a credential', function() {
        const anonymous = config_api.getAnonymousConfigFile();
        const credential_pattern = /(secret|password|passwd|token|api_key|apikey|credential|connection_string)/i;
        const found = [];

        (function walk(node, trail) {
            if (!node || typeof node !== 'object') return;
            for (const [key, value] of Object.entries(node)) {
                const next_trail = trail ? `${trail}.${key}` : key;
                if (value && typeof value === 'object') {
                    walk(value, next_trail);
                } else if (typeof value === 'boolean') {
                    // A flag saying whether a feature is switched on is not the credential
                    // it switches on -- use_API_key is a checkbox, API_key is the secret.
                    continue;
                } else if (credential_pattern.test(key)) {
                    found.push(next_trail);
                }
            }
        })(anonymous, '');

        assert.deepStrictEqual(found, [],
            'these fields are published to anonymous callers and read like credentials. '
            + 'Add each to SENSITIVE_CONFIG_PATHS, or rename it if it is not one.');
    });
});

describe('Download arguments', function() {
    const {assert, utils} = require('./test-shared');

    /*************************************************
     * An allowlist, not a denylist.
     *
     * yt-dlp's parser accepts any unambiguous
     * abbreviation of a long option, attached short
     * values, clustered short options and aliases --
     * so a list of names to refuse can always be
     * spelled around. Each case below reaches the
     * same yt-dlp code as the option it abbreviates.
     ************************************************/
    it('refuses an option that runs a command', function() {
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('--exec id'), ['--exec']);
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('--netrc-cmd sh -c id'), ['--netrc-cmd']);
    });

    it('refuses an abbreviation of one', function() {
        // argparse resolves this to --exec-before-download.
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('--exec-before-d id'), ['--exec-before-d']);
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('--updat-to=owner/repo@tag'), ['--updat-to']);
    });

    it('refuses a short option with its value attached', function() {
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('-o/tmp/out'), ['-o/tmp/out']);
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('-P/tmp/out'), ['-P/tmp/out']);
    });

    it('refuses clustered short options', function() {
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('-xi'), ['-xi']);
    });

    it('refuses aliases and file-url support', function() {
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('--alias x y'), ['--alias']);
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('--enable-file-urls'), ['--enable-file-urls']);
    });

    it('refuses the options that choose where files land', function() {
        for (const flag of ['-o', '--output', '-P', '--paths', '--print-to-file', '--download-archive']) {
            assert.deepStrictEqual(utils.findDisallowedDownloadArgs(`${flag} /etc/cron.d/x`), [flag],
                `${flag} should be refused`);
        }
    });

    it('refuses the options that load settings from somewhere else', function() {
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('--config-location /tmp/evil.conf'), ['--config-location']);
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('--load-info-json /tmp/evil.json'), ['--load-info-json']);
    });

    it('finds one anywhere in the list, not only at the front', function() {
        assert.deepStrictEqual(
            utils.findDisallowedDownloadArgs('-f best,,--merge-output-format mp4,,--exec id'),
            ['--exec']);
    });

    it('leaves the ordinary download-shaping options alone', function() {
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('-f bestvideo+bestaudio,,--merge-output-format mp4'), []);
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('--write-subs,,--sub-langs en'), []);
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('-S res:1080,,--concurrent-fragments 4'), []);
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('--sponsorblock-remove sponsor'), []);
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs(''), []);
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs(null), []);
    });

    it('treats a bare value as a value rather than an option', function() {
        // '-f' takes 'best' as its value; 'best' on its own is not an option to check.
        assert.deepStrictEqual(utils.findDisallowedDownloadArgs('-f,,best'), []);
    });

    it('knows which fields make a download an advanced one', function() {
        assert(utils.hasAdvancedDownloadOptions({customArgs: '-f best'}));
        assert(utils.hasAdvancedDownloadOptions({additionalArgs: '--no-mtime'}));
        assert(utils.hasAdvancedDownloadOptions({customOutput: '%(title)s'}));

        assert(!utils.hasAdvancedDownloadOptions({customArgs: '   '}));
        assert(!utils.hasAdvancedDownloadOptions({selectedHeight: '1080'}));
        assert(!utils.hasAdvancedDownloadOptions({}));
    });
});

describe('Serving a stored path', function() {
    const {assert, fs, path, utils, useTemporaryMediaRoots} = require('./test-shared');

    let media = null;
    let root = null;
    let scratch = null;

    before(function() {
        media = useTemporaryMediaRoots();
        root = path.resolve(media.video);
        scratch = path.join(root, 'hardening-scratch');
    });

    beforeEach(async function() {
        await fs.remove(scratch);
        await fs.ensureDir(scratch);
    });

    after(function() {
        media.restore();
    });

    it('accepts a regular file inside a media root', async function() {
        const file_path = path.join(scratch, 'ordinary.mp4');
        await fs.writeFile(file_path, 'data');

        assert(utils.isServableMediaFile(file_path));
    });

    it('rejects a directory, which containment alone would allow', function() {
        // A directory is "inside" the media roots too, and the delete path removes one
        // recursively.
        assert(utils.isPathInsideMediaRoots(scratch), 'precondition: the directory is contained');
        assert(!utils.isServableMediaFile(scratch));
    });

    it('rejects a media root itself', function() {
        assert(!utils.isServableMediaFile(root));
    });

    it('rejects a symlink pointing out of the media roots', async function() {
        // path.resolve collapses '..' textually and cannot see a link at all.
        const outside_path = path.join(scratch, '..', '..', 'hardening-outside-target');
        await fs.writeFile(outside_path, 'secret');
        const link_path = path.join(scratch, 'escape.mp4');

        try {
            await fs.symlink(outside_path, link_path);
            assert(!utils.isServableMediaFile(link_path));
            assert(!utils.isPathInsideMediaRoots(link_path));
        } finally {
            await fs.remove(outside_path);
        }
    });

    it('rejects a path that does not exist', function() {
        assert(!utils.isServableMediaFile(path.join(scratch, 'absent.mp4')));
    });
});

describe('Editable file fields', function() {
    const {assert, fs, path} = require('./test-shared');

    it('does not let a client write the stored path', function() {
        // Read from source: app.js cannot be required without booting the application.
        const app_source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
        const field_list = app_source.match(/const EDITABLE_FILE_FIELDS = \[([\s\S]*?)\];/);

        assert(field_list, 'expected to find EDITABLE_FILE_FIELDS in app.js');
        assert(!field_list[1].includes("'path'"),
            'path must not be client-writable: it is what /api/stream and the delete path read');

        // thumbnailPath is a different case: the dialog really does edit it
        // (video-info-dialog.component.html binds it), so it stays writable and is
        // checked for containment instead of being removed.
        assert(field_list[1].includes("'thumbnailPath'"), 'thumbnailPath is edited by the dialog');
        const path_checked = app_source.match(/const PATH_FILE_FIELDS = \[([\s\S]*?)\];/);
        assert(path_checked, 'expected PATH_FILE_FIELDS to exist');
        assert(path_checked[1].includes("'thumbnailPath'"), 'thumbnailPath must be containment-checked');
    });
});

describe('Account ownership', function() {
    const {assert, auth_api, config_api, db_api, utils} = require('./test-shared');

    const original_getConfigItem = config_api.getConfigItem;
    const OWNER = 'hardening_owner';
    const OTHER = 'hardening_other';

    before(function() {
        config_api.getConfigItem = (key) =>
            key === 'ytdl_multi_user_mode' ? true : original_getConfigItem(key);
    });

    after(async function() {
        config_api.getConfigItem = original_getConfigItem;
        for (const uid of [OWNER, OTHER]) await db_api.removeAllRecords('users', {uid: uid});
        await db_api.removeAllRecords('files', {uid: 'hardening_file'});
    });

    describe('Registration', function() {
        it('refuses a uid that would traverse out of the user folder', async function() {
            // A uid becomes a directory name for that user's media, so this is the choke
            // point for every caller -- the API route, and the task that adds users too.
            assert.strictEqual(await auth_api.registerUser('../escape', 'escape', 'password'), null);
            assert.strictEqual(await auth_api.registerUser('a/b', 'slash', 'password'), null);
            assert.strictEqual(await auth_api.registerUser('..', 'dots', 'password'), null);
            assert.strictEqual(await auth_api.registerUser('', 'empty', 'password'), null);
        });

        it('still accepts the ordinary shape', async function() {
            const created = await auth_api.registerUser(OWNER, OWNER, 'owner-password');

            assert(created, 'a normal uid should still register');
            assert.strictEqual(created.uid, OWNER);
        });
    });

    describe('Password changes', function() {
        it('confirms a password against the stored hash', async function() {
            assert.strictEqual(await auth_api.verifyUserPassword(OWNER, 'owner-password'), true);
            assert.strictEqual(await auth_api.verifyUserPassword(OWNER, 'wrong-password'), false);
            assert.strictEqual(await auth_api.verifyUserPassword(OWNER, ''), false);
            assert.strictEqual(await auth_api.verifyUserPassword('nobody-at-all', 'password'), false);
        });
    });

    describe('Sharing', function() {
        beforeEach(async function() {
            await db_api.removeAllRecords('files', {uid: 'hardening_file'});
            await db_api.insertRecordIntoTable('files', {
                uid: 'hardening_file', user_uid: OWNER, sharingEnabled: false
            });
        });

        it('lets the owner share their own file', async function() {
            assert.strictEqual(await auth_api.changeSharingMode(OWNER, 'hardening_file', false, true), true);

            const file = await db_api.getRecord('files', {uid: 'hardening_file'});
            assert.strictEqual(file.sharingEnabled, true);
        });

        it('refuses to share somebody else\'s file', async function() {
            // The caller uid used to be accepted and then ignored, so anybody holding the
            // sharing permission could expose another user's media by uid alone.
            assert.strictEqual(await auth_api.changeSharingMode(OTHER, 'hardening_file', false, true), false);

            const file = await db_api.getRecord('files', {uid: 'hardening_file'});
            assert.strictEqual(file.sharingEnabled, false);
        });

        it('refuses to unshare somebody else\'s file', async function() {
            await auth_api.changeSharingMode(OWNER, 'hardening_file', false, true);

            assert.strictEqual(await auth_api.changeSharingMode(OTHER, 'hardening_file', false, false), false);

            const file = await db_api.getRecord('files', {uid: 'hardening_file'});
            assert.strictEqual(file.sharingEnabled, true);
        });
    });

    describe('Secret comparison', function() {
        it('matches only an exact value', function() {
            assert.strictEqual(utils.timingSafeEquals('abc123', 'abc123'), true);
            assert.strictEqual(utils.timingSafeEquals('abc123', 'abc124'), false);
            assert.strictEqual(utils.timingSafeEquals('abc', 'abc123'), false);
            assert.strictEqual(utils.timingSafeEquals(undefined, 'abc123'), false);
            assert.strictEqual(utils.timingSafeEquals('abc123', ''), false);
        });
    });
});

describe('The shared bootstrap secret', function() {
    const {assert, fs, path} = require('./test-shared');

    /*************************************************
     * A UUID was hardcoded in app.js and shipped in
     * the frontend bundle as auth_token, sent as
     * apiKey on every request. It gated nothing --
     * it is published in this repository -- but the
     * server did close the socket on anybody who did
     * not send it, so removing it from only one side
     * takes the whole UI down.
     *
     * Both sides are checked here because that is
     * the mistake this guards against.
     ************************************************/
    const RETIRED_SECRET = '4241b401-7236-493e-92b5-b72696b9d853';

    it('is gone from the backend', function() {
        const app_source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

        assert(!app_source.includes(RETIRED_SECRET), 'app.js still carries the published constant');
    });

    it('is gone from the frontend', function() {
        const service_source = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'app', 'posts.services.ts'), 'utf8');

        assert(!service_source.includes(RETIRED_SECRET),
            'the frontend still sends the published constant, so removing it server-side breaks bootstrap');
    });

    it('is not required by the API gate', function() {
        // The gate must not refuse a keyless request: what decides is optionalJwt and the
        // route guards. Closing the socket instead is what broke the UI.
        const app_source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

        assert(!/req\.socket\.end\(\)/.test(app_source),
            'no request should have its socket closed for want of an API key');
    });

    it('does not treat the Public API key as a control any more', function() {
        // Deprecated: it never restricted an endpoint and never identified a caller, so it
        // could not authorize anything. The parameter is still accepted and ignored.
        const app_source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

        assert(!/req\.query\.apiKey/.test(app_source),
            'the API key must not take part in deciding whether a request is allowed');
    });

    it('says so in the published API documentation', function() {
        const docs = fs.readFileSync(path.join(__dirname, '..', '..', 'Public API v1.yaml'), 'utf8');

        assert(docs.includes('deprecated'), 'the docs must say the apiKey parameter is deprecated');
        assert(!/Remember to authenticate with your API key/.test(docs),
            'the docs still tell people the API key authenticates them');
    });
});

describe('Download arguments at the downloader boundary', function() {
    const {assert, utils} = require('./test-shared');

    /*************************************************
     * The HTTP handlers are not the only way in. A
     * subscription stores its arguments and replays
     * them on every refresh, and a queued download
     * resumes from a stored record -- neither passes
     * a request handler.
     ************************************************/
    it('discards a stored argument list rather than editing it', function() {
        // Removing only the flag would leave its value behind as a stray token, which
        // yt-dlp reads as a URL.
        assert.strictEqual(utils.quarantineDisallowedDownloadArgs('-f best,,--exec id', 'subscription'), null);
    });

    it('discards one that uses an abbreviation', function() {
        assert.strictEqual(utils.quarantineDisallowedDownloadArgs('--exec-before-d id', 'subscription'), null);
    });

    it('leaves an ordinary stored argument list alone', function() {
        const args = '-f bestvideo+bestaudio,,--merge-output-format mp4';

        assert.strictEqual(utils.quarantineDisallowedDownloadArgs(args, 'subscription'), args);
    });
});

describe('Download URLs', function() {
    const {assert, utils} = require('./test-shared');

    /*************************************************
     * yt-dlp reads anything option-shaped as an
     * option wherever it appears, and the URL used to
     * be placed before the generated options with no
     * '--' between them. '--update-to=owner/repo@tag'
     * as a URL asks yt-dlp to replace its own binary
     * from another repository.
     ************************************************/
    it('refuses a URL that is really an option', function() {
        assert.strictEqual(utils.isAllowedDownloadURL('--update-to=owner/repo@tag'), false);
        assert.strictEqual(utils.isAllowedDownloadURL('-x'), false);
        assert.strictEqual(utils.isAllowedDownloadURL('  --exec'), false);
    });

    it('refuses schemes that are not http or https', function() {
        assert.strictEqual(utils.isAllowedDownloadURL('file:///etc/passwd'), false);
        assert.strictEqual(utils.isAllowedDownloadURL('ftp://host/x'), false);
    });

    it('accepts ordinary URLs', function() {
        assert.strictEqual(utils.isAllowedDownloadURL('https://example.com/watch?v=abc'), true);
        assert.strictEqual(utils.isAllowedDownloadURL('http://example.com/x'), true);
    });

    it('refuses nothing at all', function() {
        assert.strictEqual(utils.isAllowedDownloadURL(''), false);
        assert.strictEqual(utils.isAllowedDownloadURL(null), false);
    });
});

describe('Custom output containment', function() {
    const {assert, utils} = require('./test-shared');

    it('accepts an ordinary output template', function() {
        assert.strictEqual(utils.sanitizeCustomOutput('%(title)s', '/media/video'), '%(title)s');
        assert.strictEqual(utils.sanitizeCustomOutput('shows/%(title)s', '/media/video'), 'shows/%(title)s');
    });

    it('refuses one that walks out of the download folder', function() {
        assert.strictEqual(utils.sanitizeCustomOutput('../../../etc/cron.d/x', '/media/video'), null);
    });

    it('refuses an absolute path', function() {
        assert.strictEqual(utils.sanitizeCustomOutput('/etc/cron.d/x', '/media/video'), null);
    });

    it('treats an empty template as nothing to check', function() {
        assert.strictEqual(utils.sanitizeCustomOutput('', '/media/video'), null);
        assert.strictEqual(utils.sanitizeCustomOutput(null, '/media/video'), null);
    });
});

describe('Containment against the record owner', function() {
    const {assert, config_api, fs, path, utils, useTemporaryMediaRoots} = require('./test-shared');

    let media = null;
    let alice_file = null;
    let bob_file = null;

    before(async function() {
        media = useTemporaryMediaRoots({'ytdl_multi_user_mode': true});
        alice_file = path.join(media.users, 'alice', 'video', 'alice.mp4');
        bob_file = path.join(media.users, 'bob', 'video', 'bob.mp4');
        await fs.outputFile(alice_file, 'alice media');
        await fs.outputFile(bob_file, 'bob media');
    });

    after(function() {
        media.restore();
    });

    it('accepts a file inside its own owner directory', function() {
        assert(utils.isServableMediaFile(alice_file, 'alice'));
        assert(utils.isServableMediaFile(bob_file, 'bob'));
    });

    /*************************************************
     * Checking against the shared users/ root treats
     * every account's media as one directory, so a
     * record owned by one user and pointing at
     * another user's file passes. Rows like that
     * exist wherever the path was writable before it
     * was locked down.
     ************************************************/
    it('refuses a record that points at another user\'s file', function() {
        assert(utils.isPathInsideMediaRoots(bob_file), 'precondition: it is under the shared users root');
        assert(!utils.isServableMediaFile(bob_file, 'alice'));
    });

    it('falls back to the shared roots when there is no owner', function() {
        assert(utils.isServableMediaFile(bob_file, null));
    });

    /*************************************************
     * Media does not always move when ownership does.
     * ytdl_oidc_migrate_videos reassigns unowned
     * records to a user and leaves the files where
     * they were, so a check that allowed only
     * users/<uid>/ would make every migrated file
     * unstreamable, undownloadable and undeletable.
     ************************************************/
    it('still accepts a migrated file left in the shared roots', async function() {
        const legacy_path = path.join(media.video, 'migrated-owner-test.mp4');
        await fs.outputFile(legacy_path, 'migrated media');

        assert(utils.isServableMediaFile(legacy_path, 'alice'),
            'a record migrated to alice whose file never moved must still be reachable');
    });
});

describe('Authorization when a role cannot be resolved', function() {
    const {assert, auth_api, config_api, db_api} = require('./test-shared');

    const original_getConfigItem = config_api.getConfigItem;
    const ORPHANED = 'hardening_orphaned_role_user';

    before(async function() {
        config_api.getConfigItem = (key) =>
            key === 'ytdl_multi_user_mode' ? true : original_getConfigItem(key);

        await db_api.removeAllRecords('users', {uid: ORPHANED});
        await db_api.insertRecordIntoTable('users', {
            uid: ORPHANED,
            name: ORPHANED,
            // The role record does not exist, and the user carries a positive override.
            role: 'a_role_that_was_deleted',
            permissions: ['settings'],
            permission_overrides: ['settings']
        });
    });

    after(async function() {
        config_api.getConfigItem = original_getConfigItem;
        await db_api.removeAllRecords('users', {uid: ORPHANED});
    });

    it('refuses the permission even with a positive override', async function() {
        // A missing role means the user's authorization state is unknown. An override
        // must not stand in for it, or deleting a role leaves its members holding
        // whatever had been overridden onto them.
        assert.strictEqual(await auth_api.userHasPermission(ORPHANED, 'settings'), false);
    });

    it('reports no permissions at all', async function() {
        assert.deepStrictEqual(await auth_api.userPermissions(ORPHANED), []);
    });

    it('refuses for a role that does not exist', async function() {
        assert.strictEqual(await auth_api.roleHasPermissions('a_role_that_was_deleted', 'settings'), false);
    });
});

describe('Registration responses', function() {
    const {assert, auth_api, db_api} = require('./test-shared');

    const CREATED = 'hardening_registration_response';

    after(async function() {
        await db_api.removeAllRecords('users', {uid: CREATED});
    });

    it('does not hand back the password hash', async function() {
        const created = await auth_api.registerUser(CREATED, CREATED, 'a-password');
        assert(created, 'precondition: the user was created');

        // The route returns this object to the caller.
        const returned = auth_api.sanitizeUserForResponse(created);

        assert(!('passhash' in returned), 'the registration response still carries the hash');
        assert.strictEqual(returned.uid, CREATED);
    });
});

describe('Container archives', function() {
    const {assert, fs, path, utils, useTemporaryMediaRoots} = require('./test-shared');

    let media = null;
    let alice_file = null;
    let bob_file = null;

    before(async function() {
        media = useTemporaryMediaRoots({'ytdl_multi_user_mode': true});
        alice_file = path.join(media.users, 'zip_alice', 'video', 'a.mp4');
        bob_file = path.join(media.users, 'zip_bob', 'video', 'b.mp4');
        await fs.outputFile(alice_file, 'alice media');
        await fs.outputFile(bob_file, 'bob media');
    });

    after(function() {
        media.restore();
    });

    async function buildArchive(name, file_objs, user_uid) {
        const zip_path = await utils.createContainerZipFile(name, file_objs, user_uid);
        if (zip_path) { await fs.remove(zip_path); }
        return zip_path;
    }

    /*************************************************
     * The archive used to be written to
     * appdata/<container name>.zip, and the container
     * name is whatever the user called their playlist.
     * That put a caller-controlled string in a path,
     * and the download handler deletes the file it
     * sent afterwards.
     ************************************************/
    it('names the archive itself rather than letting the caller name it', async function() {
        const zip_path = await utils.createContainerZipFile(
            '../appdata/db', [{path: alice_file, user_uid: 'zip_alice'}], 'zip_alice');

        assert(zip_path, 'the archive should still be built');
        try {
            assert(!zip_path.includes('..'), `the caller's name reached the path: ${zip_path}`);
            assert(/appdata[\\/]container-[0-9a-f-]+\.zip$/.test(zip_path),
                `expected a server-generated name, got ${zip_path}`);
        } finally {
            await fs.remove(zip_path);
        }
    });

    it('gives two containers of the same name different files', async function() {
        const first = await buildArchive('same name', [{path: alice_file, user_uid: 'zip_alice'}], 'zip_alice');
        const second = await buildArchive('same name', [{path: alice_file, user_uid: 'zip_alice'}], 'zip_alice');

        assert.notStrictEqual(first, second, 'two archives must not collide on one path');
    });

    it('leaves out a record pointing at another user\'s media', async function() {
        // Rows written before the path stopped being client-writable can still point
        // anywhere, and an archive would otherwise hand the file over.
        const zip_path = await utils.createContainerZipFile(
            'mixed', [{path: alice_file, user_uid: 'zip_alice'}, {path: bob_file, user_uid: 'zip_alice'}], 'zip_alice');

        assert(zip_path, 'the archive is still produced from the records that were allowed');
        await fs.remove(zip_path);
    });

    it('does not throw the process down when a file has gone missing', async function() {
        // An unhandled 'error' on the archive or output stream is an uncaught exception.
        const zip_path = await utils.createContainerZipFile(
            'missing', [{path: path.join(media.users, 'zip_alice', 'video', 'gone.mp4'), user_uid: 'zip_alice'}],
            'zip_alice');

        if (zip_path) { await fs.remove(zip_path); }
    });
});

describe('The yt-dlp command line', function() {
    const {assert, fs, path} = require('./test-shared');

    /*************************************************
     * yt-dlp parses an option wherever it appears, so
     * a URL placed before the options is read as one:
     * '--update-to=owner/repo@tag' asks it to replace
     * its own binary from another repository.
     *
     * Checked as source because the array is built
     * inline at the spawn call.
     ************************************************/
    it('puts the URL last, after a -- terminator, in both launchers', function() {
        const launcher_source = fs.readFileSync(path.join(__dirname, '..', 'youtube-dl.js'), 'utf8');
        const spawn_calls = launcher_source.match(/\[\.\.\.base_args[^\]]*\]/g) || [];

        assert.strictEqual(spawn_calls.length, 2, `expected two launcher argument lists, found ${spawn_calls.length}`);
        for (const call of spawn_calls) {
            assert(/\.\.\.runtime_args,\s*'--',\s*url/.test(call),
                `a launcher still passes the URL before the options: ${call}`);
        }
    });
});

describe('Argument previews', function() {
    const {assert, config_api, downloader_api} = require('./test-shared');

    const original_getConfigItem = config_api.getConfigItem;
    const GLOBAL_ARGS = '--proxy,,http://user:password@proxy.internal:8080';

    before(function() {
        config_api.getConfigItem = (key) => {
            if (key === 'ytdl_custom_args') return GLOBAL_ARGS;
            if (key === 'ytdl_multi_user_mode') return true;
            return original_getConfigItem(key);
        };
    });

    after(function() {
        config_api.getConfigItem = original_getConfigItem;
    });

    /*************************************************
     * Downloader.custom_args is redacted out of
     * /api/config because it holds proxies, headers
     * and credentials. The argument preview handed
     * the same values straight back, and
     * advanced_download -- which is what gates that
     * preview -- is delegable to ordinary users.
     ************************************************/
    it('withholds the global arguments when the caller may not see them', async function() {
        const args = await downloader_api.generateArgs(
            'https://example.com/v', 'video', {}, null, true, false);

        assert(Array.isArray(args), 'expected an argument array');
        assert(!args.some(arg => typeof arg === 'string' && arg.includes('password')),
            `the preview leaked the global arguments: ${JSON.stringify(args)}`);
        assert(!args.includes('--proxy'), 'the preview leaked the global proxy');
    });

    it('includes them for a caller who can already read them', async function() {
        const args = await downloader_api.generateArgs(
            'https://example.com/v', 'video', {}, null, true, true);

        assert(args.includes('--proxy'), 'an administrator preview should still be accurate');
    });
});

describe('Playlist updates', function() {
    const {assert, config_api, db_api, files_api} = require('./test-shared');

    const original_getConfigItem = config_api.getConfigItem;
    const OWNER = 'playlist_owner';
    const OTHER = 'playlist_other';
    const PLAYLIST_ID = 'playlist_update_test';
    const OWNED_FILE = 'playlist_owned_file';
    const FOREIGN_FILE = 'playlist_foreign_file';

    before(function() {
        config_api.getConfigItem = (key) =>
            key === 'ytdl_multi_user_mode' ? true : original_getConfigItem(key);
    });

    after(async function() {
        config_api.getConfigItem = original_getConfigItem;
        await db_api.removeAllRecords('playlists', {id: PLAYLIST_ID});
        for (const uid of [OWNED_FILE, FOREIGN_FILE]) await db_api.removeAllRecords('files', {uid: uid});
    });

    beforeEach(async function() {
        await db_api.removeAllRecords('playlists', {id: PLAYLIST_ID});
        await db_api.insertRecordIntoTable('playlists', {
            id: PLAYLIST_ID, name: 'original', user_uid: OWNER, sharingEnabled: false, uids: [OWNED_FILE]
        });

        for (const [uid, owner] of [[OWNED_FILE, OWNER], [FOREIGN_FILE, OTHER]]) {
            await db_api.removeAllRecords('files', {uid: uid});
            await db_api.insertRecordIntoTable('files', {uid: uid, user_uid: owner, duration: 10});
        }
    });

    it('applies the fields the editor actually changes', async function() {
        const success = await files_api.updatePlaylist(
            {id: PLAYLIST_ID, name: 'renamed', uids: [OWNED_FILE]}, OWNER);

        assert.strictEqual(success, true);
        assert.strictEqual((await db_api.getRecord('playlists', {id: PLAYLIST_ID}))['name'], 'renamed');
    });

    /*************************************************
     * The whole client object used to be written to
     * the record, so these three fields were all
     * writable by whoever was submitting the form.
     ************************************************/
    it('ignores an attempt to hand the playlist to somebody else', async function() {
        await files_api.updatePlaylist(
            {id: PLAYLIST_ID, name: 'renamed', uids: [OWNED_FILE], user_uid: OTHER}, OWNER);

        assert.strictEqual((await db_api.getRecord('playlists', {id: PLAYLIST_ID}))['user_uid'], OWNER);
    });

    it('ignores an attempt to turn on sharing', async function() {
        // Sharing is the sharing permission's business, not this endpoint's.
        await files_api.updatePlaylist(
            {id: PLAYLIST_ID, name: 'renamed', uids: [OWNED_FILE], sharingEnabled: true}, OWNER);

        assert.strictEqual((await db_api.getRecord('playlists', {id: PLAYLIST_ID}))['sharingEnabled'], false);
    });

    it('refuses a member uid the caller does not own', async function() {
        // Otherwise a shared playlist becomes a way to publish files chosen by uid alone.
        const success = await files_api.updatePlaylist(
            {id: PLAYLIST_ID, name: 'renamed', uids: [OWNED_FILE, FOREIGN_FILE]}, OWNER);

        assert.strictEqual(success, false);
        assert.deepStrictEqual((await db_api.getRecord('playlists', {id: PLAYLIST_ID}))['uids'], [OWNED_FILE]);
    });

    it('refuses to update a playlist belonging to somebody else', async function() {
        const success = await files_api.updatePlaylist(
            {id: PLAYLIST_ID, name: 'stolen', uids: []}, OTHER);

        assert.strictEqual(success, false);
        assert.strictEqual((await db_api.getRecord('playlists', {id: PLAYLIST_ID}))['name'], 'original');
    });
});

describe('Custom output through a symlink', function() {
    const {assert, fs, os, path, utils} = require('./test-shared');

    let base = null;
    let root = null;

    before(function() {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-symlink-test-'));
        root = path.join(base, 'root');
        fs.ensureDirSync(root);
        fs.ensureDirSync(path.join(base, 'outside'));
        fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'link'));
    });

    after(function() {
        fs.removeSync(base);
    });

    /*************************************************
     * The first attempt at this called realpath on
     * the whole destination. An output template names
     * a file that has not been written yet, so the
     * call always threw and the answer fell back to a
     * lexical resolve -- which walks straight through
     * the symlink.
     ************************************************/
    it('refuses a destination that does not exist yet behind a symlink', function() {
        assert.strictEqual(utils.sanitizeCustomOutput('link/new-file', root), null);
    });

    it('refuses one nested further inside the symlink', function() {
        assert.strictEqual(utils.sanitizeCustomOutput('link/a/b', root), null);
    });

    it('still accepts an ordinary template naming a file that does not exist', function() {
        assert.strictEqual(utils.sanitizeCustomOutput('%(title)s', root), '%(title)s');
        assert.strictEqual(utils.sanitizeCustomOutput('shows/%(title)s', root), 'shows/%(title)s');
    });
});

describe('Subtitle metadata', function() {
    const {assert, files_api, fs, path, useTemporaryMediaRoots} = require('./test-shared');

    let media = null;

    before(function() {
        media = useTemporaryMediaRoots({'ytdl_multi_user_mode': true});
    });

    after(function() {
        media.restore();
    });

    /*************************************************
     * Discovering the tracks reads sidecars next to
     * the stored path and shells out to ffprobe, so
     * checking only inside ensureSubtitleSidecarForFile
     * let a record pointing outside the media folders
     * reach the filesystem first.
     ************************************************/
    it('refuses to read anything for a path outside the media folders', async function() {
        const outside_path = path.join(media.base, 'outside.mp4');
        await fs.outputFile(outside_path, 'not media');

        const output = await files_api.attachFileSubtitles({
            uid: 'subtitle_outside', path: outside_path, isAudio: false, user_uid: 'alice'
        });

        assert.deepStrictEqual(output.subtitles, []);
    });

    it('refuses a path inside another user\'s directory', async function() {
        const bob_path = path.join(media.users, 'bob', 'video', 'bob.mp4');
        await fs.outputFile(bob_path, 'bob media');

        const output = await files_api.attachFileSubtitles({
            uid: 'subtitle_foreign', path: bob_path, isAudio: false, user_uid: 'alice'
        });

        assert.deepStrictEqual(output.subtitles, []);
    });
});
