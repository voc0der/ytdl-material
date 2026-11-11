const { assert, archive_api, db_api, config_api, fs, path, useTemporaryMediaRoots } = require('./test-shared');

describe('Archive', async function() {
    let roots;

    beforeEach(async function() {
        roots = useTemporaryMediaRoots({ytdl_multi_user_mode: false});
        await db_api.removeAllRecords('archives');
    });

    afterEach(async function() {
        try {
            await db_api.removeAllRecords('archives');
        } finally {
            roots.restore();
        }
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

    describe('User isolation', function() {
        beforeEach(function() {
            config_api.setConfigItem('ytdl_multi_user_mode', true);
        });

        it('keeps matching entries for different users when replacing a duplicate', async function() {
            await archive_api.addToArchive('site', 'shared', 'video', 'Alice original', 'alice');
            await archive_api.addToArchive('site', 'shared', 'video', 'Bob original', 'bob');
            await archive_api.addToArchive('site', 'shared', 'video', 'Alice updated', 'alice');

            const records = await db_api.getRecords('archives');
            assert.strictEqual(records.length, 2);
            assert.strictEqual(records.find(record => record.user_uid === 'alice').title, 'Alice updated');
            assert.strictEqual(records.find(record => record.user_uid === 'bob').title, 'Bob original');
        });

        it('exports only the requested user, subscription, and media type', async function() {
            await archive_api.addToArchive('site', 'video', 'video', 'Video', 'alice', 'sub');
            await archive_api.addToArchive('site', 'audio', 'audio', 'Audio', 'alice', 'sub');
            await archive_api.addToArchive('site', 'other-user', 'video', 'Other user', 'bob', 'sub');
            await archive_api.addToArchive('site', 'other-sub', 'video', 'Other subscription', 'alice', 'other');
            await archive_api.addToArchive('site', 'library', 'video', 'Library', 'alice');

            assert.strictEqual(await archive_api.generateArchive('video', 'alice', 'sub'), 'site video');
            assert.deepStrictEqual((await archive_api.generateArchive(null, 'alice', 'sub')).split('\n').sort(),
                ['site audio', 'site video']);
            assert.strictEqual(await archive_api.generateArchive('video', 'alice'), 'site library');
            assert.strictEqual(await archive_api.generateArchive('video', 'carol', 'sub'), '');
        });

        it('checks and removes entries without affecting another user, subscription, or media type', async function() {
            for (const [type, user, sub] of [
                ['video', 'alice', 'sub'], ['video', 'bob', 'sub'],
                ['audio', 'alice', 'sub'], ['video', 'alice', 'other']
            ]) {
                await archive_api.addToArchive('site', 'shared', type, 'Title', user, sub);
            }

            assert.strictEqual(await archive_api.existsInArchive('site', 'shared', 'video', 'carol', 'sub'), false);
            assert.strictEqual(await archive_api.existsInArchive('site', 'shared', 'video', 'alice', 'sub'), true);
            assert.strictEqual(await archive_api.removeFromArchive('site', 'shared', 'video', 'alice', 'sub'), true);
            assert.strictEqual(await archive_api.existsInArchive('site', 'shared', 'video', 'alice', 'sub'), false);
            assert.strictEqual(await archive_api.existsInArchive('site', 'shared', 'video', 'bob', 'sub'), true);
            assert.strictEqual(await archive_api.existsInArchive('site', 'shared', 'audio', 'alice', 'sub'), true);
            assert.strictEqual(await archive_api.existsInArchive('site', 'shared', 'video', 'alice', 'other'), true);
            assert.strictEqual((await db_api.getRecords('archives')).length, 3);
        });
    });

    it('imports valid CRLF entries and ignores malformed lines without duplicating records', async function() {
        const text = '\r\nsite first\r\ninvalid\r\nsite extra fields\r\nsite  missing\r\nsite second\r\nsite first\r\n';
        assert.strictEqual(await archive_api.importArchiveFile(text, 'video', 'alice', 'sub'), 3);
        const records = await db_api.getRecords('archives');
        assert.deepStrictEqual(records.map(record => record.id).sort(), ['first', 'second']);
        assert(records.every(record => record.user_uid === 'alice' && record.sub_id === 'sub' && record.type === 'video'));
    });

    it('imports archive and blacklist files with their directory scope and tolerates missing files', async function() {
        const archive_path = path.join(roots.base, 'archives');
        await fs.ensureDir(archive_path);
        const video_archive = path.join(archive_path, 'archive_video.txt');
        const video_blacklist = path.join(archive_path, 'blacklist_video.txt');
        const audio_archive = path.join(archive_path, 'archive_audio.txt');
        await fs.writeFile(video_archive, 'site downloaded\n');
        await fs.writeFile(video_blacklist, 'site blocked\n');
        await fs.writeFile(audio_archive, 'site audio\n');

        const original_get_directories = db_api.getFileDirectoriesAndDBs;
        db_api.getFileDirectoriesAndDBs = async () => [
            {type: 'video'},
            {archive_path: path.join(roots.base, 'missing'), type: 'video'},
            {archive_path, type: 'video', user_uid: 'alice', sub_id: 'sub'},
            {archive_path, type: 'audio'}
        ];
        try {
            assert.deepStrictEqual(await archive_api.importArchives(), [video_archive, video_blacklist, audio_archive]);
            await archive_api.importArchives();
            const records = await db_api.getRecords('archives');
            assert.deepStrictEqual(records.map(({id, type, user_uid, sub_id}) => ({id, type, user_uid, sub_id})), [
                {id: 'downloaded', type: 'video', user_uid: 'alice', sub_id: 'sub'},
                {id: 'blocked', type: 'video', user_uid: 'alice', sub_id: 'sub'},
                {id: 'audio', type: 'audio', user_uid: null, sub_id: null}
            ]);
        } finally {
            db_api.getFileDirectoriesAndDBs = original_get_directories;
        }
    });
});

