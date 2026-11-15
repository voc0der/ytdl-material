const { EventEmitter } = require('events');
const { assert, path, fs, db_api, config_api, downloader_api, youtubedl_api, files_api, archive_api, categories_api, utils,
    useTemporaryMediaRoots } = require('./test-shared');
const notifications = require('../notifications');
const hooks = require('../hooks');

// The download queue's quieter branches: what it refuses, what a step does when it finds nothing
// to do, and how a finished batch settles on what to show for itself.
describe('Download queue edges', function() {
    let media;
    let originals;
    let next_uid = 0;
    const stub = (object, name, value) => { originals.push([object, name, object[name]]); object[name] = value; };
    const queued = (fields = {}) => ({
        uid: `queue-edge-${++next_uid}`, url: 'https://example.test/clip', type: 'video', title: 'Clip', options: {},
        user_uid: null, sub_id: null, paused: false, finished: false, finished_step: true, running: false,
        step_index: 0, error: null, timestamp_start: Date.now(), ...fields
    });
    const insert = async record => { await db_api.insertRecordIntoTable('download_queue', record); return record; };
    const stored = uid => db_api.getRecord('download_queue', {uid});
    const waitFor = async (predicate, timeout_ms = 2000) => {
        const start = Date.now();
        while (Date.now() - start < timeout_ms) {
            if (await predicate()) return true;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return false;
    };

    beforeEach(async function() {
        originals = [];
        // No download may start on its own while these run: the queue check runs every second.
        media = useTemporaryMediaRoots({ ytdl_max_concurrent_downloads: 0, ytdl_min_sleep_between_downloads: 0,
            ytdl_use_youtubedl_archive: false, ytdl_warn_on_duplicate: false, ytdl_generate_nfo_files: false,
            ytdl_allow_playlist_categorization: false, ytdl_playlist_chunk_size: 20 });
        await db_api.removeAllRecords('download_queue');
        stub(notifications, 'sendDownloadErrorNotification', async () => {});
        stub(notifications, 'sendDownloadNotification', async () => {});
        downloader_api.resetDownloadQueueStartThrottle();
    });

    afterEach(async function() {
        for (const [object, name, value] of originals.reverse()) object[name] = value;
        await db_api.removeAllRecords('download_queue');
        media.restore();
    });

    it('refuses to queue an address that is not http or https', async function() {
        assert.strictEqual(await downloader_api.createDownload('file:///etc/passwd', 'video', {}), null);
        assert.deepStrictEqual(await downloader_api.createDownloads('--exec=touch pwned', 'video', {}), []);
        assert.deepStrictEqual(await db_api.getRecords('download_queue'), []);
    });

    describe('telling a playlist apart', function() {
        const exclusive = (url, options = {}) => downloader_api.isExclusivePlaylistDownload({ url, options });

        it('reads an address saved without its scheme', function() {
            assert.strictEqual(exclusive('example.test/watch?list=PL1'), true);
            assert.strictEqual(exclusive('www.youtube.com/@channel/videos'), true);
            assert.strictEqual(exclusive('www.youtube.com/@channel/search?query=talks', { channelSearchPlaylist: true }), true);
            assert.strictEqual(exclusive('example.test/clip'), false);
        });

        it('gives up on an address that cannot be read either way', function() {
            assert.strictEqual(exclusive('not an address'), false);
            assert.strictEqual(exclusive('not an address', { channelSearchPlaylist: true }), false);
        });

        it('takes a channel by its id or its old custom name, with or without a tab', function() {
            assert.strictEqual(exclusive('https://www.youtube.com/channel/UC123'), true);
            assert.strictEqual(exclusive('https://www.youtube.com/c/Name/videos'), true);
            assert.strictEqual(exclusive('https://www.youtube.com/channel/UC123/unknown-tab'), false);
        });

        it('groups a playlist with no batch or page id by its owner, kind and address', function() {
            assert.strictEqual(downloader_api.getExclusivePlaylistGroupKey({ url: 'https://example.test/?list=PL1', options: {} }),
                'playlist-url:global:video:https://example.test/?list=PL1');
            assert.strictEqual(downloader_api.getExclusivePlaylistGroupKey({ url: 'https://example.test/?list=PL1', type: 'audio',
                user_uid: 'alice', options: {} }), 'playlist-url:alice:audio:https://example.test/?list=PL1');
        });
    });

    describe('queueing a playlist', function() {
        let probes;
        beforeEach(function() {
            probes = [];
            stub(youtubedl_api, 'runYoutubeDL', async (url, args) => {
                probes.push([url, args]);
                return { callback: Promise.resolve({ parsed_output: [{ title: 'Uploads', entries: [{}, {}, {}] }] }) };
            });
        });

        it('still splits it up when the extra arguments do not pick the items', async function() {
            const downloads = await downloader_api.createDownloads('https://example.test/?list=PL1', 'video',
                { additionalArgs: '--embed-subs' }, null, null, null, null, true);
            assert.strictEqual(probes.length, 1);
            assert.strictEqual(downloads.length, 1);
            assert.strictEqual(downloads[0].options.playlistExclusive, true);
        });

        it('queues it as an ordinary download when custom arguments turn the playlist off', async function() {
            const downloads = await downloader_api.createDownloads('https://example.test/?list=PL1', 'video',
                { customArgs: '--no-playlist' }, null, null, null, null, true);
            assert.strictEqual(probes.length, 0);
            assert.strictEqual(downloads.length, 1);
            assert.strictEqual(downloads[0].options.playlistExclusive, undefined);
        });

        it('names a channel search after the channel in its address when the listing does not say', async function() {
            const downloads = await downloader_api.createDownloads('https://www.youtube.com/@Talks/search?query=keynote', 'video',
                { channelSearchPlaylist: true }, null, null, null, null, true);
            assert.strictEqual(downloads.length, 1);
            assert.strictEqual(downloads[0].title, 'Talks: keynote');
        });
    });

    describe('settling a finished batch', function() {
        const batch_options = extra => ({ playlistExclusive: true, playlistBatchId: 'batch-1', ...extra });
        let made;
        beforeEach(function() {
            made = [];
            stub(files_api, 'createPlaylist', async (name, uids, user_uid) => {
                made.push(['playlist', name, uids, user_uid]);
                return { id: `playlist-${made.length}`, name, uids };
            });
            stub(files_api, 'getVideo', async (uid, user_uid) => { made.push(['file', uid, user_uid]); return { uid, title: 'One' }; });
        });

        it('marks a batch in which nothing came through as settled, with nothing to show', async function() {
            const failed = await insert(queued({ user_uid: 'alice', finished: true, error: 'gone', file_uids: [], options: batch_options() }));
            await insert(queued({ user_uid: 'alice', finished: true, cancelled: true, file_uids: [], options: batch_options() }));

            assert.strictEqual(await downloader_api.finalizePlaylistBatchContainer(failed.uid), null);

            const records = await db_api.getRecords('download_queue', { 'options.playlistBatchId': 'batch-1' });
            assert.deepStrictEqual(records.map(record => [record.playlist_batch_finalized, record.playlist_batch_container_id]),
                [[true, null], [true, null]]);
            assert.deepStrictEqual(made, []);
        });

        it('keeps the container of the one part that came through', async function() {
            const part = await insert(queued({ finished: true, file_uids: ['file-a'], container: { uid: 'file-a', title: 'One' },
                options: batch_options() }));

            assert.deepStrictEqual(await downloader_api.finalizePlaylistBatchContainer(part.uid), { uid: 'file-a', title: 'One' });

            // The record keeps a reference, not the whole file.
            assert.deepStrictEqual((await stored(part.uid)).container, { uid: 'file-a' });
            assert.deepStrictEqual(made, []);
        });

        it('makes a playlist of the one part that came through, named without its part number', async function() {
            const part = await insert(queued({ title: 'Series [Chunk 1/2: 1-2]', user_uid: 'alice', finished: true,
                file_uids: ['file-a', 'file-b'], options: batch_options() }));

            const container = await downloader_api.finalizePlaylistBatchContainer(part.uid);

            assert.strictEqual(container.name, 'Series');
            assert.deepStrictEqual(made, [['playlist', 'Series', ['file-a', 'file-b'], 'alice']]);
            assert.deepStrictEqual((await stored(part.uid)).container, { id: 'playlist-1', uids: [] });
        });

        it('shows the single file of the one part that came through', async function() {
            const part = await insert(queued({ finished: true, file_uids: ['file-a'], options: batch_options() }));
            assert.deepStrictEqual(await downloader_api.finalizePlaylistBatchContainer(part.uid), { uid: 'file-a', title: 'One' });
            assert.deepStrictEqual(made, [['file', 'file-a', null]]);
        });

        it('orders parts with no part number by when they started, then by id, and shows a lone file', async function() {
            const now = Date.now();
            await insert(queued({ uid: 'part-b', finished: true, file_uids: [''], timestamp_start: now, options: batch_options() }));
            await insert(queued({ uid: 'part-a', finished: true, file_uids: ['file-a'], timestamp_start: now, options: batch_options() }));
            await insert(queued({ uid: 'part-c', finished: true, file_uids: [null], timestamp_start: now - 1, options: batch_options() }));

            assert.deepStrictEqual(await downloader_api.finalizePlaylistBatchContainer('part-a'), { uid: 'file-a', title: 'One' });
            assert.deepStrictEqual(made, [['file', 'file-a', null]]);
        });
    });

    it('archives a cleared subscription item by the id in an address its listing gave without a scheme', async function() {
        const archived = [];
        stub(archive_api, 'addToArchive', async (extractor, id) => { archived.push([extractor, id]); return true; });
        const clear = async prefetched => {
            const download = await downloader_api.createDownload('https://example.test/clip', 'video', {}, 'alice', 'edge-sub', 'Sub',
                [{ _type: 'url', title: 'Clip', ...prefetched }], true);
            assert.strictEqual(await downloader_api.clearDownload(download.uid), true);
        };

        await clear({ extractor: 'youtube', webpage_url: 'youtube.com/watch?v=watch-id' });
        await clear({ extractor: 'youtube', webpage_url: 'youtu.be/short-id' });
        await clear({ extractor: 'youtube', webpage_url: 'youtube.com/feed' });
        await clear({ webpage_url: 'not an address' });

        assert.deepStrictEqual(archived, [['youtube', 'watch-id'], ['youtube', 'short-id']]);
    });

    it('fails a queued download whose subscription has since been deleted', async function() {
        config_api.setConfigItem('ytdl_max_concurrent_downloads', 1);
        const download = await downloader_api.createDownload('https://example.test/clip', 'video', {}, null, 'deleted-sub', 'Deleted');

        await downloader_api.checkDownloads();

        assert(await waitFor(async () => (await stored(download.uid)).error_type === 'sub_id_missing'));
        assert.match((await stored(download.uid)).error, /subscription with id 'deleted-sub' is missing/);
    });

    it('stops the process of a download cancelled mid-transfer', async function() {
        const download = await insert(queued({ step_index: 1, args: [] }));
        const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null });
        let finish = null;
        const killed = [];
        stub(youtubedl_api, 'runYoutubeDL', async () => ({ child_process: child, callback: new Promise(resolve => { finish = resolve; }) }));
        stub(youtubedl_api, 'killYoutubeDLProcess', async process => { killed.push(process); });

        const running = downloader_api.downloadQueuedFile(download.uid);
        assert(await waitFor(() => finish !== null));
        await new Promise(resolve => setTimeout(resolve, 10));
        await downloader_api.cancelDownload(download.uid);
        finish({ parsed_output: null, err: new Error('terminated') });
        assert.strictEqual(await running, false);

        assert.deepStrictEqual(killed, [child]);
        const record = await stored(download.uid);
        assert.deepStrictEqual([record.cancelled, record.error_type, record.error], [true, 'cancelled', 'Cancelled']);
    });

    describe('gathering info', function() {
        const item = (fields = {}) => ({ _filename: path.join(media.video, 'Clip.mp4'), title: 'Clip', id: 'clip', extractor: 'generic',
            ext: 'mp4', ...fields });
        let lookups;
        let answers;
        beforeEach(function() {
            lookups = [];
            answers = [];
            stub(downloader_api, 'getVideoInfoByURL', async (url, args, download_uid, options) => {
                lookups.push([url, options && options.customFileFolderPath]);
                return answers.shift();
            });
            stub(categories_api, 'categorize', async () => null);
        });

        it('leaves a paused download alone', async function() {
            const download = await insert(queued({ paused: true }));
            await downloader_api.collectInfo(download.uid);
            assert.deepStrictEqual(lookups, []);
        });

        it('stops when there is no info to be had, from the queue or from a fresh lookup', async function() {
            const unknown = await insert(queued());
            const flat = await insert(queued({ prefetched_info: [{ _type: 'url', id: 'clip' }] }));
            answers.push(null, null);

            await downloader_api.collectInfo(unknown.uid);
            await downloader_api.collectInfo(flat.uid);

            assert.strictEqual(lookups.length, 2);
            for (const uid of [unknown.uid, flat.uid]) {
                const record = await stored(uid);
                assert.deepStrictEqual([record.finished, record.error, record.args], [false, null, undefined]);
            }
        });

        it('fails a download whose info lists nothing that could be downloaded', async function() {
            const download = await insert(queued());
            answers.push([{ title: 'A listing, not a file' }]);

            await downloader_api.collectInfo(download.uid);

            const record = await stored(download.uid);
            assert.strictEqual(record.error_type, 'no_downloadable_items');
            assert.match(record.error, /No downloadable items were found/);
        });

        it('fails a redownload that turns out to be more than one file', async function() {
            const download = await insert(queued({ options: { duplicateAction: 'copy' } }));
            answers.push([item(), item({ _filename: path.join(media.video, 'Other.mp4'), id: 'other' })]);

            await downloader_api.collectInfo(download.uid);

            const record = await stored(download.uid);
            assert.deepStrictEqual([record.error_type, record.error], ['duplicate_retry_failed', 'A duplicate retry must contain exactly one file.']);
        });

        it('saves an account\'s download in that account\'s folder, and labels a part with no number by its range', async function() {
            const download = await insert(queued({ user_uid: 'alice', options: { playlistChunkRange: '3-4' } }));
            answers.push([item()]);

            await downloader_api.collectInfo(download.uid);

            const folder = path.join(media.users, 'alice', 'video') + path.sep;
            assert.deepStrictEqual(lookups, [['https://example.test/clip', folder]]);
            const record = await stored(download.uid);
            assert.strictEqual(record.options.customFileFolderPath, folder);
            assert.strictEqual(record.title, 'Clip [3-4]');
            assert.strictEqual(record.finished_step, true);
        });

        it('shows a playlist the library already has in full as that playlist', async function() {
            config_api.setConfigItem('ytdl_warn_on_duplicate', true);
            const download = await insert(queued({ title: 'Mix' }));
            answers.push([item({ playlist_index: 1, playlist_title: 'Mix' }),
                item({ _filename: path.join(media.video, 'Other.mp4'), id: 'other', playlist_index: 2, playlist_title: 'Mix' })]);
            const playlists = [];
            stub(files_api, 'createPlaylist', async (name, uids) => { playlists.push([name, uids]); return { id: 'mix', name, uids }; });
            stub(files_api, 'findExistingDuplicateByInfo', async info => ({ uid: `have-${info.id}` }));

            await downloader_api.collectInfo(download.uid);

            const record = await stored(download.uid);
            assert.strictEqual(record.duplicate_skip_only, true);
            assert.deepStrictEqual(playlists, [['Mix', ['have-clip', 'have-other']]]);
            assert.deepStrictEqual(record.container, { id: 'mix', name: 'Mix', uids: ['have-clip', 'have-other'] });
        });
    });

    describe('downloading', function() {
        let registered;
        beforeEach(function() {
            registered = [];
            stub(files_api, 'registerFileDB', async (file_path, type, user_uid, category, sub_id, crop) => {
                registered.push([file_path, crop]);
                return { uid: `file-${registered.length}`, path: file_path };
            });
            stub(files_api, 'getVideo', async uid => ({ uid }));
            stub(files_api, 'createPlaylist', async (name, uids) => ({ id: 'playlist', name, uids }));
            stub(archive_api, 'addToArchive', async () => true);
            stub(hooks, 'queueDownloadFinishedHooks', () => {});
        });
        const output = parsed_output => stub(youtubedl_api, 'runYoutubeDL', async () =>
            ({ child_process: null, callback: Promise.resolve({ parsed_output, err: null }) }));

        it('leaves a paused download alone', async function() {
            const download = await insert(queued({ paused: true, step_index: 1 }));
            output([]);
            assert.strictEqual(await downloader_api.downloadQueuedFile(download.uid), undefined);
            assert.strictEqual((await stored(download.uid)).step_index, 1);
        });

        it('saves into the folder the download names, skips output with no file, and finishes what it got', async function() {
            const folder = path.join(media.base, 'picked') + path.sep;
            const file = path.join(folder, 'Clip.mp4');
            fs.ensureDirSync(folder);
            // yt-dlp sometimes leaves a merged file with its intermediate extension still on.
            fs.writeFileSync(`${file}.webm`, 'video');
            const download = await insert(queued({ step_index: 1, args: [],
                options: { customFileFolderPath: folder, cropFileSettings: { cropFileStart: 1, cropFileEnd: 5 } } }));
            config_api.setConfigItem('ytdl_generate_nfo_files', true);
            const nfo = [];
            const cropped = [];
            stub(downloader_api, 'generateNFOFile', (info, nfo_path) => nfo.push(nfo_path));
            stub(utils, 'cropFile', async (...args) => { cropped.push(args); return true; });
            output([{ title: 'Listing without a file' }, { _filename: file, title: 'Clip', id: 'clip', extractor: 'generic' }]);

            assert.deepStrictEqual(await downloader_api.downloadQueuedFile(download.uid), ['file-1']);

            assert(fs.existsSync(file) && !fs.existsSync(`${file}.webm`));
            assert.deepStrictEqual(registered, [[file, { cropFileStart: 1, cropFileEnd: 5 }]]);
            assert.deepStrictEqual(nfo, [path.join(folder, 'Clip.nfo')]);
            assert.deepStrictEqual(cropped, [[file, 1, 5, '.mp4']]);
            const record = await stored(download.uid);
            assert.deepStrictEqual([record.finished, record.container], [true, { uid: 'file-1' }]);
        });

        it('goes on with the file as it is when the stray extension cannot be taken off', async function() {
            const file = path.join(media.video, 'Clip.mp4');
            fs.writeFileSync(`${file}.webm`, 'video');
            const download = await insert(queued({ step_index: 1, args: [] }));
            stub(fs, 'renameSync', () => { throw new Error('read-only folder'); });
            output([{ _filename: file, title: 'Clip', id: 'clip', extractor: 'generic' }]);

            assert.deepStrictEqual(await downloader_api.downloadQueuedFile(download.uid), ['file-1']);
            assert(fs.existsSync(`${file}.webm`));
            assert.deepStrictEqual(registered.map(([file_path]) => file_path), [file]);
        });
    });

    describe('looking up info', function() {
        it('drops arguments that write files, and keeps going past a playlist\'s broken entries', async function() {
            const seen = [];
            stub(youtubedl_api, 'runYoutubeDL', async (url, args) => {
                seen.push(args);
                return { callback: Promise.resolve({ parsed_output: [{ id: 'a' }] }) };
            });

            const info = await downloader_api.getVideoInfoByURL('https://example.test/watch?list=PL1', ['-f', 'best',
                '--print-to-file', '%(id)s', 'ids.txt', '--download-archive', 'archive.txt', '-o', 'out.%(ext)s']);

            assert.deepStrictEqual(info, [{ id: 'a' }]);
            assert.deepStrictEqual(seen[0].slice(0, 6), ['-f', 'best', '-o', 'out.%(ext)s', '--ignore-errors', '--dump-json']);
        });

        it('warns rather than passing a cookies file that is not there', async function() {
            const cookies = path.join(__dirname, '..', 'appdata', 'cookies.txt');
            const real_path_exists = fs.pathExists;
            stub(fs, 'pathExists', async file => file === cookies ? false : real_path_exists(file));
            config_api.setConfigItem('ytdl_use_cookies', true);
            const logger = require('../logger');
            const warnings = [];
            stub(logger, 'warn', message => warnings.push(String(message)));

            const args = await downloader_api.generateArgs('https://example.test/clip', 'video', {}, null, true);

            assert(!args.includes('--cookies'));
            assert(warnings.some(message => message.startsWith('Cookies file could not be found.')));
        });
    });
});
