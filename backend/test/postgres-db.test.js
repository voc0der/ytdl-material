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
        db_api.resetMongoClientCtor();
        db_api.setLocalDBMode(!!config_api.getConfigItem('ytdl_use_local_db'));
    });

    function configurePostgresRemote() {
        config_api.setConfigItem('ytdl_use_local_db', false);
        config_api.setConfigItem('ytdl_remote_db_type', 'postgres');
        config_api.setConfigItem('ytdl_postgresdb_connection_string', 'postgresql://user:pass@db.example:5432/ytdl-material');
    }

    function createFakeMongoClientCtor(options = {}) {
        const databaseName = options.databaseName || 'ytdl_material';
        const clone = value => JSON.parse(JSON.stringify(value));

        class FakeMongoDatabase {
            constructor(initialCollections = {}, behavior = {}) {
                this.collections = new Map();
                this.behavior = behavior;
                Object.entries(initialCollections).forEach(([collectionName, docs]) => {
                    this.collections.set(collectionName, { docs: clone(docs), indexes: [] });
                });
            }

            listCollections(filter = {}) {
                const rows = [...this.collections.keys()]
                    .filter(collectionName => !filter.name || collectionName === filter.name)
                    .map(collectionName => ({ name: collectionName }));
                return { toArray: async () => rows };
            }

            async createCollection(collectionName) {
                if (!this.collections.has(collectionName)) {
                    this.collections.set(collectionName, { docs: [], indexes: [] });
                }
            }

            collection(collectionName) {
                const database = this;
                return {
                    createIndex: async (keys, indexOptions = {}) => {
                        const collection = database.ensureCollection(collectionName);
                        collection.indexes.push({ keys, options: indexOptions });
                        return true;
                    },
                    insertMany: async (docs = []) => {
                        const collection = database.ensureCollection(collectionName);
                        collection.docs.push(...clone(docs));
                        return { acknowledged: true };
                    },
                    rename: async (nextCollectionName, renameOptions = {}) => {
                        if (database.shouldFailRename(collectionName, nextCollectionName)) {
                            throw new Error(`rename failed: ${collectionName} -> ${nextCollectionName}`);
                        }

                        const collection = database.collections.get(collectionName);
                        if (!collection) {
                            throw new Error(`missing collection: ${collectionName}`);
                        }

                        if (renameOptions.dropTarget && database.collections.has(nextCollectionName)) {
                            database.collections.delete(nextCollectionName);
                        }

                        database.collections.delete(collectionName);
                        database.collections.set(nextCollectionName, collection);
                        return database.collection(nextCollectionName);
                    },
                    drop: async () => {
                        if (!database.collections.has(collectionName)) {
                            const error = new Error('ns not found');
                            error.codeName = 'NamespaceNotFound';
                            throw error;
                        }

                        database.collections.delete(collectionName);
                        return true;
                    },
                    findOne: async () => {
                        const collection = database.collections.get(collectionName);
                        return collection && collection.docs.length > 0 ? clone(collection.docs[0]) : null;
                    },
                    find: () => ({
                        toArray: async () => clone((database.collections.get(collectionName) || { docs: [] }).docs)
                    })
                };
            }

            ensureCollection(collectionName) {
                if (!this.collections.has(collectionName)) {
                    this.collections.set(collectionName, { docs: [], indexes: [] });
                }
                return this.collections.get(collectionName);
            }

            shouldFailRename(currentCollectionName, nextCollectionName) {
                return typeof this.behavior.renameFailure === 'function'
                    ? this.behavior.renameFailure(currentCollectionName, nextCollectionName)
                    : false;
            }

            snapshot(collectionName) {
                return clone((this.collections.get(collectionName) || { docs: [] }).docs);
            }

            collectionNames() {
                return [...this.collections.keys()].sort();
            }
        }

        const databases = new Map(Object.entries(options.collectionsByConnectionString || {}).map(([connectionString, collections]) => {
            return [connectionString, new FakeMongoDatabase(collections, options)];
        }));

        class FakeMongoClient {
            constructor(connectionString) {
                this.connectionString = connectionString;
                if (!databases.has(connectionString)) {
                    databases.set(connectionString, new FakeMongoDatabase({}, options));
                }
            }

            async connect() {}

            db(name) {
                assert.strictEqual(name, databaseName);
                return databases.get(this.connectionString);
            }

            async close() {}
        }

        return { FakeMongoClient, databases };
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

    it('persists the migration target and clears ytdl_db_migrate after a successful migration', async function() {
        config_api.setConfigItem('ytdl_use_local_db', false);
        config_api.setConfigItem('ytdl_remote_db_type', 'mongo');
        config_api.setConfigItem('ytdl_db_migrate', 'postgres');
        config_api.setConfigItem('ytdl_mongodb_connection_string', 'mongodb://source-db');
        config_api.setConfigItem('ytdl_postgresdb_connection_string', 'postgresql://target-db');

        const { FakeMongoClient } = createFakeMongoClientCtor({
            collectionsByConnectionString: {
                'mongodb://source-db': {
                    files: [{ uid: 'mongo-file-1' }]
                }
            }
        });
        db_api.setMongoClientCtor(FakeMongoClient);

        const fakeTargetPool = { id: 'target' };
        let replacedRecords = null;
        postgres_store.createConnection = async () => fakeTargetPool;
        postgres_store.closeConnection = async () => {};
        postgres_store.hasAnyRecords = async () => false;
        postgres_store.replaceAllTables = async (pool, tables, records) => {
            assert.strictEqual(pool, fakeTargetPool);
            replacedRecords = records;
            return true;
        };

        const success = await db_api.runConfiguredDBMigration();

        assert.strictEqual(success, true);
        assert.deepStrictEqual(replacedRecords.files, [{ uid: 'mongo-file-1' }]);
        assert.strictEqual(config_api.getConfigItem('ytdl_remote_db_type'), 'postgres');
        assert.strictEqual(config_api.getConfigItem('ytdl_db_migrate'), '');
    });

    it('bootstraps an empty remote PostgreSQL database from local DB data', async function() {
        db_api.setLocalDBMode(true);
        await db_api.removeAllRecords('test');
        await db_api.insertRecordIntoTable('test', { uid: 'local-test-record', key: 'local-key' });

        config_api.setConfigItem('ytdl_use_local_db', false);
        config_api.setConfigItem('ytdl_remote_db_type', 'postgres');
        config_api.setConfigItem('ytdl_postgresdb_connection_string', 'postgresql://bootstrap-target');
        config_api.setConfigItem('ytdl_db_migrate', '');
        db_api.setLocalDBMode(false);

        const fakeTargetPool = { id: 'bootstrap-target' };
        let replaceArgs = null;
        postgres_store.createConnection = async () => fakeTargetPool;
        postgres_store.closeConnection = async () => {};
        postgres_store.hasAnyRecords = async () => false;
        postgres_store.replaceAllTables = async (pool, tables, records) => {
            replaceArgs = { pool, tables, records };
            return true;
        };

        const bootstrapped = await db_api.bootstrapRemoteDBFromLocalIfNeeded();

        assert.strictEqual(bootstrapped, true);
        assert.strictEqual(replaceArgs.pool, fakeTargetPool);
        assert.deepStrictEqual(replaceArgs.records.test, [{ uid: 'local-test-record', key: 'local-key' }]);
    });

    it('rolls back MongoDB destination changes when a staged swap fails', async function() {
        const sourcePool = { id: 'source' };
        const { FakeMongoClient, databases } = createFakeMongoClientCtor({
            collectionsByConnectionString: {
                'mongodb://target-db': {
                    files: [{ uid: 'existing-file' }],
                    playlists: [{ id: 'existing-playlist' }]
                }
            },
            renameFailure: (currentCollectionName, nextCollectionName) => currentCollectionName.startsWith('playlists__incoming_') && nextCollectionName === 'playlists'
        });
        db_api.setMongoClientCtor(FakeMongoClient);

        postgres_store.createConnection = async () => sourcePool;
        postgres_store.closeConnection = async () => {};
        postgres_store.readAllTables = async () => ({
            files: [{ uid: 'new-file' }],
            playlists: [{ id: 'new-playlist' }],
            categories: [],
            subscriptions: [],
            downloads: [],
            users: [],
            roles: [],
            download_queue: [],
            tasks: [],
            notifications: [],
            archives: [],
            test: []
        });

        await assert.rejects(
            async () => await db_api._migrateRemoteDB('postgres', 'mongo', 'postgresql://source-db', 'mongodb://target-db'),
            /rename failed/
        );

        const targetDatabase = databases.get('mongodb://target-db');
        assert.deepStrictEqual(targetDatabase.snapshot('files'), [{ uid: 'existing-file' }]);
        assert.deepStrictEqual(targetDatabase.snapshot('playlists'), [{ id: 'existing-playlist' }]);
        assert.deepStrictEqual(targetDatabase.collectionNames(), ['files', 'playlists']);
    });

    it('executes duplicate count aggregate pipelines in SQL for PostgreSQL', async function() {
        const fakePool = {
            query: async (queryText, params) => {
                assert(queryText.includes('GROUP BY'));
                assert(queryText.includes('"duplicate_group_count"'));
                assert(queryText.includes('"count" >'));
                assert(params.length > 0);
                return { rows: [{ duplicate_group_count: 4 }] };
            }
        };

        const aggregateRows = await postgres_store.aggregateRecords(fakePool, {
            files: {
                primary_key: 'uid',
                field_types: {
                    uid: 'text',
                    duplicate_key: 'text'
                }
            }
        }, 'files', [
            { $match: { duplicate_key: { $ne: null } } },
            { $group: { _id: '$duplicate_key', count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
            { $count: 'duplicate_group_count' }
        ]);

        assert.deepStrictEqual(aggregateRows, [{ duplicate_group_count: 4 }]);
    });

    it('executes duplicate group aggregate pipelines in SQL for PostgreSQL', async function() {
        const fakePool = {
            query: async (queryText) => {
                assert(queryText.includes('MAX('));
                assert(queryText.includes('ORDER BY "newest_registered" DESC'));
                return { rows: [{ _id: 'dup-1', count: 2, newest_registered: '123' }] };
            }
        };

        const aggregateRows = await postgres_store.aggregateRecords(fakePool, {
            files: {
                primary_key: 'uid',
                field_types: {
                    uid: 'text',
                    duplicate_key: 'text',
                    registered: 'numeric'
                }
            }
        }, 'files', [
            { $match: { duplicate_key: { $ne: null } } },
            { $group: { _id: '$duplicate_key', count: { $sum: 1 }, newest_registered: { $max: '$registered' } } },
            { $match: { count: { $gt: 1 } } },
            { $sort: { newest_registered: -1 } }
        ]);

        assert.deepStrictEqual(aggregateRows, [{ _id: 'dup-1', count: 2, newest_registered: '123' }]);
    });
});
