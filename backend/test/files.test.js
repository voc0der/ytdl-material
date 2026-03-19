/* eslint-disable no-undef */
const { assert, fs, path, files_api, config_api, db_api } = require('./test-shared');

describe('Files', function() {
    const fixture_dir = path.join(__dirname, 'tmp-files-test');
    const fixture_file_path = path.join(fixture_dir, 'chapter-video.mp4');
    const fixture_info_path = path.join(fixture_dir, 'chapter-video.info.json');

    beforeEach(async function() {
        await fs.ensureDir(fixture_dir);
    });

    afterEach(async function() {
        await fs.remove(fixture_dir);
    });

    it('attachFileChapters parses valid chapters from sidecar metadata', async function() {
        await fs.writeJSON(fixture_info_path, {
            chapters: [
                {title: 'Intro', start_time: 0, end_time: 45},
                {title: 'Main Part', start_time: 45, end_time: 120},
                {title: '', start_time: 120, end_time: 180},
                {title: 'Invalid Range', start_time: 180, end_time: 170}
            ]
        });

        const output = files_api.attachFileChapters({
            path: fixture_file_path,
            isAudio: false
        });

        assert.deepStrictEqual(output.chapters, [
            {title: 'Intro', start_time: 0, end_time: 45},
            {title: 'Main Part', start_time: 45, end_time: 120}
        ]);
    });

    it('attachFileChaptersCollection returns empty chapters when metadata is missing', function() {
        const output = files_api.attachFileChaptersCollection([{
            path: path.join(fixture_dir, 'missing-video.mp4'),
            isAudio: false
        }]);

        assert.deepStrictEqual(output[0].chapters, []);
    });

    it('deleteFileObject destroys active descriptors using the file uid key', async function() {
        const original_remove_record = db_api.removeRecord;
        const descriptor_uid = 'descriptor-file';
        let destroyed_count = 0;

        try {
            await fs.writeFile(fixture_file_path, 'fixture');
            db_api.removeRecord = async () => true;
            config_api.descriptors[descriptor_uid] = [
                {destroy: () => { destroyed_count += 1; }},
                {destroy: () => { destroyed_count += 1; }}
            ];

            const output = await files_api.deleteFileObject({
                uid: descriptor_uid,
                id: 'chapter-video',
                path: fixture_file_path,
                isAudio: false,
                title: 'Fixture video'
            });

            assert.strictEqual(output, true);
            assert.strictEqual(destroyed_count, 2);
            assert.strictEqual(await fs.pathExists(fixture_file_path), false);
        } finally {
            delete config_api.descriptors[descriptor_uid];
            db_api.removeRecord = original_remove_record;
        }
    });

    it('deleteFilesInBatches deduplicates playlist files and caps batch concurrency', async function() {
        const original_get_videos_by_uids = files_api.getVideosByUIDs;
        const original_delete_file_object = files_api.deleteFileObject;
        const deleted_uids = [];
        let active_deletes = 0;
        let max_active_deletes = 0;

        try {
            files_api.getVideosByUIDs = async (uids, user_uid) => {
                assert.deepStrictEqual(uids, ['file-1', 'file-2', 'missing', 'file-3']);
                assert.strictEqual(user_uid, 'user-1');
                return uids
                    .filter(uid => uid !== 'missing')
                    .map(uid => ({uid: uid}));
            };

            files_api.deleteFileObject = async (file_obj) => {
                active_deletes += 1;
                max_active_deletes = Math.max(max_active_deletes, active_deletes);
                await new Promise(resolve => setTimeout(resolve, 5));
                active_deletes -= 1;
                deleted_uids.push(file_obj.uid);
                return file_obj.uid !== 'file-2';
            };

            const output = await files_api.deleteFilesInBatches(
                ['file-1', 'file-2', 'file-1', 'missing', 'file-3'],
                false,
                'user-1',
                2
            );

            assert.deepStrictEqual(deleted_uids.sort(), ['file-1', 'file-2', 'file-3']);
            assert.strictEqual(max_active_deletes, 2);
            assert.deepStrictEqual(output, {deleted_count: 2, failed_count: 1});
        } finally {
            files_api.getVideosByUIDs = original_get_videos_by_uids;
            files_api.deleteFileObject = original_delete_file_object;
        }
    });

    it('deleteFilesInBatches counts thrown delete failures and continues later batches', async function() {
        const original_get_videos_by_uids = files_api.getVideosByUIDs;
        const original_delete_file_object = files_api.deleteFileObject;
        const attempted_uids = [];

        try {
            files_api.getVideosByUIDs = async () => [{uid: 'file-1'}, {uid: 'file-2'}, {uid: 'file-3'}];
            files_api.deleteFileObject = async (file_obj) => {
                attempted_uids.push(file_obj.uid);
                if (file_obj.uid === 'file-2') {
                    throw new Error('disk error');
                }
                return true;
            };

            const output = await files_api.deleteFilesInBatches(['file-1', 'file-2', 'file-3'], false, null, 2);

            assert.deepStrictEqual(attempted_uids, ['file-1', 'file-2', 'file-3']);
            assert.deepStrictEqual(output, {deleted_count: 2, failed_count: 1});
        } finally {
            files_api.getVideosByUIDs = original_get_videos_by_uids;
            files_api.deleteFileObject = original_delete_file_object;
        }
    });

    it('uses regex title filtering for PostgreSQL-style text search', async function() {
        const original_get_records = db_api.getRecords;
        const original_is_using_local_db = db_api.isUsingLocalDB;
        const original_is_using_mongo_db = db_api.isUsingMongoDB;
        const captured_filters = [];

        try {
            db_api.isUsingLocalDB = () => false;
            db_api.isUsingMongoDB = () => false;
            db_api.getRecords = async (table, filter_obj, return_count) => {
                captured_filters.push({table, filter_obj, return_count});
                return return_count ? 0 : [];
            };

            await files_api.getAllFiles({by: 'registered', order: -1}, [0, 20], 'science', 'both', false, null, null);

            assert.strictEqual(captured_filters.length, 2);
            assert.deepStrictEqual(captured_filters[0].filter_obj, {
                title: {$regex: 'science', $options: 'i'}
            });
            assert.strictEqual(captured_filters[0].return_count, false);
            assert.deepStrictEqual(captured_filters[1].filter_obj, {
                title: {$regex: 'science', $options: 'i'}
            });
            assert.strictEqual(captured_filters[1].return_count, true);
        } finally {
            db_api.getRecords = original_get_records;
            db_api.isUsingLocalDB = original_is_using_local_db;
            db_api.isUsingMongoDB = original_is_using_mongo_db;
        }
    });
});
