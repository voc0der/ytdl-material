/* eslint-disable no-undef */
const { PassThrough } = require('stream');
const {
    assert,
    path,
    fs,
    uuid,
    NodeID3,
    exec,
    logger,
    db_api,
    utils,
    subscriptions_api,
    files_api,
    youtubedl_api,
    config_api,
    generateEmptyVideoFile,
    generateEmptyAudioFile
} = require('./test-shared');

describe('Downloader', function() {
    const downloader_api = require('../downloader');
    // These tests are intended to be unit-style. By default we do NOT hit live
    // YouTube/yt-dlp during CI because it is inherently flaky (bot checks,
    // removed videos, geo/auth restrictions, etc.).
    //
    // To run full integration tests locally, set: RUN_INTEGRATION=1
    const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';

    // A stable public video (used only when RUN_INTEGRATION=1)
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const playlist_url = 'https://www.youtube.com/playlist?list=PLbZT16X07RLhqK-ZgSkRuUyiz9B_WLdNK';
    const channel_search_url = 'https://www.youtube.com/@SimonizeShow/search?query=TBC';

    // Offline fixtures (used when RUN_INTEGRATION is not enabled)
    const fixture_single = [fs.readJSONSync('./test/sample_mp4.info.json')];
    const fixture_playlist = [
        {
            ...fixture_single[0],
            playlist_index: 1
        },
        {
            ...fixture_single[0],
            id: `${fixture_single[0].id}_2`,
            _filename: fixture_single[0]._filename.replace(/\.mp4$/i, '_2.mp4'),
            playlist_index: 2
        }
    ];

    const _originalGetVideoInfoByURL = downloader_api.getVideoInfoByURL;
    const sub_id = 'dc834388-3454-41bf-a618-e11cb8c7de1c';
    const options = {
        ui_uid: uuid()
    }

    async function createCategory(url) {
        // get info
        const args = await downloader_api.generateArgs(url, 'video', options, null, true);
        const [info] = await downloader_api.getVideoInfoByURL(url, args);

        // create category
        await db_api.removeAllRecords('categories');
        const new_category = {
            name: 'test_category',
            uid: uuid(),
            rules: [],
            custom_output: ''
        };
        await db_api.insertRecordIntoTable('categories', new_category);
        await db_api.pushToRecordsArray('categories', {name: 'test_category'}, 'rules', {
            preceding_operator: null,
            comparator: 'includes',
            property: 'title',
            value: info['title']
        });
    }

    before(async function() {
        const update_available = await youtubedl_api.checkForYoutubeDLUpdate();
        if (update_available) await youtubedl_api.updateYoutubeDL(update_available);
        config_api.setConfigItem('ytdl_max_concurrent_downloads', 0);

        // Stub yt-dlp calls for CI/unit runs so we don't rely on live URLs.
        if (!RUN_INTEGRATION) {
            downloader_api.getVideoInfoByURL = async (requestedUrl) => {
                if (String(requestedUrl).includes('playlist?list=')) return fixture_playlist;
                return fixture_single;
            };
        }
    });

    after(function() {
        downloader_api.getVideoInfoByURL = _originalGetVideoInfoByURL;
    });

    beforeEach(async function() {
        // await db_api.connectToDB();
        await db_api.removeAllRecords('download_queue');
        config_api.setConfigItem('ytdl_allow_playlist_categorization', true);
        config_api.setConfigItem('ytdl_playlist_chunk_size', 100);
    });

    it('Get file info', async function() {
        this.timeout(300000);
        const info = await downloader_api.getVideoInfoByURL(url);
        assert(!!info && info.length > 0);
    });

    it('Get file info preserves safe args used for progress prediction', async function() {
        let captured_args = null;
        const original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        youtubedl_api.runYoutubeDL = async (requestedUrl, run_args) => {
            captured_args = run_args;
            return {
                callback: Promise.resolve({parsed_output: fixture_single, err: null})
            };
        };

        try {
            await _originalGetVideoInfoByURL(url, [
                '-o', '/tmp/%(title)s.%(ext)s',
                '-f', 'bestvideo+bestaudio',
                '--write-info-json',
                '--no-clean-info-json',
                '-j',
                '--no-simulate'
            ]);
        } finally {
            youtubedl_api.runYoutubeDL = original_runYoutubeDL;
        }

        assert(captured_args);
        assert(captured_args.includes('-o'));
        assert(captured_args.includes('/tmp/%(title)s.%(ext)s'));
        assert(captured_args.includes('-f'));
        assert(captured_args.includes('bestvideo+bestaudio'));
        assert(captured_args.includes('--dump-json'));
        assert(!captured_args.includes('--write-info-json'));
        assert(!captured_args.includes('--no-clean-info-json'));
        assert(!captured_args.includes('-j'));
        assert(!captured_args.includes('--no-simulate'));
    });

    it('Get file info uses yt-dlp when an audio language is requested', async function() {
        let captured_fork = null;
        const original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        youtubedl_api.runYoutubeDL = async (requestedUrl, run_args, custom_handler, selected_fork) => {
            captured_fork = selected_fork;
            return {
                callback: Promise.resolve({parsed_output: fixture_single, err: null})
            };
        };

        try {
            config_api.setConfigItem('ytdl_default_downloader', 'youtube-dl');
            await _originalGetVideoInfoByURL(url, ['-f', 'bestvideo+bestaudio[language=fr]/bestvideo+bestaudio/best'], null, {selectedAudioLanguage: 'fr'});
        } finally {
            youtubedl_api.runYoutubeDL = original_runYoutubeDL;
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }

        assert.strictEqual(captured_fork, 'yt-dlp');
    });

    it('Get file info uses yt-dlp when format probing forces it', async function() {
        let captured_fork = null;
        const original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        youtubedl_api.runYoutubeDL = async (requestedUrl, run_args, custom_handler, selected_fork) => {
            captured_fork = selected_fork;
            return {
                callback: Promise.resolve({parsed_output: fixture_single, err: null})
            };
        };

        try {
            config_api.setConfigItem('ytdl_default_downloader', 'youtube-dl');
            await _originalGetVideoInfoByURL(url, [], null, {forceYtDlp: true});
        } finally {
            youtubedl_api.runYoutubeDL = original_runYoutubeDL;
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }

        assert.strictEqual(captured_fork, 'yt-dlp');
    });

    it('Generate args supports configured invalid filename replacement', async function() {
        const original_default_downloader = config_api.getConfigItem('ytdl_default_downloader');
        const original_replace_invalid = config_api.getConfigItem('ytdl_replace_invalid_filename_chars');
        const original_invalid_chars = config_api.getConfigItem('ytdl_invalid_filename_chars');
        const original_replacement = config_api.getConfigItem('ytdl_invalid_filename_replacement');

        try {
            config_api.setConfigItem('ytdl_default_downloader', 'yt-dlp');
            config_api.setConfigItem('ytdl_replace_invalid_filename_chars', true);
            config_api.setConfigItem('ytdl_invalid_filename_chars', '|');
            config_api.setConfigItem('ytdl_invalid_filename_replacement', '_');

            const args = await downloader_api.generateArgs(url, 'video', {ui_uid: uuid()}, null, true);
            const replace_index = args.indexOf('--replace-in-metadata');
            assert(replace_index !== -1);
            assert.strictEqual(args[replace_index + 1], 'title,fulltitle,playlist_title,uploader,channel,series,chapter,album,artist');
            assert.strictEqual(args[replace_index + 2], '[|]');
            assert.strictEqual(args[replace_index + 3], '_');
        } finally {
            config_api.setConfigItem('ytdl_default_downloader', original_default_downloader);
            config_api.setConfigItem('ytdl_replace_invalid_filename_chars', original_replace_invalid);
            config_api.setConfigItem('ytdl_invalid_filename_chars', original_invalid_chars);
            config_api.setConfigItem('ytdl_invalid_filename_replacement', original_replacement);
        }
    });

    it('Download file', async function() {
        this.timeout(300000);
        await downloader_api.setupDownloads();
        const args = await downloader_api.generateArgs(url, 'video', options, null, true);
        const [info] = await downloader_api.getVideoInfoByURL(url, args);
        if (fs.existsSync(info['_filename'])) fs.unlinkSync(info['_filename']);
        const returned_download = await downloader_api.createDownload(url, 'video', options);
        assert(returned_download);
        const custom_download_method = async (url, args, options, callback) => {
            fs.writeJSONSync(utils.getTrueFileName(info['_filename'], 'video', '.info.json'), info);
            await generateEmptyVideoFile(info['_filename']);
            return await callback(null, [JSON.stringify(info)]);
        }
        const success = await downloader_api.downloadQueuedFile(returned_download['uid'], custom_download_method);
        assert(success);
    });

    it('Downloader - categorize', async function() {
        this.timeout(300000);
        await createCategory(url);
        // collect info
        const returned_download = await downloader_api.createDownload(url, 'video', options);
        await downloader_api.collectInfo(returned_download['uid']);
        assert(returned_download['category']);
        assert(returned_download['category']['name'] === 'test_category');
    });

    it('Downloader - categorize playlist', async function() {
        this.timeout(300000);
        await createCategory(playlist_url);
        // collect info
        const returned_download_pass = await downloader_api.createDownload(playlist_url, 'video', options);
        await downloader_api.collectInfo(returned_download_pass['uid']);
        assert(returned_download_pass['category']);
        assert(returned_download_pass['category']['name'] === 'test_category');

        // test with playlist categorization disabled
        config_api.setConfigItem('ytdl_allow_playlist_categorization', false);
        const returned_download_fail = await downloader_api.createDownload(playlist_url, 'video', options);
        await downloader_api.collectInfo(returned_download_fail['uid']);
        assert(!returned_download_fail['category']);
    });

    it('Collect info keeps single-download expected size when yt-dlp only provides requested formats', async function() {
        const original_get_video_info = downloader_api.getVideoInfoByURL;
        const fixture_with_requested_formats = [{
            ...fixture_single[0],
            format_id: '401+251',
            formats: [
                {format_id: '401'},
                {format_id: '251'}
            ],
            requested_formats: [
                {format_id: '401', filesize_approx: 1000},
                {format_id: '251', filesize: 500}
            ],
            filesize: undefined,
            filesize_approx: 1500
        }];

        try {
            downloader_api.getVideoInfoByURL = async () => fixture_with_requested_formats;
            const returned_download = await downloader_api.createDownload(url, 'video', {ui_uid: uuid()});
            await downloader_api.collectInfo(returned_download['uid']);
            const updated_download = await db_api.getRecord('download_queue', {uid: returned_download['uid']});
            assert.strictEqual(updated_download.expected_file_size, 1500);
            assert(Array.isArray(updated_download.files_to_check_for_progress));
            assert.strictEqual(updated_download.files_to_check_for_progress.length, 1);
            assert.strictEqual(updated_download.percent_complete, null);
        } finally {
            downloader_api.getVideoInfoByURL = original_get_video_info;
        }
    });

    it('Collect info estimates expected size from bitrate when yt-dlp omits filesize fields', async function() {
        const original_get_video_info = downloader_api.getVideoInfoByURL;
        const fixture_with_bitrate_only = [{
            ...fixture_single[0],
            format_id: '401+251',
            duration: 10,
            formats: [
                {format_id: '401'},
                {format_id: '251'}
            ],
            requested_formats: [
                {format_id: '401', tbr: 1000},
                {format_id: '251', abr: 128}
            ],
            filesize: undefined,
            filesize_approx: undefined
        }];

        try {
            downloader_api.getVideoInfoByURL = async () => fixture_with_bitrate_only;
            const returned_download = await downloader_api.createDownload(url, 'video', {ui_uid: uuid()});
            await downloader_api.collectInfo(returned_download['uid']);
            const updated_download = await db_api.getRecord('download_queue', {uid: returned_download['uid']});
            assert(updated_download.expected_file_size > 0);
            assert.strictEqual(updated_download.expected_file_size, ((1000 + 128) * 1000 / 8) * 10);
        } finally {
            downloader_api.getVideoInfoByURL = original_get_video_info;
        }
    });

    it('Collect info skips duplicate single downloads without starting yt-dlp', async function() {
        const original_find_existing_duplicate = files_api.findExistingDuplicateByInfo;
        const original_warn_on_duplicate = config_api.getConfigItem('ytdl_warn_on_duplicate');
        const existing_file_uid = uuid();

        try {
            config_api.setConfigItem('ytdl_warn_on_duplicate', true);
            await db_api.insertRecordIntoTable('files', {
                uid: existing_file_uid,
                id: fixture_single[0].id,
                title: fixture_single[0].title,
                isAudio: false,
                url: fixture_single[0].webpage_url,
                path: fixture_single[0]._filename,
                registered: Date.now()
            });
            files_api.findExistingDuplicateByInfo = async () => ({uid: existing_file_uid});

            const returned_download = await downloader_api.createDownload(url, 'video', {ui_uid: uuid()});
            await downloader_api.collectInfo(returned_download['uid']);
            const updated_download = await db_api.getRecord('download_queue', {uid: returned_download['uid']});

            assert.strictEqual(updated_download.finished, true);
            assert.strictEqual(updated_download.duplicate_skip_only, true);
            assert.deepStrictEqual(updated_download.file_uids, [existing_file_uid]);
            assert.strictEqual(updated_download.step_index, 3);
        } finally {
            files_api.findExistingDuplicateByInfo = original_find_existing_duplicate;
            config_api.setConfigItem('ytdl_warn_on_duplicate', original_warn_on_duplicate);
        }
    });

    it('Collect info allows duplicate single downloads when duplicate warnings are disabled', async function() {
        const original_find_existing_duplicate = files_api.findExistingDuplicateByInfo;
        const original_warn_on_duplicate = config_api.getConfigItem('ytdl_warn_on_duplicate');

        try {
            config_api.setConfigItem('ytdl_warn_on_duplicate', false);
            files_api.findExistingDuplicateByInfo = async () => {
                throw new Error('duplicate lookup should not run when warnings are disabled');
            };

            const returned_download = await downloader_api.createDownload(url, 'video', {ui_uid: uuid()});
            await downloader_api.collectInfo(returned_download['uid']);
            const updated_download = await db_api.getRecord('download_queue', {uid: returned_download['uid']});

            assert.strictEqual(updated_download.finished, false);
            assert.strictEqual(updated_download.duplicate_skip_only, false);
            assert.strictEqual(updated_download.duplicate_skip_count, 0);
            assert(Array.isArray(updated_download.files_to_check_for_progress));
            assert.strictEqual(updated_download.files_to_check_for_progress.length, 1);
            assert(updated_download.files_to_check_for_progress[0].startsWith(utils.removeFileExtension(fixture_single[0]._filename)));
        } finally {
            files_api.findExistingDuplicateByInfo = original_find_existing_duplicate;
            config_api.setConfigItem('ytdl_warn_on_duplicate', original_warn_on_duplicate);
        }
    });

    it('Collect info changes the output path when duplicate warnings are disabled and the target file already exists', async function() {
        const original_warn_on_duplicate = config_api.getConfigItem('ytdl_warn_on_duplicate');
        const original_exists_sync = fs.existsSync;

        try {
            config_api.setConfigItem('ytdl_warn_on_duplicate', false);
            fs.existsSync = (target_path) => target_path === fixture_single[0]._filename || original_exists_sync(target_path);

            const returned_download = await downloader_api.createDownload(url, 'video', {ui_uid: uuid()});
            await downloader_api.collectInfo(returned_download['uid']);
            const updated_download = await db_api.getRecord('download_queue', {uid: returned_download['uid']});
            const duplicate_suffix = ` [duplicate-${returned_download['uid'].slice(0, 8)}]`;

            assert(Array.isArray(updated_download.files_to_check_for_progress));
            assert.strictEqual(updated_download.files_to_check_for_progress.length, 1);
            assert(updated_download.files_to_check_for_progress[0].includes(duplicate_suffix));
            assert(Array.isArray(updated_download.args));
            assert(updated_download.args.includes('-o'));
            assert(updated_download.args[updated_download.args.indexOf('-o') + 1].includes(duplicate_suffix));
        } finally {
            fs.existsSync = original_exists_sync;
            config_api.setConfigItem('ytdl_warn_on_duplicate', original_warn_on_duplicate);
        }
    });

    it('Collect info filters duplicate playlist items down to remaining playlist indices', async function() {
        const original_get_video_info = downloader_api.getVideoInfoByURL;
        const original_find_existing_duplicate = files_api.findExistingDuplicateByInfo;
        const original_warn_on_duplicate = config_api.getConfigItem('ytdl_warn_on_duplicate');
        const fixture_playlist_with_indices = [
            {
                ...fixture_single[0],
                id: 'playlist-item-1',
                playlist_index: 1
            },
            {
                ...fixture_single[0],
                id: 'playlist-item-2',
                _filename: fixture_single[0]._filename.replace(/\.mp4$/i, '_playlist_2.mp4'),
                playlist_index: 2
            }
        ];

        try {
            config_api.setConfigItem('ytdl_warn_on_duplicate', true);
            downloader_api.getVideoInfoByURL = async () => fixture_playlist_with_indices;
            files_api.findExistingDuplicateByInfo = async (info_obj) => {
                return info_obj && info_obj.id === 'playlist-item-1' ? {uid: 'existing-playlist-item'} : null;
            };

            const returned_download = await downloader_api.createDownload(playlist_url, 'video', {ui_uid: uuid()});
            await downloader_api.collectInfo(returned_download['uid']);
            const updated_download = await db_api.getRecord('download_queue', {uid: returned_download['uid']});

            assert.strictEqual(updated_download.finished, false);
            assert.strictEqual(updated_download.duplicate_skip_only, false);
            assert.strictEqual(updated_download.duplicate_skip_count, 1);
            assert(Array.isArray(updated_download.playlist_item_progress));
            assert.strictEqual(updated_download.playlist_item_progress[0].status, 'duplicate');
            assert.strictEqual(updated_download.playlist_item_progress[0].existing_file_uid, 'existing-playlist-item');
            assert.strictEqual(updated_download.playlist_item_progress[1].progress_path_index, 0);
            assert(Array.isArray(updated_download.files_to_check_for_progress));
            assert.strictEqual(updated_download.files_to_check_for_progress.length, 1);
            assert(updated_download.args.includes('--playlist-items'));
            assert.strictEqual(updated_download.args[updated_download.args.indexOf('--playlist-items') + 1], '2');
        } finally {
            downloader_api.getVideoInfoByURL = original_get_video_info;
            files_api.findExistingDuplicateByInfo = original_find_existing_duplicate;
            config_api.setConfigItem('ytdl_warn_on_duplicate', original_warn_on_duplicate);
        }
    });

    it('Tag file', async function() {
        const success = await generateEmptyAudioFile('test/sample_mp3.mp3');
        const audio_path = './test/sample_mp3.mp3';
        const sample_json = fs.readJSONSync('./test/sample_mp3.info.json');
        const tags = {
            title: sample_json['title'],
            artist: sample_json['artist'] ? sample_json['artist'] : sample_json['uploader'],
            TRCK: '27'
        }
        NodeID3.write(tags, audio_path);
        const written_tags = NodeID3.read(audio_path);
        assert(success && written_tags['raw']['TRCK'] === '27');
    });

    it('Queue file', async function() {
        this.timeout(300000); 
        const returned_download = await downloader_api.createDownload(url, 'video', options, null, null, null, null, true);
        assert(returned_download);
    });

    it('Build playlist chunk ranges', function() {
        const ranges = downloader_api.buildPlaylistChunkRanges(205, 100, 20);
        assert.deepStrictEqual(ranges.map(range => range.label), ['1-100', '101-200', '201-205']);

        const capped_ranges = downloader_api.buildPlaylistChunkRanges(5000, 100, 20);
        assert.strictEqual(capped_ranges.length, 20);
        assert.strictEqual(capped_ranges[0].label, '1-250');
        assert.strictEqual(capped_ranges[19].label, '4751-5000');
    });

    it('Auto-chunks large playlist requests into multiple downloads', async function() {
        const original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        let runYoutubeDL_calls = 0;
        youtubedl_api.runYoutubeDL = async () => {
            runYoutubeDL_calls += 1;
            return {
                callback: Promise.resolve({
                    parsed_output: [{
                        title: 'Fixture Playlist',
                        entries: Array.from({length: 205}, (_, i) => ({id: `id-${i}`}))
                    }],
                    err: null
                })
            };
        };

        try {
            const created_downloads = await downloader_api.createDownloads(playlist_url, 'video', {...options, ui_uid: uuid()});
            assert.strictEqual(runYoutubeDL_calls, 1);
            assert.strictEqual(created_downloads.length, 3);

            const queue_downloads = await db_api.getRecords('download_queue');
            queue_downloads.sort((a, b) => a.timestamp_start - b.timestamp_start);

            const ranges = queue_downloads.map(download => {
                const split_args = (download.options.additionalArgs || '').split(',,');
                const playlist_items_index = split_args.indexOf('--playlist-items');
                return playlist_items_index === -1 ? null : split_args[playlist_items_index + 1];
            });
            assert.deepStrictEqual(ranges, ['1-100', '101-200', '201-205']);
            assert(queue_downloads[0].title.includes('Fixture Playlist'));
            assert(queue_downloads[0].title.includes('Chunk 1/3'));
            assert(queue_downloads[1].title.includes('Chunk 2/3'));
            assert(queue_downloads[2].title.includes('Chunk 3/3'));
        } finally {
            youtubedl_api.runYoutubeDL = original_runYoutubeDL;
        }
    });

    it('Does not auto-chunk channel search requests without the dedicated playlist flag', async function() {
        const original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        let runYoutubeDL_called = false;
        youtubedl_api.runYoutubeDL = async () => {
            runYoutubeDL_called = true;
            return {
                callback: Promise.resolve({
                    parsed_output: [{
                        title: 'SimonizeShow - Search - TBC',
                        entries: Array.from({length: 205}, (_, i) => ({id: `id-${i}`}))
                    }],
                    err: null
                })
            };
        };

        try {
            const created_downloads = await downloader_api.createDownloads(channel_search_url, 'video', {...options, ui_uid: uuid()});
            assert.strictEqual(created_downloads.length, 1);
            assert.strictEqual(runYoutubeDL_called, false);
            assert.strictEqual(created_downloads[0].options.playlistExclusive, undefined);
        } finally {
            youtubedl_api.runYoutubeDL = original_runYoutubeDL;
        }
    });

    it('Auto-chunks channel search playlist requests when explicitly enabled', async function() {
        const original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        let runYoutubeDL_calls = 0;
        youtubedl_api.runYoutubeDL = async () => {
            runYoutubeDL_calls += 1;
            return {
                callback: Promise.resolve({
                    parsed_output: [{
                        title: 'SimonizeShow - Search - TBC',
                        entries: Array.from({length: 205}, (_, i) => ({id: `id-${i}`}))
                    }],
                    err: null
                })
            };
        };

        try {
            const created_downloads = await downloader_api.createDownloads(channel_search_url, 'video', {
                ...options,
                ui_uid: uuid(),
                channelSearchPlaylist: true
            });
            assert.strictEqual(runYoutubeDL_calls, 1);
            assert.strictEqual(created_downloads.length, 3);

            const queue_downloads = await db_api.getRecords('download_queue');
            queue_downloads.sort((a, b) => a.timestamp_start - b.timestamp_start);

            assert.strictEqual(queue_downloads[0].options.channelSearchPlaylist, true);
            assert.strictEqual(queue_downloads[0].options.playlistExclusive, true);
            assert.strictEqual(queue_downloads[0].options.playlistChunkTitle, 'SimonizeShow: TBC');
            assert(queue_downloads[0].title.includes('SimonizeShow: TBC'));
            assert(queue_downloads[0].title.includes('Chunk 1/3'));
            assert(queue_downloads[1].title.includes('Chunk 2/3'));
            assert(queue_downloads[2].title.includes('Chunk 3/3'));
        } finally {
            youtubedl_api.runYoutubeDL = original_runYoutubeDL;
        }
    });

    it('Skips auto-chunking when playlist range args are already provided', async function() {
        const original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        let runYoutubeDL_called = false;
        youtubedl_api.runYoutubeDL = async () => {
            runYoutubeDL_called = true;
            return {
                callback: Promise.resolve({
                    parsed_output: [{
                        title: 'Fixture Playlist',
                        entries: Array.from({length: 205}, (_, i) => ({id: `id-${i}`}))
                    }],
                    err: null
                })
            };
        };

        try {
            const created_downloads = await downloader_api.createDownloads(playlist_url, 'video', {
                ...options,
                ui_uid: uuid(),
                additionalArgs: '--playlist-items,,1-25'
            });
            assert.strictEqual(created_downloads.length, 1);
            assert.strictEqual(runYoutubeDL_called, false);
        } finally {
            youtubedl_api.runYoutubeDL = original_runYoutubeDL;
        }
    });

    it('Collect info renames channel search playlist titles when the dedicated mode is enabled', async function() {
        const original_get_video_info = downloader_api.getVideoInfoByURL;
        downloader_api.getVideoInfoByURL = async () => {
            return fixture_playlist.map(info_obj => ({
                ...info_obj,
                playlist: 'SimonizeShow - Search - TBC',
                playlist_title: 'SimonizeShow - Search - TBC',
                playlist_channel: 'SimonizeShow',
                playlist_uploader: 'SimonizeShow'
            }));
        };

        try {
            const returned_download = await downloader_api.createDownload(channel_search_url, 'video', {
                ...options,
                channelSearchPlaylist: true
            });
            await downloader_api.collectInfo(returned_download['uid']);
            const updated_download = await db_api.getRecord('download_queue', {uid: returned_download['uid']});
            assert.strictEqual(updated_download.title, 'SimonizeShow: TBC');
        } finally {
            downloader_api.getVideoInfoByURL = original_get_video_info;
        }
    });

    it('Auto-chunking does not undercount playlists with unavailable entries', async function() {
        const original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        youtubedl_api.runYoutubeDL = async () => {
            return {
                callback: Promise.resolve({
                    parsed_output: [{
                        title: 'Fixture Playlist',
                        playlist_count: 200,
                        entries: Array.from({length: 200}, (_, i) => (i % 10 === 0 ? null : {id: `id-${i}`}))
                    }],
                    err: null
                })
            };
        };

        try {
            const created_downloads = await downloader_api.createDownloads(playlist_url, 'video', {...options, ui_uid: uuid()});
            assert.strictEqual(created_downloads.length, 2);

            const queue_downloads = await db_api.getRecords('download_queue');
            queue_downloads.sort((a, b) => a.timestamp_start - b.timestamp_start);

            const ranges = queue_downloads.map(download => {
                const split_args = (download.options.additionalArgs || '').split(',,');
                const playlist_items_index = split_args.indexOf('--playlist-items');
                return playlist_items_index === -1 ? null : split_args[playlist_items_index + 1];
            });
            assert.deepStrictEqual(ranges, ['1-100', '101-200']);
        } finally {
            youtubedl_api.runYoutubeDL = original_runYoutubeDL;
        }
    });

    it('Auto-chunks small exclusive playlists to fill concurrency cap workers', async function() {
        const original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        const original_max_concurrent_downloads = config_api.getConfigItem('ytdl_max_concurrent_downloads');
        const original_playlist_chunk_size = config_api.getConfigItem('ytdl_playlist_chunk_size');

        youtubedl_api.runYoutubeDL = async () => {
            return {
                callback: Promise.resolve({
                    parsed_output: [{
                        title: 'Fixture Playlist',
                        entries: Array.from({length: 10}, (_, i) => ({id: `id-${i}`}))
                    }],
                    err: null
                })
            };
        };

        try {
            config_api.setConfigItem('ytdl_max_concurrent_downloads', -1);
            config_api.setConfigItem('ytdl_playlist_chunk_size', 20);

            const created_downloads = await downloader_api.createDownloads(playlist_url, 'video', {...options, ui_uid: uuid()});
            assert.strictEqual(created_downloads.length, 5);

            const queue_downloads = await db_api.getRecords('download_queue');
            queue_downloads.sort((a, b) => a.timestamp_start - b.timestamp_start);

            const ranges = queue_downloads.map(download => {
                const split_args = (download.options.additionalArgs || '').split(',,');
                const playlist_items_index = split_args.indexOf('--playlist-items');
                return playlist_items_index === -1 ? null : split_args[playlist_items_index + 1];
            });
            assert.deepStrictEqual(ranges, ['1-2', '3-4', '5-6', '7-8', '9-10']);
        } finally {
            youtubedl_api.runYoutubeDL = original_runYoutubeDL;
            config_api.setConfigItem('ytdl_max_concurrent_downloads', original_max_concurrent_downloads);
            config_api.setConfigItem('ytdl_playlist_chunk_size', original_playlist_chunk_size);
        }
    });

    it('Respect max concurrent downloads sentinel -1', function() {
        assert.strictEqual(downloader_api.hasReachedConcurrentDownloadLimit(-1, 0), false);
        assert.strictEqual(downloader_api.hasReachedConcurrentDownloadLimit('-1', 5), false);
        assert.strictEqual(downloader_api.hasReachedConcurrentDownloadLimit(0, 0), true);
        assert.strictEqual(downloader_api.hasReachedConcurrentDownloadLimit(1, 0), false);
        assert.strictEqual(downloader_api.hasReachedConcurrentDownloadLimit(1, 1), true);
    });

    it('Playlist/chunk downloads honor lower explicit global cap and block other queue starts', async function() {
        const original_max_concurrent_downloads = config_api.getConfigItem('ytdl_max_concurrent_downloads');
        const original_collect_info = downloader_api.collectInfo;
        const original_download_queued_file = downloader_api.downloadQueuedFile;

        const started_download_uids = [];
        downloader_api.collectInfo = async (download_uid) => {
            started_download_uids.push(download_uid);
            await db_api.updateRecord('download_queue', {uid: download_uid}, {step_index: 1, finished_step: false, running: true});
        };
        downloader_api.downloadQueuedFile = async (download_uid) => {
            started_download_uids.push(download_uid);
            await db_api.updateRecord('download_queue', {uid: download_uid}, {step_index: 2, finished_step: false, running: true});
        };

        try {
            config_api.setConfigItem('ytdl_max_concurrent_downloads', 1);

            const normal_running_download = await downloader_api.createDownload(`${url}&normal_running=1`, 'video', {ui_uid: uuid()});
            const normal_waiting_download = await downloader_api.createDownload(`${url}&normal_waiting=1`, 'video', {ui_uid: uuid()});
            const playlist_chunk_download_1 = await downloader_api.createDownload(playlist_url, 'video', {
                ui_uid: uuid(),
                playlistExclusive: true,
                playlistBatchId: 'playlist-batch-test',
                playlistChunkRange: '1-10'
            });
            const playlist_chunk_download_2 = await downloader_api.createDownload(playlist_url, 'video', {
                ui_uid: uuid(),
                playlistExclusive: true,
                playlistBatchId: 'playlist-batch-test',
                playlistChunkRange: '11-20'
            });

            await db_api.updateRecord('download_queue', {uid: normal_running_download['uid']}, {step_index: 1, finished_step: false, running: true});

            // Exclusive playlist work should wait while another download is running.
            await downloader_api.checkDownloads();
            assert.deepStrictEqual(started_download_uids, []);

            // With explicit max=1, only one chunk should start at a time.
            await db_api.updateRecord('download_queue', {uid: normal_running_download['uid']}, {finished: true, running: false, finished_step: true, step_index: 3});
            await downloader_api.checkDownloads();
            assert.deepStrictEqual(started_download_uids, [playlist_chunk_download_1['uid']]);

            // Completing chunk #1 should schedule chunk #2 before normal queue items.
            await db_api.updateRecord('download_queue', {uid: playlist_chunk_download_1['uid']}, {finished: true, running: false, finished_step: true, step_index: 3});
            await downloader_api.checkDownloads();
            assert.deepStrictEqual(started_download_uids, [playlist_chunk_download_1['uid'], playlist_chunk_download_2['uid']]);

            // Only after all chunks finish should regular downloads resume.
            await db_api.updateRecord('download_queue', {uid: playlist_chunk_download_2['uid']}, {finished: true, running: false, finished_step: true, step_index: 3});
            await downloader_api.checkDownloads();
            assert.deepStrictEqual(started_download_uids, [playlist_chunk_download_1['uid'], playlist_chunk_download_2['uid'], normal_waiting_download['uid']]);
        } finally {
            downloader_api.collectInfo = original_collect_info;
            downloader_api.downloadQueuedFile = original_download_queued_file;
            config_api.setConfigItem('ytdl_max_concurrent_downloads', original_max_concurrent_downloads);
        }
    });

    it('Exclusive playlist mode starts up to 5 chunks when global cap is unbounded', async function() {
        const original_max_concurrent_downloads = config_api.getConfigItem('ytdl_max_concurrent_downloads');
        const original_collect_info = downloader_api.collectInfo;
        const original_download_queued_file = downloader_api.downloadQueuedFile;

        const started_download_uids = [];
        downloader_api.collectInfo = async (download_uid) => {
            started_download_uids.push(download_uid);
            await db_api.updateRecord('download_queue', {uid: download_uid}, {step_index: 1, finished_step: false, running: true});
        };
        downloader_api.downloadQueuedFile = async (download_uid) => {
            started_download_uids.push(download_uid);
            await db_api.updateRecord('download_queue', {uid: download_uid}, {step_index: 2, finished_step: false, running: true});
        };

        try {
            config_api.setConfigItem('ytdl_max_concurrent_downloads', -1);
            const playlist_batch_id = `playlist-batch-cap-${uuid()}`;

            const normal_running_download = await downloader_api.createDownload(`${url}&cap_normal_running=1`, 'video', {ui_uid: uuid()});
            const normal_waiting_download = await downloader_api.createDownload(`${url}&cap_normal_waiting=1`, 'video', {ui_uid: uuid()});
            await db_api.updateRecord('download_queue', {uid: normal_running_download['uid']}, {step_index: 1, finished_step: false, running: true});

            const chunk_downloads = [];
            for (let i = 0; i < 6; i++) {
                const chunk_download = await downloader_api.createDownload(playlist_url, 'video', {
                    ui_uid: uuid(),
                    playlistExclusive: true,
                    playlistBatchId: playlist_batch_id,
                    playlistChunkRange: `${i * 10 + 1}-${(i + 1) * 10}`
                });
                chunk_downloads.push(chunk_download);
            }

            // Wait while non-playlist download is running.
            await downloader_api.checkDownloads();
            assert.deepStrictEqual(started_download_uids, []);

            // Start up to the playlist cap (5) when global cap is unbounded (-1).
            await db_api.updateRecord('download_queue', {uid: normal_running_download['uid']}, {finished: true, running: false, finished_step: true, step_index: 3});
            await downloader_api.checkDownloads();
            assert.deepStrictEqual(started_download_uids, chunk_downloads.slice(0, 5).map(download => download.uid));
            assert(!started_download_uids.includes(chunk_downloads[5].uid));
            assert(!started_download_uids.includes(normal_waiting_download.uid));

            // Free one slot; 6th chunk should start before normal queue items.
            await db_api.updateRecord('download_queue', {uid: chunk_downloads[0].uid}, {finished: true, running: false, finished_step: true, step_index: 3});
            await downloader_api.checkDownloads();
            assert(started_download_uids.includes(chunk_downloads[5].uid));
            assert(!started_download_uids.includes(normal_waiting_download.uid));

            // Once all chunks are finished, regular queue can resume.
            for (const chunk_download of chunk_downloads) {
                await db_api.updateRecord('download_queue', {uid: chunk_download.uid}, {finished: true, running: false, finished_step: true, step_index: 3});
            }
            await downloader_api.checkDownloads();
            assert(started_download_uids.includes(normal_waiting_download.uid));
        } finally {
            downloader_api.collectInfo = original_collect_info;
            downloader_api.downloadQueuedFile = original_download_queued_file;
            config_api.setConfigItem('ytdl_max_concurrent_downloads', original_max_concurrent_downloads);
        }
    });

    it('Exclusive playlist cap helper uses lower explicit limits and clamps at 5 otherwise', function() {
        const original_max_concurrent_downloads = config_api.getConfigItem('ytdl_max_concurrent_downloads');
        try {
            config_api.setConfigItem('ytdl_max_concurrent_downloads', 3);
            assert.strictEqual(downloader_api.getExclusivePlaylistConcurrencyLimit(), 3);
            assert.strictEqual(downloader_api.getEffectivePlaylistChunkSize(10, 20, true), 4);

            config_api.setConfigItem('ytdl_max_concurrent_downloads', 5);
            assert.strictEqual(downloader_api.getExclusivePlaylistConcurrencyLimit(), 5);
            assert.strictEqual(downloader_api.getEffectivePlaylistChunkSize(10, 20, true), 2);

            config_api.setConfigItem('ytdl_max_concurrent_downloads', 99);
            assert.strictEqual(downloader_api.getExclusivePlaylistConcurrencyLimit(), 5);
            assert.strictEqual(downloader_api.getEffectivePlaylistChunkSize(10, 20, true), 2);

            config_api.setConfigItem('ytdl_max_concurrent_downloads', -1);
            assert.strictEqual(downloader_api.getExclusivePlaylistConcurrencyLimit(), 5);
            assert.strictEqual(downloader_api.getEffectivePlaylistChunkSize(10, 20, true), 2);

            config_api.setConfigItem('ytdl_max_concurrent_downloads', 0);
            assert.strictEqual(downloader_api.getExclusivePlaylistConcurrencyLimit(), 0);
            assert.strictEqual(downloader_api.getEffectivePlaylistChunkSize(10, 20, true), 20);

            config_api.setConfigItem('ytdl_max_concurrent_downloads', 1);
            assert.strictEqual(downloader_api.getEffectivePlaylistChunkSize(10, 20, true), 10);

            config_api.setConfigItem('ytdl_max_concurrent_downloads', -1);
            assert.strictEqual(downloader_api.getEffectivePlaylistChunkSize(10, 1, true), 1);
            assert.strictEqual(downloader_api.getEffectivePlaylistChunkSize(10, 20, false), 20);
        } finally {
            config_api.setConfigItem('ytdl_max_concurrent_downloads', original_max_concurrent_downloads);
        }
    });

    it('Uses faster progress polling for smaller single-file downloads', function() {
        assert.strictEqual(downloader_api.getProgressCheckIntervalMs(null), 1000);

        assert.strictEqual(downloader_api.getProgressCheckIntervalMs({
            expected_file_size: 50 * 1024 * 1024
        }), 250);

        assert.strictEqual(downloader_api.getProgressCheckIntervalMs({
            expected_file_size: 100 * 1024 * 1024
        }), 250);

        assert.strictEqual(downloader_api.getProgressCheckIntervalMs({
            expected_file_size: 100 * 1024 * 1024 + 1
        }), 1000);

        assert.strictEqual(downloader_api.getProgressCheckIntervalMs({
            expected_file_size: 10 * 1024 * 1024,
            playlist_item_progress: [{index: 1}, {index: 2}]
        }), 1000);
    });

    it('Appends realtime progress arg for yt-dlp downloads', function() {
        const original_default_downloader = config_api.getConfigItem('ytdl_default_downloader');
        try {
            config_api.setConfigItem('ytdl_default_downloader', 'yt-dlp');
            assert.deepStrictEqual(
                downloader_api.appendRealtimeProgressArgs(['-f', 'bestvideo+bestaudio']),
                ['-f', 'bestvideo+bestaudio', '--newline']
            );
            assert.deepStrictEqual(
                downloader_api.appendRealtimeProgressArgs(['-f', 'bestvideo+bestaudio', '--newline']),
                ['-f', 'bestvideo+bestaudio', '--newline']
            );
            assert.deepStrictEqual(
                downloader_api.appendRealtimeProgressArgs(['--quiet']),
                ['--quiet']
            );
        } finally {
            config_api.setConfigItem('ytdl_default_downloader', original_default_downloader);
        }
    });

    it('Parses yt-dlp process output progress and playlist state lines', function() {
        assert.strictEqual(
            downloader_api.parseYoutubeDLProgressPercent('\u001b[0;32m[download] 45.3% of 10.00MiB at 2.00MiB/s ETA 00:03\u001b[0m'),
            45.3
        );
        assert.deepStrictEqual(
            downloader_api.parseYoutubeDLPlaylistProgressState('[download] Downloading item 2 of 5'),
            {current_item_index: 2, total_items: 5}
        );
    });

    it('Updates single-download percent from process output listeners', async function() {
        const test_download = await downloader_api.createDownload(url, 'video', {ui_uid: uuid()});
        await db_api.updateRecord('download_queue', {uid: test_download.uid}, {
            finished: false,
            running: true,
            step_index: 2,
            percent_complete: null
        });

        const fake_child_process = {
            stdout: new PassThrough(),
            stderr: new PassThrough()
        };
        const detach = downloader_api.attachDownloadProgressOutputListeners(test_download.uid, fake_child_process, test_download);
        try {
            fake_child_process.stderr.write('[download] 12.50% of 10.00MiB at 2.00MiB/s ETA 00:04\n');
            await utils.wait(100);

            const updated_download = await db_api.getRecord('download_queue', {uid: test_download.uid});
            assert(updated_download);
            assert.strictEqual(Number(updated_download.percent_complete).toFixed(2), '12.50');
        } finally {
            detach();
            fake_child_process.stdout.end();
            fake_child_process.stderr.end();
            await db_api.removeRecord('download_queue', {uid: test_download.uid});
        }
    });

    it('Updates playlist percent from process output listeners', async function() {
        const test_download = await downloader_api.createDownload(playlist_url, 'video', {ui_uid: uuid()});
        await db_api.updateRecord('download_queue', {uid: test_download.uid}, {
            finished: false,
            running: true,
            step_index: 2,
            percent_complete: null,
            playlist_item_progress: [
                {index: 1, title: 'Item 1', expected_file_size: 100, downloaded_size: 0, percent_complete: 0, status: 'pending', progress_path_index: 0},
                {index: 2, title: 'Item 2', expected_file_size: 100, downloaded_size: 0, percent_complete: 0, status: 'pending', progress_path_index: 1},
                {index: 3, title: 'Item 3', expected_file_size: 100, downloaded_size: 0, percent_complete: 0, status: 'pending', progress_path_index: 2}
            ]
        });

        const latest_download = await db_api.getRecord('download_queue', {uid: test_download.uid});
        const fake_child_process = {
            stdout: new PassThrough(),
            stderr: new PassThrough()
        };
        const detach = downloader_api.attachDownloadProgressOutputListeners(test_download.uid, fake_child_process, latest_download);
        try {
            fake_child_process.stderr.write('[download] Downloading item 2 of 3\n');
            fake_child_process.stderr.write('[download] 50.0% of 10.00MiB at 2.00MiB/s ETA 00:04\n');
            await utils.wait(150);

            const updated_download = await db_api.getRecord('download_queue', {uid: test_download.uid});
            assert(updated_download);
            // ((item 2 - 1) + 0.5) / 3 * 100 = 50.00
            assert.strictEqual(Number(updated_download.percent_complete).toFixed(2), '50.00');
            assert(Array.isArray(updated_download.playlist_item_progress));
            assert.strictEqual(updated_download.playlist_item_progress[0].percent_complete, 100);
            assert(updated_download.playlist_item_progress[1].percent_complete >= 50);
            assert.strictEqual(updated_download.playlist_item_progress[1].status, 'downloading');
        } finally {
            detach();
            fake_child_process.stdout.end();
            fake_child_process.stderr.end();
            await db_api.removeRecord('download_queue', {uid: test_download.uid});
        }
    });

    it('Merges completed chunk playlists into a single playlist container', async function() {
        const batch_id = `playlist-batch-merge-${uuid()}`;
        const playlist_name = `Batch Merge ${uuid().slice(0, 8)}`;
        const created_download_uids = [];
        const created_playlist_ids = [];
        const created_file_uids = [];

        try {
            const now = Date.now();
            const file_uids = [uuid(), uuid(), uuid(), uuid()];
            for (let i = 0; i < file_uids.length; i++) {
                const file_uid = file_uids[i];
                created_file_uids.push(file_uid);
                await db_api.insertRecordIntoTable('files', {
                    uid: file_uid,
                    id: `batch-merge-file-${i + 1}`,
                    title: `Batch Merge File ${i + 1}`,
                    thumbnailURL: `https://example.com/thumb-${i + 1}.jpg`,
                    isAudio: false,
                    duration: 60,
                    url: `https://example.com/video-${i + 1}`,
                    uploader: 'Batch Merge',
                    size: 1024,
                    path: `/tmp/batch-merge-${file_uid}.mp4`,
                    upload_date: '2026-03-10',
                    description: null,
                    view_count: 0,
                    registered: now + i
                });
            }

            const chunk_playlist_1 = await files_api.createPlaylist(`${playlist_name} [Chunk 1/2: 1-2]`, [file_uids[0], file_uids[1]]);
            const chunk_playlist_2 = await files_api.createPlaylist(`${playlist_name} [Chunk 2/2: 3-4]`, [file_uids[2], file_uids[3]]);
            created_playlist_ids.push(chunk_playlist_1.id, chunk_playlist_2.id);

            const chunk_download_1 = await downloader_api.createDownload(playlist_url, 'video', {
                ui_uid: uuid(),
                playlistExclusive: true,
                playlistBatchId: batch_id,
                playlistChunkRange: '1-2',
                playlistChunkIndex: 1,
                playlistChunkCount: 2,
                playlistChunkTitle: playlist_name
            });
            const chunk_download_2 = await downloader_api.createDownload(playlist_url, 'video', {
                ui_uid: uuid(),
                playlistExclusive: true,
                playlistBatchId: batch_id,
                playlistChunkRange: '3-4',
                playlistChunkIndex: 2,
                playlistChunkCount: 2,
                playlistChunkTitle: playlist_name
            });
            created_download_uids.push(chunk_download_1.uid, chunk_download_2.uid);

            await db_api.updateRecord('download_queue', {uid: chunk_download_1.uid}, {
                finished: true,
                finished_step: true,
                running: false,
                step_index: 3,
                file_uids: [file_uids[0], file_uids[1]],
                container: chunk_playlist_1
            });
            await db_api.updateRecord('download_queue', {uid: chunk_download_2.uid}, {
                finished: true,
                finished_step: true,
                running: false,
                step_index: 3,
                file_uids: [file_uids[2], file_uids[3]],
                container: chunk_playlist_2
            });

            const merged_container = await downloader_api.finalizePlaylistBatchContainer(chunk_download_2.uid);
            assert(merged_container);
            assert(merged_container.id);
            created_playlist_ids.push(merged_container.id);
            assert.strictEqual(merged_container.name, playlist_name);
            assert.deepStrictEqual(merged_container.uids, file_uids);

            const playlists = await db_api.getRecords('playlists');
            const playlist_ids = playlists.map(playlist => playlist.id);
            assert(playlist_ids.includes(merged_container.id));
            assert(!playlist_ids.includes(chunk_playlist_1.id));
            assert(!playlist_ids.includes(chunk_playlist_2.id));

            const updated_download_1 = await db_api.getRecord('download_queue', {uid: chunk_download_1.uid});
            const updated_download_2 = await db_api.getRecord('download_queue', {uid: chunk_download_2.uid});
            assert.strictEqual(updated_download_1.playlist_batch_finalized, true);
            assert.strictEqual(updated_download_2.playlist_batch_finalized, true);
            assert.strictEqual(updated_download_1.playlist_batch_container_id, merged_container.id);
            assert.strictEqual(updated_download_2.playlist_batch_container_id, merged_container.id);
            assert(updated_download_1.container && updated_download_1.container.id === merged_container.id);
            assert(updated_download_2.container && updated_download_2.container.id === merged_container.id);
        } finally {
            for (const download_uid of created_download_uids) {
                await db_api.removeRecord('download_queue', {uid: download_uid});
            }
            for (const playlist_id of created_playlist_ids) {
                await db_api.removeRecord('playlists', {id: playlist_id});
            }
            for (const file_uid of created_file_uids) {
                await db_api.removeRecord('files', {uid: file_uid});
            }
        }
    });

    it('Concurrent batch finalization only creates one merged playlist container', async function() {
        const batch_id = `playlist-batch-concurrent-merge-${uuid()}`;
        const playlist_name = `Concurrent Batch Merge ${uuid().slice(0, 8)}`;
        const created_download_uids = [];
        const created_file_uids = [];
        const original_create_playlist = files_api.createPlaylist;
        let create_playlist_calls = 0;

        files_api.createPlaylist = async (...args) => {
            create_playlist_calls += 1;
            return await original_create_playlist(...args);
        };

        try {
            const now = Date.now();
            const file_uids = [uuid(), uuid(), uuid(), uuid()];
            for (let i = 0; i < file_uids.length; i++) {
                const file_uid = file_uids[i];
                created_file_uids.push(file_uid);
                await db_api.insertRecordIntoTable('files', {
                    uid: file_uid,
                    id: `batch-concurrent-merge-file-${i + 1}`,
                    title: `Batch Concurrent Merge File ${i + 1}`,
                    thumbnailURL: `https://example.com/concurrent-thumb-${i + 1}.jpg`,
                    isAudio: false,
                    duration: 60,
                    url: `https://example.com/concurrent-video-${i + 1}`,
                    uploader: 'Batch Concurrent Merge',
                    size: 1024,
                    path: `/tmp/batch-concurrent-merge-${file_uid}.mp4`,
                    upload_date: '2026-03-10',
                    description: null,
                    view_count: 0,
                    registered: now + i
                });
            }

            const chunk_download_1 = await downloader_api.createDownload(playlist_url, 'video', {
                ui_uid: uuid(),
                playlistExclusive: true,
                playlistBatchId: batch_id,
                playlistChunkRange: '1-2',
                playlistChunkIndex: 1,
                playlistChunkCount: 2,
                playlistChunkTitle: playlist_name
            });
            const chunk_download_2 = await downloader_api.createDownload(playlist_url, 'video', {
                ui_uid: uuid(),
                playlistExclusive: true,
                playlistBatchId: batch_id,
                playlistChunkRange: '3-4',
                playlistChunkIndex: 2,
                playlistChunkCount: 2,
                playlistChunkTitle: playlist_name
            });
            created_download_uids.push(chunk_download_1.uid, chunk_download_2.uid);

            await db_api.updateRecord('download_queue', {uid: chunk_download_1.uid}, {
                finished: true,
                finished_step: true,
                running: false,
                step_index: 3,
                file_uids: [file_uids[0], file_uids[1]],
                container: null
            });
            await db_api.updateRecord('download_queue', {uid: chunk_download_2.uid}, {
                finished: true,
                finished_step: true,
                running: false,
                step_index: 3,
                file_uids: [file_uids[2], file_uids[3]],
                container: null
            });

            const [merged_container_1, merged_container_2] = await Promise.all([
                downloader_api.finalizePlaylistBatchContainer(chunk_download_1.uid),
                downloader_api.finalizePlaylistBatchContainer(chunk_download_2.uid)
            ]);

            assert(merged_container_1);
            assert(merged_container_2);
            assert.strictEqual(merged_container_1.id, merged_container_2.id);
            assert.strictEqual(create_playlist_calls, 1);

            const matching_playlists = await db_api.getRecords('playlists', {name: playlist_name});
            assert.strictEqual(matching_playlists.length, 1);
            assert.deepStrictEqual(matching_playlists[0].uids, file_uids);
        } finally {
            files_api.createPlaylist = original_create_playlist;
            for (const download_uid of created_download_uids) {
                await db_api.removeRecord('download_queue', {uid: download_uid});
            }
            const playlists_to_remove = await db_api.getRecords('playlists', {name: playlist_name});
            for (const playlist of playlists_to_remove) {
                await db_api.removeRecord('playlists', {id: playlist.id});
            }
            for (const file_uid of created_file_uids) {
                await db_api.removeRecord('files', {uid: file_uid});
            }
        }
    });

    it('Pause file', async function() {
        const returned_download = await downloader_api.createDownload(url, 'video', options);
        await downloader_api.pauseDownload(returned_download['uid']);
        const updated_download = await db_api.getRecord('download_queue', {uid: returned_download['uid']});
        assert(updated_download['paused'] && !updated_download['running']);
    });

    it('Generate args', async function() {
        const args = await downloader_api.generateArgs(url, 'video', options);
        assert(args.length > 0);
    });

    it('Generate args includes SponsorBlock removal when enabled', async function() {
        const original_use_sponsorblock = config_api.getConfigItem('ytdl_use_sponsorblock_api');
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        try {
            config_api.setConfigItem('ytdl_use_sponsorblock_api', true);
            config_api.setConfigItem('ytdl_default_downloader', 'yt-dlp');
            const args = await downloader_api.generateArgs(url, 'video', options);
            const sponsorblock_index = args.indexOf('--sponsorblock-remove');
            assert(sponsorblock_index !== -1);
            assert(args[sponsorblock_index + 1] === 'sponsor');
        } finally {
            config_api.setConfigItem('ytdl_use_sponsorblock_api', original_use_sponsorblock);
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }
    });

    it('Generate args can disable SponsorBlock per download', async function() {
        const original_use_sponsorblock = config_api.getConfigItem('ytdl_use_sponsorblock_api');
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        try {
            config_api.setConfigItem('ytdl_use_sponsorblock_api', true);
            config_api.setConfigItem('ytdl_default_downloader', 'yt-dlp');
            const args = await downloader_api.generateArgs(url, 'video', {...options, disableSponsorBlock: true});
            assert(args.indexOf('--sponsorblock-remove') === -1);
            assert(args.indexOf('--sponsorblock-mark') === -1);
        } finally {
            config_api.setConfigItem('ytdl_use_sponsorblock_api', original_use_sponsorblock);
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }
    });

    it('Generate args prefers the requested audio language for video downloads', async function() {
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        try {
            config_api.setConfigItem('ytdl_default_downloader', 'yt-dlp');
            const args = await downloader_api.generateArgs(url, 'video', {...options, selectedAudioLanguage: 'es'});
            const format_index = args.indexOf('-f');
            const sort_index = args.indexOf('-S');
            assert(format_index !== -1);
            assert(sort_index !== -1);
            assert.strictEqual(args[format_index + 1], 'best[language=es]/bestvideo+bestaudio[language=es]/bestvideo+bestaudio/best');
            assert.strictEqual(args[sort_index + 1], 'lang:es');
        } finally {
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }
    });

    it('Generate args switches legacy downloader configs to yt-dlp when audio language is requested', async function() {
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        try {
            config_api.setConfigItem('ytdl_default_downloader', 'youtube-dl');
            const args = await downloader_api.generateArgs(url, 'video', {...options, selectedAudioLanguage: 'es'}, null, true);
            const sort_index = args.indexOf('-S');
            assert(sort_index !== -1);
            assert.strictEqual(args[sort_index + 1], 'lang:es');
            assert(args.includes('--no-clean-info-json'));
            assert(args.includes('--no-simulate'));
        } finally {
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }
    });

    it('Generate args switches legacy downloader configs to yt-dlp for exact dubbed format ids', async function() {
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        try {
            config_api.setConfigItem('ytdl_default_downloader', 'youtube-dl');
            const args = await downloader_api.generateArgs(url, 'video', {...options, customQualityConfiguration: '96-10'}, null, true);
            const format_index = args.indexOf('-f');
            assert(format_index !== -1);
            assert.strictEqual(args[format_index + 1], '96-10');
            assert(args.includes('--no-clean-info-json'));
            assert(args.includes('--no-simulate'));
        } finally {
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }
    });

    it('Generate args keeps requested audio language when limiting yt-dlp video height', async function() {
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        try {
            config_api.setConfigItem('ytdl_default_downloader', 'yt-dlp');
            const args = await downloader_api.generateArgs(url, 'video', {...options, selectedAudioLanguage: 'es', maxHeight: '720'});
            const format_index = args.indexOf('-f');
            const sort_index = args.indexOf('-S');
            assert(format_index !== -1);
            assert(sort_index !== -1);
            assert.strictEqual(args[format_index + 1], 'best[height<=720][language=es]/bestvideo[height<=720]+bestaudio[language=es]/bestvideo[height<=720]+bestaudio/best[height<=720]');
            assert.strictEqual(args[sort_index + 1], 'lang:es,res:720');
        } finally {
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }
    });

    it('Generate args prefers the requested audio language for audio-only downloads', async function() {
        const args = await downloader_api.generateArgs(url, 'audio', {...options, selectedAudioLanguage: 'es'});
        const format_index = args.indexOf('-f');
        const sort_index = args.indexOf('-S');
        assert(format_index !== -1);
        assert(sort_index !== -1);
        assert.strictEqual(args[format_index + 1], 'best[language=es]/bestaudio[language=es]/bestaudio/best');
        assert.strictEqual(args[sort_index + 1], 'lang:es');
        assert(args.includes('--audio-quality'));
    });

    it('Generate args embeds manually selected subtitles for video downloads', async function() {
        const args = await downloader_api.generateArgs(url, 'video', {...options, selectedSubtitleLanguage: 'fr', selectedSubtitleType: 'manual'});
        const sub_langs_index = args.indexOf('--sub-langs');
        const sub_format_index = args.indexOf('--sub-format');
        assert(args.includes('--write-subs'));
        assert(!args.includes('--write-auto-subs'));
        assert(args.includes('--embed-subs'));
        assert(sub_langs_index !== -1);
        assert(sub_format_index !== -1);
        assert.strictEqual(args[sub_langs_index + 1], 'fr');
        assert.strictEqual(args[sub_format_index + 1], 'srt/vtt/best');
    });

    it('Generate args embeds auto-generated subtitles when a subtitle language only has auto captions', async function() {
        const args = await downloader_api.generateArgs(url, 'video', {...options, selectedSubtitleLanguage: 'es', selectedSubtitleType: 'automatic'});
        const sub_langs_index = args.indexOf('--sub-langs');
        assert(!args.includes('--write-subs'));
        assert(args.includes('--write-auto-subs'));
        assert(args.includes('--embed-subs'));
        assert(sub_langs_index !== -1);
        assert.strictEqual(args[sub_langs_index + 1], 'es');
    });

    it('Generate args switches legacy downloader configs to yt-dlp when subtitles are requested', async function() {
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        try {
            config_api.setConfigItem('ytdl_default_downloader', 'youtube-dl');
            const args = await downloader_api.generateArgs(url, 'video', {...options, selectedSubtitleLanguage: 'fr', selectedSubtitleType: 'manual'}, null, true);
            assert(args.includes('--write-subs'));
            assert(args.includes('--embed-subs'));
            assert(args.includes('--no-clean-info-json'));
            assert(args.includes('--no-simulate'));
        } finally {
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }
    });

    it('Generate args keeps selected dubbed formats ahead of global format overrides', async function() {
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        const original_custom_args = config_api.getConfigItem('ytdl_custom_args');
        try {
            config_api.setConfigItem('ytdl_default_downloader', 'yt-dlp');
            config_api.setConfigItem('ytdl_custom_args', '-f,,bestvideo+bestaudio,,-S,,res:360');
            const args = await downloader_api.generateArgs(url, 'video', {...options, customQualityConfiguration: '96-10', selectedAudioLanguage: 'es'});
            const format_indexes = args.reduce((indexes, arg, index) => {
                if (arg === '-f') indexes.push(index);
                return indexes;
            }, []);
            const sort_indexes = args.reduce((indexes, arg, index) => {
                if (arg === '-S') indexes.push(index);
                return indexes;
            }, []);

            assert.deepStrictEqual(format_indexes.length, 1);
            assert.deepStrictEqual(sort_indexes.length, 0);
            assert.strictEqual(args[format_indexes[0] + 1], '96-10');
            assert(!args.includes('bestvideo+bestaudio'));
        } finally {
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
            config_api.setConfigItem('ytdl_custom_args', original_custom_args);
        }
    });

    it('Generate args keeps selected subtitle args ahead of global subtitle overrides', async function() {
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        const original_custom_args = config_api.getConfigItem('ytdl_custom_args');
        try {
            config_api.setConfigItem('ytdl_default_downloader', 'yt-dlp');
            config_api.setConfigItem('ytdl_custom_args', '--write-auto-subs,,--sub-langs,,en,,--sub-format,,json3,,--no-embed-subs');
            const args = await downloader_api.generateArgs(url, 'video', {...options, selectedSubtitleLanguage: 'fr', selectedSubtitleType: 'manual'});
            const sub_langs_indexes = args.reduce((indexes, arg, index) => {
                if (arg === '--sub-langs') indexes.push(index);
                return indexes;
            }, []);

            assert.strictEqual(sub_langs_indexes.length, 1);
            assert.strictEqual(args[sub_langs_indexes[0] + 1], 'fr');
            assert(args.includes('--write-subs'));
            assert(!args.includes('--write-auto-subs'));
            assert(args.includes('--embed-subs'));
            assert(!args.includes('--no-embed-subs'));
        } finally {
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
            config_api.setConfigItem('ytdl_custom_args', original_custom_args);
        }
    });

    it('Download queued file uses yt-dlp and newline progress when an audio language is requested', async function() {
        const original_runYoutubeDL = youtubedl_api.runYoutubeDL;
        const original_downloader = config_api.getConfigItem('ytdl_default_downloader');
        let captured_fork = null;
        let captured_args = null;

        try {
            config_api.setConfigItem('ytdl_default_downloader', 'youtube-dl');
            const returned_download = await downloader_api.createDownload(url, 'video', {...options, selectedAudioLanguage: 'fr'});
            await db_api.updateRecord('download_queue', {uid: returned_download['uid']}, {
                args: ['-o', fixture_single[0]._filename, '-f', 'bestvideo+bestaudio[language=fr]/bestvideo+bestaudio/best'],
                finished_step: true,
                step_index: 1
            });

            youtubedl_api.runYoutubeDL = async (requestedUrl, run_args, custom_handler, selected_fork) => {
                captured_fork = selected_fork;
                captured_args = run_args;
                return {
                    child_process: null,
                    callback: Promise.resolve({parsed_output: null, err: new Error('intentional test stop')})
                };
            };

            const success = await downloader_api.downloadQueuedFile(returned_download['uid']);
            assert.strictEqual(success, false);
        } finally {
            youtubedl_api.runYoutubeDL = original_runYoutubeDL;
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }

        assert.strictEqual(captured_fork, 'yt-dlp');
        assert(Array.isArray(captured_args));
        assert(captured_args.includes('--newline'));
    });

    it.skip('Generate args - subscription', async function() {
        const sub = await subscriptions_api.getSubscription(sub_id);
        const sub_options = subscriptions_api.generateOptionsForSubscriptionDownload(sub, 'admin');
        const args_normal = await downloader_api.generateArgs(url, 'video', options);
        const args_sub = await downloader_api.generateArgs(url, 'video', sub_options, 'admin');
        console.log(JSON.stringify(args_normal) !== JSON.stringify(args_sub));
    });

    it('Generate kodi NFO file', async function() {
        const nfo_file_path = './test/sample.nfo';
        if (fs.existsSync(nfo_file_path)) {
            fs.unlinkSync(nfo_file_path);
        }
        const sample_json = fs.readJSONSync('./test/sample_mp4.info.json');
        downloader_api.generateNFOFile(sample_json, nfo_file_path);
        assert(fs.existsSync(nfo_file_path), true);
        fs.unlinkSync(nfo_file_path);
    });

    it('Inject args', async function() {
        const original_args1 = ['--no-resize-buffer', '-o', '%(title)s', '--no-mtime'];
        const new_args1 = ['--age-limit', '25', '--yes-playlist', '--abort-on-error', '-o', '%(id)s'];
        const updated_args1 = utils.injectArgs(original_args1, new_args1);
        const expected_args1 = ['--no-resize-buffer', '--no-mtime', '--age-limit', '25', '--yes-playlist', '--abort-on-error', '-o', '%(id)s'];
        assert(JSON.stringify(updated_args1) === JSON.stringify(expected_args1));

        const original_args2 = ['-o', '%(title)s.%(ext)s', '--write-info-json', '--print-json', '--audio-quality', '0', '-x', '--audio-format', 'mp3'];
        const new_args2 =  ['--add-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg'];
        const updated_args2 = utils.injectArgs(original_args2, new_args2);
        const expected_args2 =  ['-o', '%(title)s.%(ext)s', '--write-info-json', '--print-json', '--audio-quality', '0', '-x', '--audio-format', 'mp3', '--add-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg'];
        assert(JSON.stringify(updated_args2) === JSON.stringify(expected_args2));

        const original_args3 = ['-o', '%(title)s.%(ext)s'];
        const new_args3 =  ['--min-filesize','1'];
        const updated_args3 = utils.injectArgs(original_args3, new_args3);
        const expected_args3 =  ['-o', '%(title)s.%(ext)s', '--min-filesize', '1'];
        assert(JSON.stringify(updated_args3) === JSON.stringify(expected_args3));
    });
    describe('Twitch', function () {
        const twitch_api = require('../twitch');
        const example_vod = '1790315420';
        // This is an integration test... it requires a working Twitch VOD id
        // and TwitchDownloaderCLI on PATH. It's disabled by default to keep CI
        // deterministic.
        const itTwitch = process.env.RUN_TWITCH_INTEGRATION === '1' ? it : it.skip;
        itTwitch('Download VOD chat', async function() {
            this.timeout(300000);
            if (!fs.existsSync('TwitchDownloaderCLI')) {
                try {
                    await exec('sh ../docker-utils/fetch-twitchdownloader.sh');
                    fs.copyFileSync('../docker-utils/TwitchDownloaderCLI', 'TwitchDownloaderCLI');
                } catch (e) {
                    logger.info('TwitchDownloaderCLI fetch failed, file may exist regardless.');
                }
            }
            const sample_path = path.join('test', 'sample.twitch_chat.json');
            if (fs.existsSync(sample_path)) fs.unlinkSync(sample_path);
            await twitch_api.downloadTwitchChatByVODID(example_vod, 'sample', null, null, null, './test');
            assert(fs.existsSync(sample_path));

            // cleanup
            if (fs.existsSync(sample_path)) fs.unlinkSync(sample_path);
        });
    });
});
