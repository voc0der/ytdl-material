/* eslint-disable no-undef */
const { assert, uuid, db_api } = require('./test-shared');

describe('Database', async function() {
    describe.skip('Import', async function() {
        // it('Migrate', async function() {
        //     // await db_api.connectToDB();
        //     await db_api.removeAllRecords();
        //     const success = await db_api.importJSONToDB(db.value(), users_db.value());
        //     assert(success);
        // });

        it('Transfer to remote', async function() {
            await db_api.removeAllRecords('test');
            await db_api.insertRecordIntoTable('test', {test: 'test'});

            await db_api.transferDB(true);
            const success = await db_api.getRecord('test', {test: 'test'});
            assert(success);
        });

        it('Transfer to local', async function() {
            // await db_api.connectToDB();
            await db_api.removeAllRecords('test');
            await db_api.insertRecordIntoTable('test', {test: 'test'});

            await db_api.transferDB(false);
            const success = await db_api.getRecord('test', {test: 'test'});
            assert(success);
        });

        it('Restore db', async function() {
            const db_stats = await db_api.getDBStats();
            
            const file_name = await db_api.backupDB();
            await db_api.restoreDB(file_name);

            const new_db_stats = await db_api.getDBStats();

            assert(JSON.stringify(db_stats), JSON.stringify(new_db_stats));
        });
    });

    describe('Basic functions', async function() {
        
        // test both local_db and remote_db
        const local_db_modes = [false, true];

        for (const local_db_mode of local_db_modes) {
            let use_local_db = local_db_mode;
            const describe_skippable = use_local_db ? describe : describe.skip;
            describe_skippable(`Use local DB - ${use_local_db}`, async function() {
                beforeEach(async function() {
                    if (!use_local_db) {
                        this.timeout(120000);
                        await db_api.connectToDB(0);
                    }
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
                    const stats = await db_api.getDBStats();
                    assert(stats);
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
                    let success = await db_api.bulkInsertRecordsIntoTable('test', test_records);
                    const insert_end = Date.now();

                    console.log(`Insert time: ${(insert_end - insert_start)/1000}s`);

                    const query_start = Date.now();
                    const random_record = await db_api.getRecord('test', {uid: random_uid});
                    const query_end = Date.now();

                    console.log(random_record)

                    console.log(`Query time: ${(query_end - query_start)/1000}s`);

                    success = !!random_record;

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
    })
});
