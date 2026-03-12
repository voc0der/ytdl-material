/* eslint-disable no-undef */
const { assert, uuid, db_api, categories_api, sample_video_json } = require('./test-shared');

describe('Categories', async function() {
    beforeEach(async function() {
        // await db_api.connectToDB();
        const new_category = {
            name: 'test_category',
            uid: uuid(),
            rules: [],
            custom_output: ''
        };
        await db_api.removeAllRecords('categories', {name: 'test_category'});
        await db_api.insertRecordIntoTable('categories', new_category);
    });

    afterEach(async function() {
        await db_api.removeAllRecords('categories', {name: 'test_category'});
    });

    it('Categorize - includes', async function() {
        await db_api.pushToRecordsArray('categories', {name: 'test_category'}, 'rules', {
            preceding_operator: null,
            comparator: 'includes',
            property: 'title',
            value: 'Sample'
        });

        const category = await categories_api.categorize([sample_video_json]);
        assert(category && category.name === 'test_category');
    });

    it('Categorize - not includes', async function() {
        await db_api.pushToRecordsArray('categories', {name: 'test_category'}, 'rules', {
            preceding_operator: null,
            comparator: 'not_includes',
            property: 'title',
            value: 'Sample'
        });

        const category = await categories_api.categorize([sample_video_json]);
        assert(!category);
    });

    it('Categorize - equals', async function() {
        await db_api.pushToRecordsArray('categories', {name: 'test_category'}, 'rules', {
            preceding_operator: null,
            comparator: 'equals',
            property: 'uploader',
            value: 'Sample Uploader'
        });

        const category = await categories_api.categorize([sample_video_json]);
        assert(category && category.name === 'test_category');
    });

    it('Categorize - not equals', async function() {
        await db_api.pushToRecordsArray('categories', {name: 'test_category'}, 'rules', {
            preceding_operator: null,
            comparator: 'not_equals',
            property: 'uploader',
            value: 'Sample Uploader'
        });

        const category = await categories_api.categorize([sample_video_json]);
        assert(!category);
    });

    it('Categorize - AND', async function() {
        await db_api.pushToRecordsArray('categories', {name: 'test_category'}, 'rules', {
            preceding_operator: null,
            comparator: 'equals',
            property: 'uploader',
            value: 'Sample Uploader'
        });

        await db_api.pushToRecordsArray('categories', {name: 'test_category'}, 'rules', {
            preceding_operator: 'and',
            comparator: 'not_includes',
            property: 'title',
            value: 'Sample'
        });

        const category = await categories_api.categorize([sample_video_json]);
        assert(!category);
    });

    it('Categorize - OR', async function() {
        await db_api.pushToRecordsArray('categories', {name: 'test_category'}, 'rules', {
            preceding_operator: null,
            comparator: 'equals',
            property: 'uploader',
            value: 'Sample Uploader'
        });

        await db_api.pushToRecordsArray('categories', {name: 'test_category'}, 'rules', {
            preceding_operator: 'or',
            comparator: 'not_includes',
            property: 'title',
            value: 'Sample'
        });

        const category = await categories_api.categorize([sample_video_json]);
        assert(category);
    });
});

