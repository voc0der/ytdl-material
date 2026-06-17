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

    it('attachFileChapters adjusts chapter timestamps around SponsorBlock cuts', async function() {
        await fs.writeJSON(fixture_info_path, {
            duration: 100,
            chapters: [
                {title: 'Intro', start_time: 0, end_time: 30},
                {title: 'Main Part', start_time: 30, end_time: 70},
                {title: 'Outro', start_time: 70, end_time: 100}
            ],
            sponsorblock_chapters: [
                {start_time: 10, end_time: 20, category: 'sponsor', type: 'skip'},
                {start_time: 15, end_time: 25, category: 'sponsor', type: 'skip'},
                {start_time: 50, end_time: 60, category: 'sponsor', type: 'skip'},
                {start_time: 80, end_time: 90, category: 'selfpromo', type: 'skip'}
            ]
        });

        const output = files_api.attachFileChapters({
            path: fixture_file_path,
            duration: 100,
            isAudio: false
        });

        assert.strictEqual(output.duration, 75);
        assert.deepStrictEqual(output.chapters, [
            {title: 'Intro', start_time: 0, end_time: 15},
            {title: 'Main Part', start_time: 15, end_time: 45},
            {title: 'Outro', start_time: 45, end_time: 75}
        ]);
    });

    it('registerFileDB stores SponsorBlock-adjusted duration', async function() {
        const original_include_metadata = config_api.getConfigItem('ytdl_include_metadata');

        try {
            config_api.setConfigItem('ytdl_include_metadata', true);
            await db_api.removeAllRecords('files', {path: fixture_file_path});
            await fs.writeFile(fixture_file_path, 'fixture');
            await fs.writeJSON(fixture_info_path, {
                id: 'chapter-video',
                title: 'Chapter Video',
                thumbnail: 'https://example.com/thumb.jpg',
                duration: 100,
                webpage_url: 'https://www.youtube.com/watch?v=chapter',
                uploader: 'Uploader',
                upload_date: '20200101',
                description: 'Fixture description',
                view_count: 1,
                height: 720,
                abr: null,
                extractor: 'youtube',
                sponsorblock_chapters: [
                    {start_time: 10, end_time: 20, category: 'sponsor', type: 'skip'},
                    {start_time: 50, end_time: 60, category: 'sponsor', type: 'skip'}
                ]
            });

            const output = await files_api.registerFileDB(fixture_file_path, 'video');

            assert(output);
            assert.strictEqual(output.duration, 80);
        } finally {
            config_api.setConfigItem('ytdl_include_metadata', original_include_metadata);
            await db_api.removeAllRecords('files', {path: fixture_file_path});
        }
    });

    it('attachFileChaptersCollection returns empty chapters when metadata is missing', function() {
        const output = files_api.attachFileChaptersCollection([{
            path: path.join(fixture_dir, 'missing-video.mp4'),
            isAudio: false
        }]);

        assert.deepStrictEqual(output[0].chapters, []);
    });

    it('attachFileSubtitles exposes requested subtitle metadata when a player sidecar exists', async function() {
        await fs.writeJSON(fixture_info_path, {
            requested_subtitles: {
                en: {
                    name: 'English'
                }
            }
        });
        await fs.writeFile(files_api.getSubtitleSidecarPath(fixture_file_path), 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n');

        const output = await files_api.attachFileSubtitles({
            path: fixture_file_path,
            isAudio: false
        });

        assert.deepStrictEqual(output.subtitles, [
            {
                language: 'en',
                label: 'English',
                kind: 'subtitles',
                default: true
            }
        ]);
    });

    it('attachFileSubtitles exposes requested subtitle metadata before a player sidecar exists', async function() {
        await fs.writeJSON(fixture_info_path, {
            requested_subtitles: {
                en: {
                    name: 'English'
                }
            }
        });

        const output = await files_api.attachFileSubtitles({
            path: fixture_file_path,
            isAudio: false
        });

        assert.deepStrictEqual(output.subtitles, [
            {
                language: 'en',
                label: 'English',
                kind: 'subtitles',
                default: true
            }
        ]);
    });

    it('deleteFileObject destroys active descriptors using the file uid key', async function() {
        const original_remove_record = db_api.removeRecord;
        const descriptor_uid = 'descriptor-file';
        let destroyed_count = 0;

        try {
            await fs.writeFile(fixture_file_path, 'fixture');
            await fs.writeFile(files_api.getSubtitleSidecarPath(fixture_file_path), 'WEBVTT');
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
            assert.strictEqual(await fs.pathExists(files_api.getSubtitleSidecarPath(fixture_file_path)), false);
        } finally {
            delete config_api.descriptors[descriptor_uid];
            db_api.removeRecord = original_remove_record;
        }
    });

    it('deleteFileObject removes media from disk when the DB path is stale', async function() {
        const original_get_file_directories = db_api.getFileDirectoriesAndDBs;
        const original_remove_record = db_api.removeRecord;
        const actual_file_path = path.join(fixture_dir, 'stale-video.mp4');
        const stale_file_path = path.join(fixture_dir, 'old-location', 'stale-video.mp4');
        const actual_info_path = path.join(fixture_dir, 'stale-video.info.json');
        const actual_thumbnail_path = path.join(fixture_dir, 'stale-video.webp');
        let removed_filter = null;

        try {
            await fs.writeFile(actual_file_path, 'fixture');
            await fs.writeFile(actual_info_path, '{}');
            await fs.writeFile(actual_thumbnail_path, 'thumbnail');
            db_api.getFileDirectoriesAndDBs = async () => [{
                basePath: fixture_dir,
                type: 'video'
            }];
            db_api.removeRecord = async (table, filter_obj) => {
                assert.strictEqual(table, 'files');
                removed_filter = filter_obj;
                return true;
            };

            const output = await files_api.deleteFileObject({
                uid: 'stale-file',
                id: 'stale-video',
                path: stale_file_path,
                isAudio: false,
                title: 'Stale video'
            });

            assert.strictEqual(output, true);
            assert.deepStrictEqual(removed_filter, {uid: 'stale-file'});
            assert.strictEqual(await fs.pathExists(actual_file_path), false);
            assert.strictEqual(await fs.pathExists(actual_info_path), false);
            assert.strictEqual(await fs.pathExists(actual_thumbnail_path), false);
        } finally {
            db_api.getFileDirectoriesAndDBs = original_get_file_directories;
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

    it('deleteOrphanFiles removes unregistered media files and sidecars from disk', async function() {
        const original_get_file_directories = db_api.getFileDirectoriesAndDBs;
        const original_get_records = db_api.getRecords;
        const orphan_file_path = path.join(fixture_dir, 'orphan-video.mp4');
        const registered_file_path = path.join(fixture_dir, 'registered-video.mp4');
        const orphan_info_path = path.join(fixture_dir, 'orphan-video.info.json');
        const orphan_thumbnail_path = path.join(fixture_dir, 'orphan-video.jpg');
        const orphan_subtitle_path = files_api.getSubtitleSidecarPath(orphan_file_path);

        try {
            await fs.writeFile(orphan_file_path, 'orphan media');
            await fs.writeFile(orphan_info_path, '{}');
            await fs.writeFile(orphan_thumbnail_path, 'thumbnail');
            await fs.writeFile(orphan_subtitle_path, 'WEBVTT');
            await fs.writeFile(registered_file_path, 'registered media');

            db_api.getFileDirectoriesAndDBs = async () => [{
                basePath: fixture_dir,
                type: 'video'
            }];
            db_api.getRecords = async (table) => {
                assert.strictEqual(table, 'files');
                return [{uid: 'registered-file', path: registered_file_path}];
            };

            const output = await files_api.deleteOrphanFiles();

            assert.deepStrictEqual(output, {deleted_count: 1, failed_count: 0});
            assert.strictEqual(await fs.pathExists(orphan_file_path), false);
            assert.strictEqual(await fs.pathExists(orphan_info_path), false);
            assert.strictEqual(await fs.pathExists(orphan_thumbnail_path), false);
            assert.strictEqual(await fs.pathExists(orphan_subtitle_path), false);
            assert.strictEqual(await fs.pathExists(registered_file_path), true);
        } finally {
            db_api.getFileDirectoriesAndDBs = original_get_file_directories;
            db_api.getRecords = original_get_records;
        }
    });

    it('deleteOrphanFiles removes sidecar-only orphan groups from disk', async function() {
        const original_get_file_directories = db_api.getFileDirectoriesAndDBs;
        const original_get_records = db_api.getRecords;
        const sidecar_info_path = path.join(fixture_dir, 'sidecar-only.info.json');
        const sidecar_thumbnail_path = path.join(fixture_dir, 'sidecar-only.webp');
        const sidecar_subtitle_path = files_api.getSubtitleSidecarPath(path.join(fixture_dir, 'sidecar-only.mp4'));

        try {
            await fs.writeFile(sidecar_info_path, '{}');
            await fs.writeFile(sidecar_thumbnail_path, 'thumbnail');
            await fs.writeFile(sidecar_subtitle_path, 'WEBVTT');

            db_api.getFileDirectoriesAndDBs = async () => [{
                basePath: fixture_dir,
                type: 'video'
            }];
            db_api.getRecords = async (table) => {
                assert.strictEqual(table, 'files');
                return [];
            };

            const output = await files_api.deleteOrphanFiles();

            assert.deepStrictEqual(output, {deleted_count: 1, failed_count: 0});
            assert.strictEqual(await fs.pathExists(sidecar_info_path), false);
            assert.strictEqual(await fs.pathExists(sidecar_thumbnail_path), false);
            assert.strictEqual(await fs.pathExists(sidecar_subtitle_path), false);
        } finally {
            db_api.getFileDirectoriesAndDBs = original_get_file_directories;
            db_api.getRecords = original_get_records;
        }
    });

    it('deleteOrphanFiles scans legacy single-user and unassigned subscription dirs in multi-user mode', async function() {
        const original_get_file_directories = db_api.getFileDirectoriesAndDBs;
        const original_get_records = db_api.getRecords;
        const original_multi_user_mode = config_api.getConfigItem('ytdl_multi_user_mode');
        const original_audio_folder_path = config_api.getConfigItem('ytdl_audio_folder_path');
        const original_video_folder_path = config_api.getConfigItem('ytdl_video_folder_path');
        const legacy_audio_dir = path.join(fixture_dir, 'legacy-audio');
        const legacy_video_dir = path.join(fixture_dir, 'legacy-video');
        const user_video_dir = path.join(fixture_dir, 'users', 'user-1', 'video');
        const other_user_video_dir = path.join(fixture_dir, 'users', 'user-2', 'video');
        const unassigned_subscription_dir = path.join(fixture_dir, 'subscriptions', 'playlists', 'deleted-playlist');
        const legacy_orphan_path = path.join(legacy_video_dir, 'legacy-orphan.mp4');
        const legacy_info_path = path.join(legacy_video_dir, 'legacy-orphan.info.json');
        const subscription_orphan_path = path.join(unassigned_subscription_dir, 'subscription-orphan.mp4');
        const registered_user_path = path.join(user_video_dir, 'registered-user-video.mp4');
        const other_user_path = path.join(other_user_video_dir, 'other-user-video.mp4');

        try {
            config_api.setConfigItem('ytdl_multi_user_mode', true);
            config_api.setConfigItem('ytdl_audio_folder_path', legacy_audio_dir);
            config_api.setConfigItem('ytdl_video_folder_path', legacy_video_dir);
            await fs.outputFile(legacy_orphan_path, 'legacy orphan media');
            await fs.outputFile(legacy_info_path, '{}');
            await fs.outputFile(subscription_orphan_path, 'subscription orphan media');
            await fs.outputFile(registered_user_path, 'registered user media');
            await fs.outputFile(other_user_path, 'other user media');

            db_api.getFileDirectoriesAndDBs = async () => [
                {
                    basePath: user_video_dir,
                    user_uid: 'user-1',
                    type: 'video'
                },
                {
                    basePath: other_user_video_dir,
                    user_uid: 'user-2',
                    type: 'video'
                },
                {
                    basePath: unassigned_subscription_dir,
                    user_uid: undefined,
                    type: 'video',
                    sub_id: 'deleted-playlist'
                }
            ];
            db_api.getRecords = async (table, filter_obj) => {
                assert.strictEqual(table, 'files');
                assert.deepStrictEqual(filter_obj, {user_uid: 'user-1'});
                return [{uid: 'registered-user-video', path: registered_user_path, user_uid: 'user-1'}];
            };

            const output = await files_api.deleteOrphanFiles('user-1');

            assert.deepStrictEqual(output, {deleted_count: 2, failed_count: 0});
            assert.strictEqual(await fs.pathExists(legacy_orphan_path), false);
            assert.strictEqual(await fs.pathExists(legacy_info_path), false);
            assert.strictEqual(await fs.pathExists(subscription_orphan_path), false);
            assert.strictEqual(await fs.pathExists(registered_user_path), true);
            assert.strictEqual(await fs.pathExists(other_user_path), true);
        } finally {
            config_api.setConfigItem('ytdl_multi_user_mode', original_multi_user_mode);
            config_api.setConfigItem('ytdl_audio_folder_path', original_audio_folder_path);
            config_api.setConfigItem('ytdl_video_folder_path', original_video_folder_path);
            db_api.getFileDirectoriesAndDBs = original_get_file_directories;
            db_api.getRecords = original_get_records;
        }
    });

    it('importUnregisteredFiles imports loose media files without info JSON', async function() {
        const original_get_file_directories = db_api.getFileDirectoriesAndDBs;
        const loose_file_path = path.join(fixture_dir, 'loose-import.mp4');

        try {
            await fs.writeFile(loose_file_path, 'loose media');
            await db_api.removeAllRecords('files', {path: loose_file_path});
            db_api.getFileDirectoriesAndDBs = async () => [{
                basePath: fixture_dir,
                type: 'video'
            }];

            const imported_uids = await files_api.importUnregisteredFiles();
            const imported_file = await db_api.getRecord('files', {path: loose_file_path});

            assert(imported_file);
            assert(imported_uids.includes(imported_file.uid));
            assert.strictEqual(imported_file.title, 'loose-import');
            assert.strictEqual(imported_file.imported_without_metadata, true);
        } finally {
            db_api.getFileDirectoriesAndDBs = original_get_file_directories;
            await db_api.removeAllRecords('files', {path: loose_file_path});
        }
    });

    it('removeDuplicates removes newest or oldest duplicate files based on mode', async function() {
        const original_get_records = db_api.getRecords;
        const original_delete_file = files_api.deleteFile;
        const duplicate_files = [
            {uid: 'oldest', duplicate_key: 'duplicate-key', registered: 100, isAudio: false},
            {uid: 'middle', duplicate_key: 'duplicate-key', registered: 200, isAudio: false},
            {uid: 'newest', duplicate_key: 'duplicate-key', registered: 300, isAudio: false}
        ];
        const get_records_calls = [];
        let deleted_uids = [];

        try {
            db_api.getRecords = async (table, filter_obj, return_count, sort) => {
                get_records_calls.push({table, filter_obj, return_count, sort});
                return duplicate_files.slice();
            };
            files_api.deleteFile = async (uid, blacklistMode, user_uid) => {
                assert.strictEqual(blacklistMode, false);
                assert.strictEqual(user_uid, 'user-1');
                deleted_uids.push(uid);
                return true;
            };

            const newest_output = await files_api.removeDuplicates('duplicate-key', 'newest', 'user-1');

            assert.deepStrictEqual(newest_output, {success: true, removed_uids: ['middle', 'newest']});
            assert.deepStrictEqual(deleted_uids, ['middle', 'newest']);

            deleted_uids = [];
            const oldest_output = await files_api.removeDuplicates('duplicate-key', 'oldest', 'user-1');

            assert.deepStrictEqual(oldest_output, {success: true, removed_uids: ['oldest', 'middle']});
            assert.deepStrictEqual(deleted_uids, ['oldest', 'middle']);
            assert.strictEqual(get_records_calls.length, 2);
            assert.strictEqual(get_records_calls[0].table, 'files');
            assert.strictEqual(get_records_calls[0].filter_obj.duplicate_key, 'duplicate-key');
            assert.strictEqual(get_records_calls[0].return_count, false);
            assert.deepStrictEqual(get_records_calls[0].sort, {by: 'registered', order: 1});
        } finally {
            db_api.getRecords = original_get_records;
            files_api.deleteFile = original_delete_file;
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

    it('passes upload date sort options through to the database layer', async function() {
        const original_get_records = db_api.getRecords;
        const captured_sorts = [];

        try {
            db_api.getRecords = async (table, filter_obj, return_count, sort) => {
                captured_sorts.push({return_count, sort});
                return return_count ? 0 : [];
            };

            await files_api.getAllFiles({by: 'upload_date', order: -1}, [0, 20], null, 'both', false, null, null);

            assert.deepStrictEqual(captured_sorts, [
                {return_count: false, sort: {by: 'upload_date', order: -1}},
                {return_count: true, sort: undefined}
            ]);
        } finally {
            db_api.getRecords = original_get_records;
        }
    });

    it('filters files by selected category uids', async function() {
        const original_get_records = db_api.getRecords;
        const captured_filters = [];

        try {
            db_api.getRecords = async (table, filter_obj, return_count) => {
                captured_filters.push({table, filter_obj, return_count});
                return return_count ? 0 : [];
            };

            await files_api.getAllFiles({by: 'registered', order: -1}, [0, 20], null, 'both', false, null, null, ['cat-music', 'cat-sports']);

            assert.strictEqual(captured_filters.length, 2);
            assert.deepStrictEqual(captured_filters[0].filter_obj, {
                'category.uid': {$in: ['cat-music', 'cat-sports']}
            });
            assert.strictEqual(captured_filters[0].return_count, false);
            assert.deepStrictEqual(captured_filters[1].filter_obj, {
                'category.uid': {$in: ['cat-music', 'cat-sports']}
            });
            assert.strictEqual(captured_filters[1].return_count, true);
        } finally {
            db_api.getRecords = original_get_records;
        }
    });
});
