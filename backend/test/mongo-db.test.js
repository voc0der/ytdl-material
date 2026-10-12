const net = require('net');
const postgres_store = require('../postgres-store');
const { assert, db_api, config_api, utils, fs, path } = require('./test-shared');
const { useFakeMongo, MONGO_URL } = require('./helpers/fake-mongo');

const BACKUP_DIR = path.join('appdata', 'db_backup');

// A port nothing is listening on, found by letting the OS assign one and closing it again.
async function closedPort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

/*************************************************
 * db.js against MongoDB, through the in-memory
 * stand-in in helpers/fake-mongo.js: what it sends
 * the driver, what it makes of the answers, how it
 * connects, and how it moves data in and out.
 *
 * database.test.js runs the operations both stores
 * share against each of them. This covers what
 * only the MongoDB side does, and the checks that
 * stand between a request and either store.
 ************************************************/
describe('MongoDB storage', function() {
    const fake = useFakeMongo();
    let saved_config;
    let saved_postgres;
    let saved_wait;

    beforeEach(function() {
        saved_config = JSON.parse(JSON.stringify(config_api.getConfigFile()));
        saved_postgres = {...postgres_store};
        // Connection retries wait two seconds apiece.
        saved_wait = utils.wait;
        utils.wait = async () => {};
    });

    afterEach(async function() {
        Object.assign(postgres_store, saved_postgres);
        utils.wait = saved_wait;
        config_api.setConfigFile(saved_config);
        db_api.setLocalDBMode(true);
        await db_api.removeAllRecords();
    });

    const connectWith = (options = {}) => fake.install({connect: true, ...options});
    const seeded = collections => ({collections: {[MONGO_URL]: collections}});

    describe('Writes', function() {
        it('matches update filters literally, so a value in one cannot act as an operator', async function() {
            await connectWith(seeded({files: [{uid: 'a', title: 'old'}, {uid: 'b', title: 'old'}]}));

            assert.strictEqual(await db_api.updateRecord('files', {uid: 'a'}, {title: 'new'}), true);
            assert.strictEqual(await db_api.updateRecords('files', {title: 'old'}, {seen: true}), true);

            assert.deepStrictEqual(fake.database.callsTo('updateOne')[0].args.slice(0, 2), [{uid: {$eq: 'a'}}, {$set: {title: 'new'}}]);
            assert.deepStrictEqual(fake.database.callsTo('updateMany')[0].args.slice(0, 2), [{title: {$eq: 'old'}}, {$set: {seen: true}}]);
            assert.deepStrictEqual(fake.database.snapshot('files'), [{uid: 'a', title: 'new'}, {uid: 'b', title: 'old', seen: true}]);
        });

        it('leaves out the _id that a record read back from MongoDB carries', async function() {
            await connectWith(seeded({files: [{_id: 'stored-id', uid: 'a', title: 'old'}]}));

            const record = await db_api.getRecord('files', {uid: 'a'});
            assert.strictEqual(await db_api.updateRecord('files', {uid: 'a'}, {...record, title: 'new'}), true);

            assert.deepStrictEqual(fake.database.snapshot('files', {keep_ids: true}), [{_id: 'stored-id', uid: 'a', title: 'new'}]);
        });

        it('refuses an update whose filter holds an operator, and sends nothing', async function() {
            await connectWith(seeded({files: [{uid: 'a', title: 'old'}]}));

            assert.strictEqual(await db_api.updateRecord('files', {uid: {$ne: null}}, {title: 'taken'}), false);
            assert.strictEqual(await db_api.updateRecords('files', {uid: {$gt: ''}}, {title: 'taken'}), false);
            assert.strictEqual(await db_api.updateRecords('files', {$where: 'true'}, {title: 'taken'}), false);
            assert.strictEqual(await db_api.updateRecord('files', ['uid', 'a'], {title: 'taken'}), false);

            assert.deepStrictEqual(fake.database.calls, []);
            assert.deepStrictEqual(fake.database.snapshot('files'), [{uid: 'a', title: 'old'}]);
        });

        it('refuses an update that would write an operator or a prototype key, to either store', async function() {
            const unsafe_updates = [
                {$set: {title: 'x'}},
                JSON.parse('{"__proto__": {"polluted": true}}'),
                {'meta.constructor': 'x'},
                {meta: {$gt: 1}},
                {meta: {'a.b': 1}},
                {'': 'x'},
                null,
                ['title']
            ];

            for (const use_local_db of [true, false]) {
                if (use_local_db) db_api.setLocalDBMode(true);
                else await connectWith(seeded({files: [{uid: 'a', title: 'old'}]}));
                if (use_local_db) await db_api.insertRecordIntoTable('files', {uid: 'a', title: 'old'});

                for (const update of unsafe_updates) {
                    assert.strictEqual(await db_api.updateRecord('files', {uid: 'a'}, update), false, JSON.stringify(update));
                    assert.strictEqual(await db_api.updateRecords('files', {uid: 'a'}, update), false, JSON.stringify(update));
                }

                const [record] = await db_api.getRecords('files', {uid: 'a'}, false, null, null, ['uid', 'title']);
                assert.deepStrictEqual(record, {uid: 'a', title: 'old'});
            }
            assert.deepStrictEqual(fake.database.callsTo('updateOne'), []);
            assert.deepStrictEqual(fake.database.callsTo('updateMany'), []);
            assert.strictEqual({}.polluted, undefined);
        });

        it('refuses to touch a table it does not know', async function() {
            await connectWith();

            assert.strictEqual(await db_api.updateRecord('nope', {uid: 'a'}, {title: 'x'}), false);
            assert.strictEqual(await db_api.updateRecords('nope', {uid: 'a'}, {title: 'x'}), false);
            assert.deepStrictEqual(await db_api.aggregateRecords('nope', [{$match: {}}]), []);
            assert.deepStrictEqual(fake.database.calls, []);
        });

        it('counts a write only when MongoDB acknowledged it', async function() {
            const answers = {};
            await connectWith({...seeded({files: [{uid: 'a'}]}), behavior: {writeResult: method => answers[method]}});

            answers.updateOne = {acknowledged: false};
            assert.strictEqual(await db_api.updateRecord('files', {uid: 'a'}, {title: 'x'}), false);
            answers.deleteOne = null;
            assert.strictEqual(await db_api.removeRecord('files', {uid: 'a'}), false);
            // bulkWrite answers with ok rather than acknowledged.
            answers.bulkWrite = {ok: 0};
            assert.strictEqual(await db_api.bulkInsertRecordsIntoTable('files', [{uid: 'b'}]), false);
            answers.bulkWrite = {ok: 1};
            assert.strictEqual(await db_api.bulkUpdateRecordsByKey('files', 'uid', {b: {title: 'y'}}), true);
            // How drivers before 4.0 answered.
            answers.insertOne = {result: {ok: 0}};
            assert.strictEqual(await db_api.insertRecordIntoTable('files', {uid: 'c'}), false);
            answers.insertOne = {result: {ok: 1}};
            assert.strictEqual(await db_api.insertRecordIntoTable('files', {uid: 'd'}), true);
            // An answer with no flag at all is taken as done.
            answers.insertMany = {insertedCount: 1};
            assert.strictEqual(await db_api.insertRecordsIntoTable('files', [{uid: 'e'}]), true);
        });

        it('replaces the records a filter matches in one batch', async function() {
            await connectWith(seeded({files: [{uid: 'a', version: 1}, {uid: 'b', version: 1}]}));

            assert.strictEqual(await db_api.insertRecordIntoTable('files', {uid: 'a', version: 2}, {uid: 'a'}), true);

            const [batch] = fake.database.callsTo('bulkWrite');
            assert.deepStrictEqual(batch.args[0], [{deleteMany: {filter: {uid: 'a'}}}, {insertOne: {document: {uid: 'a', version: 2}}}]);
            assert.deepStrictEqual(fake.database.snapshot('files'), [{uid: 'b', version: 1}, {uid: 'a', version: 2}]);
        });

        it('adds nothing for an empty batch', async function() {
            await connectWith();

            assert.strictEqual(await db_api.bulkInsertRecordsIntoTable('files', []), true);
            assert.strictEqual(await db_api.bulkUpdateRecordsByKey('files', 'uid', {}), true);
            assert.deepStrictEqual(fake.database.calls, []);
        });
    });

    describe('Reads', function() {
        const FILES = [1, 2, 3, 4, 5].map(n => ({uid: `f${n}`, registered: n, isAudio: n % 2 === 0, uploader: n < 3 ? 'early' : 'late'}));

        it('pages with skip and limit, and asks for nothing when the page is empty', async function() {
            await connectWith(seeded({files: FILES}));

            const page = await db_api.getRecords('files', null, false, {by: 'registered', order: -1}, [1, 3]);
            assert.deepStrictEqual(page.map(record => record.uid), ['f4', 'f3']);
            assert.strictEqual(await db_api.getRecords('files', {registered: {$gt: 2}}, true), 3);

            fake.database.calls.length = 0;
            assert.deepStrictEqual(await db_api.getRecords('files', null, false, null, [3, 3]), []);
            assert.deepStrictEqual(await db_api.getRecords('files', null, false, null, [4, 2]), []);
            assert.deepStrictEqual(fake.database.calls, []);
        });

        it('runs an aggregation pipeline as given, and an empty one for anything else', async function() {
            await connectWith(seeded({files: FILES}));

            const groups = await db_api.aggregateRecords('files', [
                {$match: {isAudio: false}},
                {$group: {_id: '$uploader', count: {$sum: 1}}},
                {$sort: {count: -1}}
            ]);
            assert.deepStrictEqual(groups, [{_id: 'late', count: 2}, {_id: 'early', count: 1}]);

            assert.strictEqual((await db_api.aggregateRecords('files', 'not a pipeline')).length, FILES.length);
            assert.deepStrictEqual(fake.database.callsTo('aggregate').pop().args, [[]]);
        });

        it('leaves aggregation to the caller on the local store', async function() {
            db_api.setLocalDBMode(true);
            assert.deepStrictEqual(await db_api.aggregateRecords('files', [{$match: {}}]), []);
        });

        it('refuses a projection it cannot honor, on either store', async function() {
            for (const use_local_db of [true, false]) {
                if (use_local_db) db_api.setLocalDBMode(true);
                else await connectWith(seeded({files: FILES}));

                await assert.rejects(db_api.getRecords('files', null, false, null, null, []), /non-empty array/);
                await assert.rejects(db_api.getRecords('files', null, false, null, null, ['_id']), /'_id' field cannot be projected/);
                await assert.rejects(db_api.getRecords('files', null, false, null, null, ['$where']), /Unsafe Mongo field path/);
                await assert.rejects(db_api.getRecords('files', null, false, null, null, ['uid', '']), /non-empty string/);
            }
            assert.deepStrictEqual(fake.database.callsTo('find'), []);
        });
    });

    describe('Connecting', function() {
        it('retries a refused connection, and uses MongoDB once it answers', async function() {
            let attempts = 0;
            const refuseTwice = () => {
                if (++attempts < 3) throw new Error('connect ECONNREFUSED');
            };
            db_api.setLocalDBMode(true);
            await fake.install({behavior: {connect: refuseTwice}});

            assert.strictEqual(await db_api.connectToDB(3, true), true);
            assert.strictEqual(attempts, 3);
            assert.strictEqual(db_api.isUsingMongoDB(), true);
        });

        it('falls back to the local store when MongoDB never answers, and closes the client it had', async function() {
            const behavior = {};
            const mongo = await connectWith({behavior});
            const open_client = mongo.clients[mongo.clients.length - 1];
            behavior.connect = () => {
                throw new Error('connect ECONNREFUSED');
            };

            assert.strictEqual(await db_api.connectToDB(2), true);
            assert.strictEqual(db_api.isUsingLocalDB(), true);
            assert.strictEqual(db_api.getActiveDBType(), 'local');
            assert.strictEqual(open_client.closed, true);
            // The first attempt, then the two retries.
            assert.strictEqual(mongo.clients.length, 4);
        });

        it('gives up without falling back when told to', async function() {
            db_api.setLocalDBMode(true);
            await fake.install({behavior: {connect: () => {
                throw new Error('connect ECONNREFUSED');
            }}});

            assert.strictEqual(await db_api.connectToDB(1, true), false);
            assert.strictEqual(fake.mongo.clients.length, 2);
        });

        it('checks a connection string without switching to it or setting anything up', async function() {
            db_api.setLocalDBMode(true);
            const mongo = await fake.install();

            assert.strictEqual(await db_api.connectToDB(0, true, 'mongodb://elsewhere.test:27017/'), true);

            const [client] = mongo.clients;
            assert.strictEqual(client.connectionString, 'mongodb://elsewhere.test:27017/');
            assert.strictEqual(client.closed, true);
            assert.deepStrictEqual(mongo.databases.get('mongodb://elsewhere.test:27017/').collectionNames(), []);
            assert.strictEqual(db_api.isUsingLocalDB(), true);
        });

        it('says so when it cannot tell what a connection string is for, or none is set', async function() {
            db_api.setLocalDBMode(true);
            const mongo = await fake.install();

            assert.strictEqual(await db_api.connectToDB(0, true, 'ftp://elsewhere.test/'), false);
            config_api.setConfigItem('ytdl_mongodb_connection_string', '');
            assert.strictEqual(await db_api.connectToDB(0, true), false);

            assert.deepStrictEqual(mongo.clients, []);
            assert.strictEqual(db_api.isUsingLocalDB(), true);
        });

        it('reports a server that does not answer through the real driver', async function() {
            db_api.setLocalDBMode(true);
            db_api.resetMongoClientCtor();
            const port = await closedPort();

            assert.strictEqual(await db_api.connectToDB(0, true, `mongodb://127.0.0.1:${port}/?serverSelectionTimeoutMS=200`), false);
        });
    });

    describe('Moving data', function() {
        const listBackups = () => (fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : []);
        const backupsSince = before => listBackups().filter(name => !before.includes(name));

        async function withLocalRecords(records) {
            db_api.setLocalDBMode(true);
            await db_api.insertRecordsIntoTable('test', records);
            config_api.setConfigItem('ytdl_db_migrate', '');
        }

        it('copies the local records into an empty MongoDB, keeping a backup of them', async function() {
            await withLocalRecords([{uid: 'local-1'}, {uid: 'local-2'}]);
            const mongo = await fake.install();
            const backups = listBackups();
            db_api.setLocalDBMode(false);

            assert.strictEqual(await db_api.bootstrapRemoteDBFromLocalIfNeeded(), true);

            const target = mongo.databases.get(MONGO_URL);
            assert.deepStrictEqual(target.snapshot('test'), [{uid: 'local-1'}, {uid: 'local-2'}]);
            assert(!target.collectionNames().some(name => name.includes('__')), target.collectionNames().join());
            const [backup] = backupsSince(backups);
            assert(backup.startsWith('local_db.json.'));
            assert.deepStrictEqual(fs.readJSONSync(path.join(BACKUP_DIR, backup)).test, [{uid: 'local-1'}, {uid: 'local-2'}]);
        });

        it('leaves a MongoDB that already has records alone', async function() {
            await withLocalRecords([{uid: 'local-1'}]);
            const mongo = await fake.install(seeded({files: [{uid: 'remote-1'}]}));
            db_api.setLocalDBMode(false);

            assert.strictEqual(await db_api.bootstrapRemoteDBFromLocalIfNeeded(), false);
            assert.deepStrictEqual(mongo.databases.get(MONGO_URL).snapshot('test'), []);
            assert.deepStrictEqual(mongo.databases.get(MONGO_URL).snapshot('files'), [{uid: 'remote-1'}]);
        });

        it('keeps the local records and their backup when the copy fails', async function() {
            await withLocalRecords([{uid: 'local-1'}]);
            const mongo = await fake.install({behavior: {renameFailure: (from, to) => to === 'test'}});
            const backups = listBackups();
            db_api.setLocalDBMode(false);

            await assert.rejects(db_api.bootstrapRemoteDBFromLocalIfNeeded(), /rename failed/);

            assert.deepStrictEqual(mongo.databases.get(MONGO_URL).collectionNames(), []);
            assert.strictEqual(backupsSince(backups).length, 1);
            db_api.setLocalDBMode(true);
            assert.deepStrictEqual((await db_api.getRecords('test')).map(record => record.uid), ['local-1']);
        });

        it('finishes a copy whose clean-up cannot drop what it set aside', async function() {
            const gone = Object.assign(new Error('ns not found'), {codeName: 'NamespaceNotFound'});
            const refused = new Error('not authorized to drop');
            const dropError = name => (name.startsWith('test__backup_') ? gone : name.startsWith('files__backup_') ? refused : null);
            await withLocalRecords([{uid: 'local-1'}]);
            // Empty collections, so there is nothing to protect, but each is set aside first.
            const mongo = await fake.install({...seeded({test: [], files: []}), behavior: {dropError}});
            db_api.setLocalDBMode(false);

            assert.strictEqual(await db_api.bootstrapRemoteDBFromLocalIfNeeded(), true);
            assert.deepStrictEqual(mongo.databases.get(MONGO_URL).snapshot('test'), [{uid: 'local-1'}]);
            assert.strictEqual(mongo.databases.get(MONGO_URL).callsTo('drop').length, 2);
        });

        it('says a migration finished when only saving its settings failed', async function() {
            postgres_store.createConnection = async () => ({});
            postgres_store.closeConnection = async () => {};
            postgres_store.readAllTables = async () => ({test: [{uid: 'moved-1'}]});
            const mongo = await fake.install();
            config_api.setConfigItem('ytdl_use_local_db', false);
            config_api.setConfigItem('ytdl_postgresdb_connection_string', 'postgresql://source.test/ytdl');
            config_api.setConfigItem('ytdl_db_migrate', 'mongo');
            const saveConfigItems = config_api.setConfigItems;
            config_api.setConfigItems = () => false;

            try {
                await assert.rejects(db_api.runConfiguredDBMigration(), error => {
                    assert.match(error.message, /completed, but failed to persist ytdl_remote_db_type=mongo/);
                    assert.strictEqual(error.migration_completed, true);
                    return true;
                });
            } finally {
                config_api.setConfigItems = saveConfigItems;
            }
            assert.deepStrictEqual(mongo.databases.get(MONGO_URL).snapshot('test'), [{uid: 'moved-1'}]);
        });

        it('stays on the old database, set to try again, when a migration fails', async function() {
            postgres_store.createConnection = async () => ({});
            postgres_store.closeConnection = async () => {};
            postgres_store.readAllTables = async () => ({test: [{uid: 'kept-1'}]});
            const mongo = await fake.install({behavior: {renameFailure: (from, to) => to === 'test'}});
            config_api.setConfigItem('ytdl_use_local_db', false);
            config_api.setConfigItem('ytdl_remote_db_type', 'postgres');
            config_api.setConfigItem('ytdl_postgresdb_connection_string', 'postgresql://source.test/ytdl');
            config_api.setConfigItem('ytdl_db_migrate', 'mongo');

            await assert.rejects(db_api.runConfiguredDBMigration(), /rename failed/);

            assert.strictEqual(config_api.getConfigItem('ytdl_remote_db_type'), 'postgres');
            assert.strictEqual(config_api.getConfigItem('ytdl_db_migrate'), 'mongo');
            assert.deepStrictEqual(mongo.databases.get(MONGO_URL).collectionNames(), []);
        });

        it('stays on the local store, and keeps reading it, when a transfer to MongoDB cannot connect', async function() {
            await withLocalRecords([{uid: 'local-1'}]);
            config_api.setConfigItem('ytdl_use_local_db', true);
            await fake.install({behavior: {connect: () => {
                throw new Error('connect ECONNREFUSED');
            }}});

            assert.strictEqual(await db_api.transferDB(true), false);

            assert.strictEqual(config_api.getConfigItem('ytdl_use_local_db'), true);
            assert.strictEqual(db_api.isUsingLocalDB(), true);
            assert.deepStrictEqual((await db_api.getRecords('test')).map(record => record.uid), ['local-1']);
        });
    });

    describe('Importing the JSON files from before 4.3', function() {
        // Written beside the working directory's appdata, as the migration does.
        const LEGACY_BACKUP = /^(db|users_db)\.json\.[\d.]+\.bak$/;
        let legacy_backups;

        beforeEach(function() {
            legacy_backups = fs.readdirSync('appdata').filter(name => LEGACY_BACKUP.test(name));
        });

        afterEach(function() {
            for (const name of fs.readdirSync('appdata')) {
                if (LEGACY_BACKUP.test(name) && !legacy_backups.includes(name)) fs.removeSync(path.join('appdata', name));
            }
        });

        const legacyJSON = () => ({
            db_json: {
                files: [{uid: 'shared-file'}],
                playlists: [{id: 'shared-playlist'}],
                categories: [{uid: 'shared-category'}],
                subscriptions: [{id: 'shared-sub', name: 'Shared', videos: [{uid: 'shared-sub-file'}]}],
                downloads: {session: {download: {uid: 'download-1'}}}
            },
            users_json: {
                users: [{
                    uid: 'alice',
                    name: 'Alice',
                    files: [{uid: 'alice-file'}],
                    playlists: [{id: 'alice-playlist'}],
                    categories: [{uid: 'alice-category'}],
                    subscriptions: [{id: 'alice-sub', name: 'Mine', videos: [{uid: 'alice-sub-file'}]}]
                }, {uid: 'bob', name: 'Bob'}],
                roles: {admin: {permissions: ['settings']}, user: {permissions: ['filemanager']}}
            }
        });

        it('moves what each user owned into tables of its own, marked with the owner', async function() {
            const {db_json, users_json} = legacyJSON();

            const tables = await db_api.generateJSONTables(db_json, users_json);

            assert.deepStrictEqual(tables.files, [
                {uid: 'shared-file'},
                {uid: 'alice-file', user_uid: 'alice'},
                {uid: 'shared-sub-file', sub_id: 'shared-sub', user_uid: undefined},
                {uid: 'alice-sub-file', sub_id: 'alice-sub', user_uid: 'alice'}
            ]);
            assert.deepStrictEqual(tables.playlists, [{id: 'shared-playlist'}, {id: 'alice-playlist', user_uid: 'alice'}]);
            assert.deepStrictEqual(tables.categories, [{uid: 'shared-category'}, {uid: 'alice-category', user_uid: 'alice'}]);
            assert.deepStrictEqual(tables.subscriptions, [{id: 'shared-sub', name: 'Shared'}, {id: 'alice-sub', name: 'Mine', user_uid: 'alice'}]);
            assert.deepStrictEqual(tables.users.map(user => [user.uid, 'files' in user, 'playlists' in user, 'subscriptions' in user]), [
                ['alice', false, false, false],
                ['bob', false, false, false]
            ]);
            assert.deepStrictEqual(tables.roles, [{key: 'admin', permissions: ['settings']}, {key: 'user', permissions: ['filemanager']}]);
            assert.deepStrictEqual(tables.downloads, [{key: 'session', download: {uid: 'download-1'}}]);
        });

        it('replaces what the database held with them, after backing both files up', async function() {
            await connectWith(seeded({files: [{uid: 'replaced'}]}));
            const {db_json, users_json} = legacyJSON();

            assert(await db_api.importJSONToDB(db_json, users_json));

            const files = (await db_api.getRecords('files')).map(file => file.uid);
            assert.deepStrictEqual(files, ['shared-file', 'alice-file', 'shared-sub-file', 'alice-sub-file']);
            assert.deepStrictEqual((await db_api.getRecords('users')).map(user => user.uid), ['alice', 'bob']);
            assert.deepStrictEqual((await db_api.getRecords('roles')).map(role => role.key), ['admin', 'user']);
            const written = fs.readdirSync('appdata').filter(name => LEGACY_BACKUP.test(name) && !legacy_backups.includes(name));
            assert.deepStrictEqual(written.map(name => name.split('.')[0]).sort(), ['db', 'users_db']);
        });
    });
});
