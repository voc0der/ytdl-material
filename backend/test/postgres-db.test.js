/* eslint-disable no-undef */
const os = require('os');
const postgres_store = require('../postgres-store');
const { assert, db_api, config_api, fs, path } = require('./test-shared');

describe('PostgreSQL backend integration points', function() {
    let originalConfigFile = null;
    let originalPostgresStoreFns = null;

    beforeEach(function() {
        originalConfigFile = JSON.parse(JSON.stringify(config_api.getConfigFile()));
        originalPostgresStoreFns = {
            createConnection: postgres_store.createConnection,
            closeConnection: postgres_store.closeConnection,
            insertRecord: postgres_store.insertRecord,
            getRecord: postgres_store.getRecord,
            getRecords: postgres_store.getRecords,
            updateRecord: postgres_store.updateRecord,
            removeRecord: postgres_store.removeRecord,
            getTableStats: postgres_store.getTableStats,
            hasAnyRecords: postgres_store.hasAnyRecords,
            readAllTables: postgres_store.readAllTables,
            replaceAllTables: postgres_store.replaceAllTables
        };
    });

    afterEach(async function() {
        Object.assign(postgres_store, originalPostgresStoreFns);
        config_api.setConfigFile(originalConfigFile);
        db_api.setLocalDBMode(!!config_api.getConfigItem('ytdl_use_local_db'));
    });

    function configurePostgresRemote() {
        config_api.setConfigItem('ytdl_use_local_db', false);
        config_api.setConfigItem('ytdl_remote_db_type', 'postgres');
        config_api.setConfigItem('ytdl_postgresdb_connection_string', 'postgresql://user:pass@db.example:5432/ytdl-material');
    }

    it('parses PostgreSQL SSL connection settings from the connection string', function() {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-pg-'));
        const caPath = path.join(tempDir, 'ca.crt');
        fs.writeFileSync(caPath, 'test-ca');

        const config = db_api.parsePostgresConnectionConfig(`postgresql://user:pass@db.example:5432/ytdl-material?sslmode=verify-ca&sslrootcert=${caPath}`);

        assert.strictEqual(config.connectionString, 'postgresql://user:pass@db.example:5432/ytdl-material');
        assert(config.ssl);
        assert.strictEqual(config.ssl.ca, 'test-ca');
        assert.strictEqual(config.ssl.rejectUnauthorized, true);
        assert.strictEqual(typeof config.ssl.checkServerIdentity, 'function');

        fs.removeSync(tempDir);
    });

    it('connectToDB selects PostgreSQL when configured', async function() {
        configurePostgresRemote();

        const fakePool = { query: async () => ({ rows: [] }) };
        let capturedConnectionString = null;
        postgres_store.createConnection = async (connectionString) => {
            capturedConnectionString = connectionString;
            return fakePool;
        };
        postgres_store.closeConnection = async () => {};

        const success = await db_api.connectToDB(0, true);

        assert.strictEqual(success, true);
        assert.strictEqual(capturedConnectionString, 'postgresql://user:pass@db.example:5432/ytdl-material');
        assert.strictEqual(db_api.getActiveDBType(), 'postgres');
        assert.strictEqual(db_api.isUsingPostgresDB(), true);
    });

    it('delegates CRUD and stats calls to the PostgreSQL store', async function() {
        configurePostgresRemote();

        const fakePool = { query: async () => ({ rows: [] }) };
        const calls = [];

        postgres_store.createConnection = async () => fakePool;
        postgres_store.closeConnection = async () => {};
        postgres_store.insertRecord = async (...args) => {
            calls.push({ name: 'insertRecord', args });
            return true;
        };
        postgres_store.getRecord = async (...args) => {
            calls.push({ name: 'getRecord', args });
            return { uid: 'pg-1' };
        };
        postgres_store.getRecords = async (...args) => {
            calls.push({ name: 'getRecords', args });
            return [{ uid: 'pg-1' }];
        };
        postgres_store.updateRecord = async (...args) => {
            calls.push({ name: 'updateRecord', args });
            return true;
        };
        postgres_store.removeRecord = async (...args) => {
            calls.push({ name: 'removeRecord', args });
            return true;
        };
        postgres_store.getTableStats = async (...args) => {
            calls.push({ name: 'getTableStats', args });
            return { records_count: 7 };
        };

        await db_api.connectToDB(0, true);
        await db_api.insertRecordIntoTable('test', { uid: 'pg-1' });
        const record = await db_api.getRecord('test', { uid: 'pg-1' });
        const records = await db_api.getRecords('test');
        const updated = await db_api.updateRecord('test', { uid: 'pg-1' }, { added_field: true });
        const removed = await db_api.removeRecord('test', { uid: 'pg-1' });
        const stats = await db_api.getDBStats();

        assert(record && record.uid === 'pg-1');
        assert(Array.isArray(records) && records.length === 1);
        assert.strictEqual(updated, true);
        assert.strictEqual(removed, true);
        assert.strictEqual(stats.current_db_label, 'PostgreSQL');
        assert.strictEqual(stats.configured_remote_db_label, 'PostgreSQL');
        assert.strictEqual(stats.stats_by_table.files.records_count, 7);
        assert(calls.some(call => call.name === 'insertRecord'));
        assert(calls.some(call => call.name === 'getRecord'));
        assert(calls.some(call => call.name === 'getRecords'));
        assert(calls.some(call => call.name === 'updateRecord'));
        assert(calls.some(call => call.name === 'removeRecord'));
        assert(calls.some(call => call.name === 'getTableStats'));
    });

    it('requires local DB mode to be disabled before DB-to-DB migration', async function() {
        config_api.setConfigItem('ytdl_use_local_db', true);
        config_api.setConfigItem('ytdl_db_migrate', 'postgres');

        await assert.rejects(
            async () => await db_api.runConfiguredDBMigration(),
            /ytdl_db_migrate requires ytdl_use_local_db to be false/
        );
    });

    it('requires both remote connection strings before DB-to-DB migration', async function() {
        config_api.setConfigItem('ytdl_use_local_db', false);
        config_api.setConfigItem('ytdl_db_migrate', 'postgres');
        config_api.setConfigItem('ytdl_mongodb_connection_string', '');
        config_api.setConfigItem('ytdl_postgresdb_connection_string', 'postgresql://user:pass@db.example:5432/ytdl-material');

        await assert.rejects(
            async () => await db_api.runConfiguredDBMigration(),
            /requires both ytdl_mongodb_connection_string and ytdl_postgresdb_connection_string/
        );
    });

    it('refuses DB-to-DB migration when the target PostgreSQL database already has records', async function() {
        config_api.setConfigItem('ytdl_use_local_db', false);
        config_api.setConfigItem('ytdl_db_migrate', 'postgres');
        config_api.setConfigItem('ytdl_mongodb_connection_string', 'mongodb://mongo.example:27017/ytdl_material');
        config_api.setConfigItem('ytdl_postgresdb_connection_string', 'postgresql://user:pass@db.example:5432/ytdl-material');

        const fakePool = { id: 'target' };
        let createConnectionCalls = 0;
        let readAllTablesCalled = false;
        let replaceAllTablesCalled = false;

        postgres_store.createConnection = async (connectionString, tables, options = {}) => {
            createConnectionCalls += 1;
            assert.strictEqual(connectionString, 'postgresql://user:pass@db.example:5432/ytdl-material');
            assert.deepStrictEqual(options, { testOnly: true });
            return fakePool;
        };
        postgres_store.closeConnection = async (pool) => {
            assert.strictEqual(pool, fakePool);
        };
        postgres_store.hasAnyRecords = async (pool) => {
            assert.strictEqual(pool, fakePool);
            return true;
        };
        postgres_store.readAllTables = async () => {
            readAllTablesCalled = true;
            return {};
        };
        postgres_store.replaceAllTables = async () => {
            replaceAllTablesCalled = true;
            return true;
        };

        await assert.rejects(
            async () => await db_api.runConfiguredDBMigration(),
            /target PostgreSQL database already contains data/
        );

        assert.strictEqual(createConnectionCalls, 1);
        assert.strictEqual(readAllTablesCalled, false);
        assert.strictEqual(replaceAllTablesCalled, false);
    });

    it('migrates records between remote stores through the shared migration helper', async function() {
        const sourcePool = { id: 'source' };
        const targetPool = { id: 'target' };
        const snapshot = {
            files: [{ uid: 'file-1' }],
            playlists: [],
            categories: [],
            subscriptions: [],
            downloads: [],
            users: [],
            roles: [],
            download_queue: [],
            tasks: [],
            notifications: [],
            archives: [],
            test: [{ uid: 'test-1' }]
        };
        const createCalls = [];
        const closeCalls = [];
        let replaceArgs = null;

        postgres_store.createConnection = async (connectionString) => {
            createCalls.push(connectionString);
            return connectionString.includes('source') ? sourcePool : targetPool;
        };
        postgres_store.closeConnection = async (pool) => {
            closeCalls.push(pool.id);
        };
        postgres_store.readAllTables = async (pool) => {
            assert.strictEqual(pool, sourcePool);
            return snapshot;
        };
        postgres_store.replaceAllTables = async (pool, tables, records) => {
            replaceArgs = { pool, tables, records };
            return true;
        };

        const success = await db_api._migrateRemoteDB(
            'postgres',
            'postgres',
            'postgresql://source-db',
            'postgresql://target-db'
        );

        assert.strictEqual(success, true);
        assert.deepStrictEqual(createCalls, ['postgresql://source-db', 'postgresql://target-db']);
        assert.deepStrictEqual(closeCalls, ['source', 'target']);
        assert.strictEqual(replaceArgs.pool, targetPool);
        assert.deepStrictEqual(replaceArgs.records, snapshot);
        assert(replaceArgs.tables.files);
    });
});
