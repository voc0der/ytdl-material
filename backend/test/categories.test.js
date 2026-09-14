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

    it('Categorize - source category arrays', async function() {
        await db_api.removeAllRecords('categories');
        try {
            const new_category = {
                name: 'Music',
                uid: uuid(),
                rules: [{
                    preceding_operator: null,
                    comparator: 'includes',
                    property: 'categories',
                    value: 'Music'
                }],
                custom_output: ''
            };
            await db_api.insertRecordIntoTable('categories', new_category);

            const category = await categories_api.categorize([{
                ...sample_video_json,
                categories: ['Music']
            }]);
            assert(category && category.name === 'Music');
        } finally {
            await db_api.removeAllRecords('categories');
        }
    });

    it('Categories as playlists - carries a file count', async function() {
        const category = await db_api.getRecord('categories', {name: 'test_category'});
        const categorized_uids = ['category-count-1', 'category-count-2', 'category-count-3'];
        try {
            for (const categorized_uid of categorized_uids) {
                await db_api.insertRecordIntoTable('files', {
                    ...sample_video_json,
                    uid: categorized_uid,
                    category: {uid: category['uid'], name: category['name']}
                });
            }

            const categories_as_playlists = await categories_api.getCategoriesAsPlaylists();
            const category_playlist = categories_as_playlists.find(playlist => playlist['name'] === 'test_category');

            // A category has no uids array, so the count is the only way a caller can say
            // how much it holds.
            assert(category_playlist);
            assert.strictEqual(category_playlist['uids'], undefined);
            assert.strictEqual(category_playlist['file_count'], categorized_uids.length);
        } finally {
            await db_api.removeAllRecords('files', {uid: {$in: categorized_uids}});
        }
    });

    it('Create default categories', async function() {
        await db_api.removeAllRecords('categories');
        try {
            const categories = await categories_api.createDefaultCategories();
            const saved_categories = await db_api.getRecords('categories');
            const music_category = saved_categories.find(category => category.name === 'Music');

            assert(categories.length >= 10);
            assert.strictEqual(saved_categories.length, categories.length);
            assert(music_category);
            assert(music_category.rules.some(category_rule => category_rule.property === 'categories' && category_rule.value === 'Music'));
            assert.strictEqual(music_category.rules[0].preceding_operator, null);
            assert.strictEqual(music_category.show_as_filter, false);
        } finally {
            await db_api.removeAllRecords('categories');
        }
    });
});
