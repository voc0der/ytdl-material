/* eslint-disable no-undef */
const { assert, archive_api, db_api } = require('./test-shared');

describe('Archive', async function() {
    beforeEach(async function() {
        // await db_api.connectToDB();
        await db_api.removeAllRecords('archives');
    });

    afterEach(async function() {
        await db_api.removeAllRecords('archives');
    });

    it('Import archive', async function() {
        const archive_text = `
            testextractor1 testing1
            testextractor1 testing2
            testextractor2 testing1
            testextractor1 testing3

        `;
        const count = await archive_api.importArchiveFile(archive_text, 'video', 'test_user', 'test_sub');
        assert(count === 4)
        const archive_items = await db_api.getRecords('archives', {user_uid: 'test_user', sub_id: 'test_sub'});
        assert(archive_items.length === 4);
        assert(archive_items.filter(archive_item => archive_item.extractor === 'testextractor2').length === 1);
        assert(archive_items.filter(archive_item => archive_item.extractor === 'testextractor1').length === 3);

        const success = await db_api.removeAllRecords('archives', {user_uid: 'test_user', sub_id: 'test_sub'});
        assert(success);
    });

    it('Get archive', async function() {
        await archive_api.addToArchive('testextractor1', 'testing1', 'video', 'test_user');
        await archive_api.addToArchive('testextractor2', 'testing1', 'video', 'test_user');

        const archive_item1 = await db_api.getRecord('archives', {extractor: 'testextractor1', id: 'testing1'});
        const archive_item2 = await db_api.getRecord('archives', {extractor: 'testextractor2', id: 'testing1'});

        assert(archive_item1 && archive_item2);
    });

    it('Archive duplicates', async function() {
        await archive_api.addToArchive('testextractor1', 'testing1', 'video', 'test_user');
        await archive_api.addToArchive('testextractor2', 'testing1', 'video', 'test_user');
        await archive_api.addToArchive('testextractor2', 'testing1', 'video', 'test_user');

        await archive_api.addToArchive('testextractor1', 'testing1', 'audio', 'test_user');

        const count = await db_api.getRecords('archives', {id: 'testing1'}, true);
        assert(count === 3);
    });

    it('Remove from archive', async function() {
        await archive_api.addToArchive('testextractor1', 'testing1', 'video', 'test_title', 'test_user');
        await archive_api.addToArchive('testextractor2', 'testing1', 'video', 'test_title', 'test_user');
        await archive_api.addToArchive('testextractor2', 'testing2', 'video', 'test_title', 'test_user');

        const success = await archive_api.removeFromArchive('testextractor2', 'testing1', 'video', 'test_user');
        assert(success);

        const archive_item1 = await db_api.getRecord('archives', {extractor: 'testextractor1', id: 'testing1'});
        assert(!!archive_item1);
        
        const archive_item2 = await db_api.getRecord('archives', {extractor: 'testextractor2', id: 'testing1'});
        assert(!archive_item2);

        const archive_item3 = await db_api.getRecord('archives', {extractor: 'testextractor2', id: 'testing2'});
        assert(!!archive_item3);
    });
});

