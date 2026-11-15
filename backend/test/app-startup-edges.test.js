const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const { createAppHarness } = require('./helpers/app-harness');
const { createRouteHarness } = require('./helpers/app-routes');
const { startApp } = require('./helpers/app-process');

// Startup as it goes when something is off: migrations that fail, settings that do not add up,
// and the pieces of the server a default install leaves switched off.
describe('Server startup edges', function() {
    describe('in the server\'s own code', function() {
        let harness;
        afterEach(function() { if (harness) harness.close(); harness = null; });
        const logged = level => harness.messages.filter(([message_level]) => message_level === level).map(([, message]) => String(message));
        const config_with = (values, extra = {}) => ({ ...require('../config'), initialize() {}, configExistsCheck() {},
            getConfigItem: key => values[key], setConfigItem: () => true, ...extra });

        it('says which migrations failed, and marks them done so they are not tried on every start', async function() {
            const written = [];
            class OldDatabase {
                constructor(file) { this.file = file; }
                // What an install from before 4.2 kept in db.json.
                read() { return this.file.endsWith('db.json') ? { files: { video: [{ uid: 'old' }], audio: [] }, playlists: { video: [], audio: [] } } : { users: [] }; }
                write(data) { written.push([this.file, data]); return data; }
            }
            harness = createAppHarness({ dependencies: {
                './lowdb-compat/adapters/FileSync': OldDatabase,
                'fs-extra': { ...fs, existsSync: () => false, readJSONSync: () => ({}), writeJSONSync() {} },
                './files': { addMetadataPropertyToDB: async () => false },
                './db': { initialize() {}, hasLibraryRecords: async () => false, importJSONToDB: async () => false },
                './tasks': { setupTasks: async () => {} },
                './authentication/auth': { ...require('../authentication/auth'), initialize() {}, changeRolePermissions: async () => false },
                './archive': { importArchives: async () => false }
            }});

            assert.strictEqual(await harness.context.checkMigrations(), true);

            assert.deepStrictEqual(logged('error'), ['Migration failed: 4.1->4.2+', 'Migration failed: 4.2->4.3+',
                'Failed to auto add tasks manager permissions to admin role!', 'Failed to migrate archives!']);
            const flags = written.filter(([file]) => file.endsWith('db.json')).at(-1)[1];
            for (const flag of ['simplified_db_migration_complete', 'new_db_system_migration_complete', 'tasks_manager_role_migration_complete',
                'archives_migration_complete']) {
                assert.strictEqual(flags[flag], true, flag);
            }
        });

        it('stops startup when the files or playlists nobody owns cannot be given to the user named', async function() {
            const failing = new Set(['files']);
            harness = createAppHarness({ env: { ytdl_oidc_migrate_videos: 'alice' }, dependencies: { './db': { initialize() {},
                getRecord: async () => ({ uid: 'alice' }),
                getRecords: async table => table === 'files' ? 2 : 1,
                updateRecords: async table => !failing.has(table)
            } } });

            await assert.rejects(harness.context.migrateUnassignedVideosToConfiguredUser(), { message: 'Failed to migrate unassigned videos/files to user \'alice\'.' });
            failing.clear();
            failing.add('playlists');
            await assert.rejects(harness.context.migrateUnassignedVideosToConfiguredUser(), { message: 'Failed to migrate unassigned playlists to user \'alice\'.' });
        });

        it('says so when the settings in the environment cannot be saved', async function() {
            harness = createAppHarness({ env: { ytdl_port: '8998' }, dependencies: {
                './config.js': config_with({ ytdl_multi_user_mode: false, ytdl_reverse_proxy_whitelist: '' }, { setConfigItems: () => false })
            } });
            assert.strictEqual(await harness.context.setConfigFromEnv(), false);
            assert.deepStrictEqual(logged('error'), ['ERROR: Failed to set config items using ENV variables.']);
        });

        it('trusts the proxy named in the environment, by name', function() {
            harness = createAppHarness({ env: { ytdl_trust_proxy: ' loopback ' } });
            harness.context.configureExpressTrustProxy();
            assert(logged('info').includes('Express trust proxy configured from ytdl_trust_proxy: "loopback"'));
        });

        it('uses another downloading agent when one it knows is chosen', function() {
            harness = createAppHarness({ config: { ytdl_use_default_downloading_agent: false, ytdl_custom_downloading_agent: 'aria2c',
                ytdl_url: 'http://localhost', ytdl_logger_level: 'info' } });
            harness.context.loadConfigValues();
            assert(logged('info').includes('Using non-default downloading agent \'aria2c\''));
        });

        it('falls back from an address that cannot be read at all', function() {
            harness = createAppHarness();
            assert.strictEqual(harness.context.parseServerURL('my server').href, 'http://example.com/');
            assert(logged('warn').includes('The configured URL \'my server\' is not a web address, so http://example.com is used instead.'));
        });

        it('leaves the API reference off when its description is missing', async function() {
            harness = createRouteHarness({ config: { ytdl_enable_documentation_api: true } });
            harness.context.initializeDocumentationAPI();
            assert.match(logged('error')[0], /^Documentation API startup failed: OpenAPI spec not found\./);
            assert.strictEqual((await harness.request('get', '/openapi.yaml')).res.statusCode, 404);
        });
    });

    describe('as it runs', function() {
        this.timeout(60000);

        for (const [situation, env, message] of [
            ['with single sign-on and no accounts', { ytdl_oidc_enabled: 'true' }, /OIDC startup failed: multi-user mode must be enabled when OIDC is enabled\./],
            ['with single sign-on that is not set up', { ytdl_oidc_enabled: 'true', ytdl_multi_user_mode: 'true' },
                /OIDC startup failed: OIDC is enabled but one or more required settings are missing/]
        ]) {
            it(`does not start ${situation}`, async function() {
                await assert.rejects(startApp({ env }), error => {
                    assert.match(error.message, /exited during startup \(code 1/);
                    assert.match(error.message, message);
                    return true;
                });
            });
        }

        it('starts on MongoDB when the settings say so, with what the local store held', async function() {
            const app = await startApp({
                env: { ytdl_use_local_db: 'false', ytdl_remote_db_type: 'mongo', ytdl_mongodb_connection_string: 'mongodb://fake-mongo.test:27017/ytdl_material' },
                preload: path.join(__dirname, 'helpers', 'fake-mongo-server.js'),
                prepare: ({ root }) => fs.outputJSON(path.join(root, 'appdata', 'local_db.json'), { files: [{ uid: 'kept', title: 'Kept', isAudio: false, registered: 1 }] })
            });
            try {
                const info = (await app.api.get('/api/getDBInfo').expect(200)).body;
                assert.strictEqual(info.current_db_label, 'MongoDB');
                const files = (await app.api.post('/api/getAllFiles').send({}).expect(200)).body.files;
                assert.deepStrictEqual(files.map(file => file.uid), ['kept']);
            } finally {
                await app.stop();
            }
        });

        describe('with the defaults', function() {
            let app;
            before(async function() { app = await startApp(); });
            after(async function() { if (app) await app.stop(); });

            it('keeps the API reference switched off', async function() {
                await app.api.get('/docs').expect(404);
                await app.api.get('/openapi.yaml').expect(404);
            });

            it('serves the app\'s pages only to a browser, and leaves a file request to the files', async function() {
                await app.api.get('/settings').set('Accept', 'application/json').expect(404);
                await app.api.get('/settings;page.js').set('Accept', 'text/html').expect(404);
            });
        });
    });
});
