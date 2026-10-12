const { assert, uuid, db_api, config_api, fs, path } = require('./test-shared');
const { useFakeMongo, MONGO_URL } = require('./helpers/fake-mongo');

const BACKUP_DIR = path.join('appdata', 'db_backup');

describe('Database', async function() {
    describe('Import', async function() {
        const fake = useFakeMongo();

        it('Transfer to remote', async function() {
            await db_api.removeAllRecords('test');
            await db_api.insertRecordIntoTable('test', {test: 'test'});

            assert(await db_api.transferDB(true));
            assert.strictEqual(db_api.isUsingMongoDB(), true);
            assert.strictEqual(config_api.getConfigItem('ytdl_use_local_db'), false);
            const success = await db_api.getRecord('test', {test: 'test'});
            assert(success);
            assert.deepStrictEqual(fake.mongo.databases.get(MONGO_URL).snapshot('test'), [{test: 'test'}]);
        });

        it('Transfer to local', async function() {
            await db_api.removeAllRecords('test');
            await db_api.insertRecordIntoTable('test', {test: 'test'});

            assert(await db_api.transferDB(false));
            assert.strictEqual(db_api.isUsingLocalDB(), true);
            assert.strictEqual(config_api.getConfigItem('ytdl_use_local_db'), true);
            const success = await db_api.getRecord('test', {test: 'test'});
            assert(success);
        });

        it('Restore db', async function() {
            assert.strictEqual(await db_api.connectToDB(0, true), true);
            await db_api.removeAllRecords('test');
            await db_api.insertRecordsIntoTable('test', [{uid: 'kept-1'}, {uid: 'kept-2'}]);
            const db_stats = await db_api.getDBStats();

            const file_name = await db_api.backupDB();
            assert(file_name.startsWith('remote_db.json.'));
            await db_api.insertRecordIntoTable('test', {uid: 'after-the-backup'});
            assert(await db_api.restoreDB(file_name));

            const new_db_stats = await db_api.getDBStats();
            assert.deepStrictEqual(new_db_stats, db_stats);
            assert.deepStrictEqual((await db_api.getRecords('test')).map(record => record.uid).sort(), ['kept-1', 'kept-2']);
        });

        it('Restore db refuses a backup with nothing in it', async function() {
            const file_name = `remote_db.json.${Date.now() / 1000}.bak`;
            fs.outputFileSync(path.join(BACKUP_DIR, file_name), 'null');
            const before = await db_api.getRecords('test');

            assert.strictEqual(await db_api.restoreDB(file_name), false);
            assert.deepStrictEqual(await db_api.getRecords('test'), before);
        });
    });

    describe('Basic functions', async function() {
        
        // test both local_db and remote_db
        const local_db_modes = [false, true];

        for (const local_db_mode of local_db_modes) {
            let use_local_db = local_db_mode;
            describe(`Use local DB - ${use_local_db}`, async function() {
                // The remote half runs against an in-memory MongoDB, and connects without
                // falling back, so a failed connection cannot quietly test the local store.
                if (!use_local_db) useFakeMongo({connect: true});

                beforeEach(async function() {
                    await db_api.removeAllRecords('test');
                });
                it('Add and read record', async function() {
                    this.timeout(120000);
                    await db_api.insertRecordIntoTable('test', {test_add: 'test', test_undefined: undefined, test_null: undefined});
                    const added_record = await db_api.getRecord('test', {test_add: 'test', test_undefined: undefined, test_null: null});
                    assert(added_record['test_add'] === 'test');
                    await db_api.removeRecord('test', {test_add: 'test'});
                });
                it('Add and read record - Nested property', async function() {
                    this.timeout(120000);
                    await db_api.insertRecordIntoTable('test', {test_add: 'test', test_nested: {test_key1: 'test1', test_key2: 'test2'}});
                    const added_record = await db_api.getRecord('test', {test_add: 'test', 'test_nested.test_key1': 'test1', 'test_nested.test_key2': 'test2'});
                    const not_added_record = await db_api.getRecord('test', {test_add: 'test', 'test_nested.test_key1': 'test1', 'test_nested.test_key2': 'test3'});
                    assert(added_record['test_add'] === 'test');
                    assert(!not_added_record);
                    await db_api.removeRecord('test', {test_add: 'test'});
                });
                it('Replace filter', async function() {
                    this.timeout(120000);
                    await db_api.insertRecordIntoTable('test', {test_replace_filter: 'test', test_nested: {test_key1: 'test1', test_key2: 'test2'}}, {test_nested: {test_key1: 'test1', test_key2: 'test2'}});
                    await db_api.insertRecordIntoTable('test', {test_replace_filter: 'test', test_nested: {test_key1: 'test1', test_key2: 'test2'}}, {test_nested: {test_key1: 'test1', test_key2: 'test2'}});
                    const count = await db_api.getRecords('test', {test_replace_filter: 'test'}, true);
                    assert(count === 1);
                    await db_api.removeRecord('test', {test_replace_filter: 'test'});
                });
                it('Find duplicates by key', async function() {
                    const test_duplicates = [
                        {
                            test: 'testing',
                            key: '1'
                        },
                        {
                            test: 'testing',
                            key: '2'
                        },
                        {
                            test: 'testing_missing',
                            key: '3'
                        },
                        {
                            test: 'testing',
                            key: '4'
                        }
                    ];
                    await db_api.insertRecordsIntoTable('test', test_duplicates);
                    const duplicates = await db_api.findDuplicatesByKey('test', 'test');
                    assert(duplicates && duplicates.length === 2 && duplicates[0]['key'] === '2' && duplicates[1]['key'] === '4')
                });

                it('Update record', async function() {
                    await db_api.insertRecordIntoTable('test', {test_update: 'test'});
                    await db_api.updateRecord('test', {test_update: 'test'}, {added_field: true});
                    const updated_record = await db_api.getRecord('test', {test_update: 'test'});
                    assert(updated_record['added_field']);
                    await db_api.removeRecord('test', {test_update: 'test'});
                });

                it('Update records', async function() {
                    await db_api.insertRecordIntoTable('test', {test_update: 'test', key: 'test1'});
                    await db_api.insertRecordIntoTable('test', {test_update: 'test', key: 'test2'});
                    await db_api.updateRecords('test', {test_update: 'test'}, {added_field: true});
                    const updated_records = await db_api.getRecords('test', {added_field: true});
                    assert(updated_records.length === 2);
                    await db_api.removeRecord('test', {test_update: 'test'});
                });

                it('Remove property from record', async function() {
                    await db_api.insertRecordIntoTable('test', {test_keep: 'test', test_remove: 'test'});
                    await db_api.removePropertyFromRecord('test', {test_keep: 'test'}, {test_remove: true});
                    const updated_record = await db_api.getRecord('test', {test_keep: 'test'});
                    assert(updated_record['test_keep']);
                    assert(!updated_record['test_remove']);
                    await db_api.removeRecord('test', {test_keep: 'test'});
                });

                it('Remove record', async function() {
                    await db_api.insertRecordIntoTable('test', {test_remove: 'test'});
                    const delete_succeeded = await db_api.removeRecord('test', {test_remove: 'test'});
                    assert(delete_succeeded);
                    const deleted_record = await db_api.getRecord('test', {test_remove: 'test'});
                    assert(!deleted_record);
                });

                it('Remove records', async function() {
                    await db_api.insertRecordIntoTable('test', {test_remove: 'test', test_property: 'test'});
                    await db_api.insertRecordIntoTable('test', {test_remove: 'test', test_property: 'test2'});
                    await db_api.insertRecordIntoTable('test', {test_remove: 'test'});
                    const delete_succeeded = await db_api.removeAllRecords('test', {test_remove: 'test'});
                    assert(delete_succeeded);
                    const count = await db_api.getRecords('test', {test_remove: 'test'}, true);
                    assert(count === 0);
                });

                it('Push to record array', async function() {
                    await db_api.insertRecordIntoTable('test', {test: 'test', test_array: []});
                    await db_api.pushToRecordsArray('test', {test: 'test'}, 'test_array', 'test_item');
                    const record = await db_api.getRecord('test', {test: 'test'});
                    assert(record);
                    assert(record['test_array'].length === 1);
                });

                it('Pull from record array', async function() {
                    await db_api.insertRecordIntoTable('test', {test: 'test', test_array: ['test_item']});
                    await db_api.pullFromRecordsArray('test', {test: 'test'}, 'test_array', 'test_item');
                    const record = await db_api.getRecord('test', {test: 'test'});
                    assert(record);
                    assert(record['test_array'].length === 0);
                });

                it('Bulk add', async function() {
                    this.timeout(120000);
                    const NUM_RECORDS_TO_ADD = 2002; // max batch ops is 1000
                    const test_records = [];
                    for (let i = 0; i < NUM_RECORDS_TO_ADD; i++) {
                        test_records.push({
                            uid: uuid()
                        });
                    }
                    const succcess = await db_api.bulkInsertRecordsIntoTable('test', test_records);

                    const received_records = await db_api.getRecords('test');
                    assert(succcess && received_records && received_records.length === NUM_RECORDS_TO_ADD);
                });

                it('Bulk update', async function() {
                    // bulk add records
                    const NUM_RECORDS_TO_ADD = 100; // max batch ops is 1000
                    const test_records = [];
                    const update_obj = {};
                    for (let i = 0; i < NUM_RECORDS_TO_ADD; i++) {
                        const test_uid =  uuid();
                        test_records.push({
                            uid: test_uid
                        });
                        update_obj[test_uid] = {added_field: true};
                    }
                    let success = await db_api.bulkInsertRecordsIntoTable('test', test_records);
                    assert(success);

                    // makes sure they are added
                    const received_records = await db_api.getRecords('test');
                    assert(received_records && received_records.length === NUM_RECORDS_TO_ADD);

                    success = await db_api.bulkUpdateRecordsByKey('test', 'uid', update_obj);
                    assert(success);

                    const received_updated_records = await db_api.getRecords('test');
                    for (let i = 0; i < received_updated_records.length; i++) {
                        success &= received_updated_records[i]['added_field'];
                    }
                    assert(success);
                });

                it('Stats', async function() {
                    await db_api.insertRecordsIntoTable('notifications', [{uid: 'stats-1'}, {uid: 'stats-2'}]);
                    const stats = await db_api.getDBStats();
                    await db_api.removeAllRecords('notifications', {uid: {$in: ['stats-1', 'stats-2']}});

                    assert.strictEqual(stats.current_db_type, use_local_db ? 'local' : 'mongo');
                    assert.strictEqual(stats.using_local_db, use_local_db);
                    assert(stats.stats_by_table.notifications.records_count >= 2);
                    assert(!('test' in stats.stats_by_table));
                });

                // Only the local store reads the date formats older versions saved. MongoDB
                // sorts the stored strings as they are, which puts 'N/A' ahead of every date
                // when sorting newest first.
                (use_local_db ? it : it.skip)('Sorts upload dates in chronological order', async function() {
                    const test_records = [
                        {uid: 'upload-date-sort-1', upload_date: '6/26/17'},
                        {uid: 'upload-date-sort-2', upload_date: '2021-07-06'},
                        {uid: 'upload-date-sort-3', upload_date: '20200423'},
                        {uid: 'upload-date-sort-4', upload_date: 'N/A'}
                    ];
                    const success = await db_api.bulkInsertRecordsIntoTable('test', test_records);
                    assert(success);

                    const descending_records = await db_api.getRecords('test', null, false, {by: 'upload_date', order: -1});
                    assert.deepStrictEqual(descending_records.map(record => record.uid), [
                        'upload-date-sort-2',
                        'upload-date-sort-3',
                        'upload-date-sort-1',
                        'upload-date-sort-4'
                    ]);

                    const ascending_records = await db_api.getRecords('test', null, false, {by: 'upload_date', order: 1});
                    assert.deepStrictEqual(ascending_records.map(record => record.uid), [
                        'upload-date-sort-1',
                        'upload-date-sort-3',
                        'upload-date-sort-2',
                        'upload-date-sort-4'
                    ]);
                });

                it('Projects only selected fields after sorting and ranging local records', async function() {
                    const heavyweight_error = 'large captured process output'.repeat(1000);
                    await db_api.insertRecordsIntoTable('test', [
                        {
                            uid: 'projection-older',
                            timestamp_start: 1,
                            error: heavyweight_error,
                            prefetched_info: [{description: heavyweight_error}],
                            options: {
                                playlistBatchId: 'batch-older',
                                additionalArgs: [heavyweight_error]
                            }
                        },
                        {
                            uid: 'projection-newer',
                            timestamp_start: 2,
                            error: heavyweight_error,
                            prefetched_info: [{description: heavyweight_error}],
                            container: {
                                id: 'playlist-1',
                                uids: Array(1000).fill('file-uid')
                            },
                            options: {
                                playlistBatchId: 'batch-newer',
                                playlistChunkRange: '1-10',
                                additionalArgs: [heavyweight_error]
                            }
                        }
                    ]);

                    const projected_records = await db_api.getRecords(
                        'test',
                        null,
                        false,
                        {by: 'timestamp_start', order: -1},
                        [0, 1],
                        ['uid', 'timestamp_start', 'container.id', 'options.playlistBatchId', 'options.playlistChunkRange']
                    );

                    assert.deepStrictEqual(projected_records, [{
                        uid: 'projection-newer',
                        timestamp_start: 2,
                        container: {id: 'playlist-1'},
                        options: {
                            playlistBatchId: 'batch-newer',
                            playlistChunkRange: '1-10'
                        }
                    }]);
                    assert.strictEqual(Object.prototype.hasOwnProperty.call(projected_records[0], 'error'), false);
                    assert.strictEqual(Object.prototype.hasOwnProperty.call(projected_records[0], 'prefetched_info'), false);
                    assert.strictEqual(Object.prototype.hasOwnProperty.call(projected_records[0].options, 'additionalArgs'), false);
                });

                (use_local_db ? it : it.skip)('Sorts upload dates written out in words', async function() {
                    await db_api.insertRecordsIntoTable('test', [
                        {uid: 'worded-date-1', upload_date: '2022-01-01'},
                        {uid: 'worded-date-2', upload_date: 'March 5, 2021'},
                        {uid: 'worded-date-3', upload_date: '2020-01-01'}
                    ]);

                    const records = await db_api.getRecords('test', null, false, {by: 'upload_date', order: -1});
                    assert.deepStrictEqual(records.map(record => record.uid), ['worded-date-1', 'worded-date-2', 'worded-date-3']);
                });

                (use_local_db ? it : it.skip)('Adds more records than one local write takes', async function() {
                    const records = Array.from({length: 30001}, (_, i) => ({uid: `local-batch-${i}`}));

                    try {
                        assert(await db_api.insertRecordsIntoTable('test', records));
                        assert.strictEqual(await db_api.getRecords('test', null, true), 30001);
                        assert.strictEqual((await db_api.getRecord('test', {uid: 'local-batch-30000'})).uid, 'local-batch-30000');
                    } finally {
                        // Every later write rewrites the whole local file, so do not leave these in it.
                        await db_api.removeAllRecords('test');
                    }
                });

                it.skip('Query speed', async function() {
                    this.timeout(120000); 
                    const NUM_RECORDS_TO_ADD = 300004; // max batch ops is 1000
                    const test_records = [];
                    let random_uid = '06241f83-d1b8-4465-812c-618dfa7f2943';
                    for (let i = 0; i < NUM_RECORDS_TO_ADD; i++) {
                        const uid = uuid();
                        if (i === NUM_RECORDS_TO_ADD/2) random_uid = uid;
                        test_records.push({"id":"RandomTextRandomText","title":"RandomTextRandomTextRandomTextRandomTextRandomTextRandomTextRandomTextRandomText","thumbnailURL":"https://i.ytimg.com/vi/randomurl/maxresdefault.jpg","isAudio":true,"duration":312,"url":"https://www.youtube.com/watch?v=randomvideo","uploader":"randomUploader","size":5060157,"path":"audio\\RandomTextRandomText.mp3","upload_date":"2016-05-11","description":"RandomTextRandomTextRandomTextRandomTextRandomTextRandomTextRandomTextRandomTextRandomTextRandomTextRandomTextRandomText","view_count":118689353,"height":null,"abr":160,"uid": uid,"registered":1626672120632});
                    }
                    const insert_start = Date.now();
                    await db_api.bulkInsertRecordsIntoTable('test', test_records);
                    const insert_end = Date.now();

                    console.log(`Insert time: ${(insert_end - insert_start)/1000}s`);

                    const query_start = Date.now();
                    const random_record = await db_api.getRecord('test', {uid: random_uid});
                    const query_end = Date.now();

                    console.log(random_record)

                    console.log(`Query time: ${(query_end - query_start)/1000}s`);

                    const success = !!random_record;

                    assert(success);
                });
            });
        }
    });

    describe('Local DB Filters', async function() {
        it('Basic', async function() {
            const result = db_api.applyFilterLocalDB([{test: 'test'}, {test: 'test1'}], {test: 'test'}, 'find');
            assert(result && result['test'] === 'test');
        });

        it('Regex', async function() {
            const filter = {$regex: `\\w+\\d`, $options: 'i'};
            const result = db_api.applyFilterLocalDB([{test: 'test'}, {test: 'test1'}], {test: filter}, 'find');
            assert(result && result['test'] === 'test1');
        });

        it('Not equals', async function() {
            const filter = {$ne: 'test'};
            const result = db_api.applyFilterLocalDB([{test: 'test'}, {test: 'test1'}], {test: filter}, 'find');
            assert(result && result['test'] === 'test1');
        });

        it('Nested', async function() {
            const result = db_api.applyFilterLocalDB([{test1: {test2: 'test3'}}, {test4: 'test5'}], {'test1.test2': 'test3'}, 'find');
            assert(result && result['test1']['test2'] === 'test3');
        });

        it('Ranges and membership', async function() {
            const records = [{n: 1}, {n: 2}, {n: 3}, {}];
            assert.deepStrictEqual(db_api.applyFilterLocalDB(records, {n: {$gt: 1}}, 'filter'), [{n: 2}, {n: 3}]);
            assert.deepStrictEqual(db_api.applyFilterLocalDB(records, {n: {$gte: 2}}, 'filter'), [{n: 2}, {n: 3}]);
            assert.deepStrictEqual(db_api.applyFilterLocalDB(records, {n: {$lt: 2}}, 'filter'), [{n: 1}]);
            assert.deepStrictEqual(db_api.applyFilterLocalDB(records, {n: {$lte: 2}}, 'filter'), [{n: 1}, {n: 2}]);
            assert.deepStrictEqual(db_api.applyFilterLocalDB(records, {n: {$in: [1, 3]}}, 'filter'), [{n: 1}, {n: 3}]);
        });

        it('Nested path through a null or primitive value', async function() {
            const records = [{test1: null}, {test1: 'flat'}, {test1: {test2: 'test3'}}];
            const result = db_api.applyFilterLocalDB(records, {'test1.test2': 'test3'}, 'find');
            assert(result && result['test1']['test2'] === 'test3');
            const regex_result = db_api.applyFilterLocalDB(records, {'test1.test2': {$regex: 'test'}}, 'filter');
            assert.strictEqual(regex_result.length, 1);
        });
    })
});
