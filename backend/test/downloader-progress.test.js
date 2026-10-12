const { EventEmitter } = require('events');
const {
    assert,
    fs,
    path,
    uuid,
    db_api,
    files_api,
    youtubedl_api,
    downloader_api,
    config_api,
    useTemporaryMediaRoots
} = require('./test-shared');

const SAMPLE = path.join(__dirname, 'sample_mp4.mp4');
// The sample's metadata, minus what would make the expected size depend on its formats.
const SAMPLE_INFO = fs.readJSONSync(path.join(__dirname, 'sample_mp4.info.json'));
for (const key of ['formats', 'requested_formats', 'requested_downloads', 'format_id']) delete SAMPLE_INFO[key];

async function waitFor(predicate, timeout_ms = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout_ms) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('timed out waiting for the download to get there');
}

const getDownload = uid => db_api.getRecord('download_queue', {uid});

/*************************************************
 * How a download reports progress: from the size
 * of the files yt-dlp is writing while it runs,
 * from the lines it prints, and from what it says
 * it wrote once it is done.
 *
 * The downloader is a stand-in that writes those
 * files and lines when the test says so; nothing
 * is fetched. Media goes to throwaway folders, and
 * whatever a finished download added to the shared
 * database is removed afterwards.
 ************************************************/
describe('Download progress', function() {
    this.timeout(20000);

    // What a finished download writes besides its queue entry.
    const TABLE_KEYS = {download_queue: 'uid', files: 'uid', playlists: 'id', archives: 'id', notifications: 'uid'};
    const existing = {};
    const originals = {};
    let media;

    beforeEach(async function() {
        media = useTemporaryMediaRoots();
        originals.getVideoInfoByURL = downloader_api.getVideoInfoByURL;
        originals.runYoutubeDL = youtubedl_api.runYoutubeDL;
        originals.findExistingDuplicateByInfo = files_api.findExistingDuplicateByInfo;
        for (const [table, key] of Object.entries(TABLE_KEYS)) {
            existing[table] = new Set((await db_api.getRecords(table, null, false, null, null, [key])).map(record => record[key]));
        }
    });

    afterEach(async function() {
        downloader_api.getVideoInfoByURL = originals.getVideoInfoByURL;
        youtubedl_api.runYoutubeDL = originals.runYoutubeDL;
        files_api.findExistingDuplicateByInfo = originals.findExistingDuplicateByInfo;
        for (const [table, key] of Object.entries(TABLE_KEYS)) {
            const added = (await db_api.getRecords(table, null, false, null, null, [key]))
                .map(record => record[key])
                .filter(value => value !== undefined && !existing[table].has(value));
            if (added.length > 0) await db_api.removeAllRecords(table, {[key]: {$in: added}});
        }
        media.restore();
    });

    function itemInfo(n, extra = {}) {
        return {
            ...SAMPLE_INFO,
            id: `progress-item-${n}`,
            title: `Item ${n}`,
            extractor: 'generic',
            extractor_key: 'Generic',
            webpage_url: `https://example.com/clips/progress-item-${n}`,
            playlist_index: n,
            playlist_title: 'Progress playlist',
            _filename: path.join(media.video, `Item ${n}.mp4`),
            filesize: 1000,
            ...extra
        };
    }

    // Puts a finished file where yt-dlp would have, with the metadata it leaves beside it.
    function writeFinishedFile(info) {
        fs.copySync(SAMPLE, info._filename);
        fs.writeJSONSync(info._filename.replace(/\.mp4$/, '.info.json'), info);
    }

    // A downloader that has started, and finishes when `finish` is called with its output.
    function holdDownloader({child_process = null, on_start = () => {}} = {}) {
        const run = {calls: []};
        const finished = new Promise(resolve => {
            run.finish = resolve;
        });
        youtubedl_api.runYoutubeDL = async (url, args) => {
            run.calls.push({url, args});
            on_start(args);
            return {child_process, callback: finished};
        };
        return run;
    }

    it('follows each playlist item by the file it is writing, then marks each done, already there, or failed', async function() {
        // The first item is already in the library.
        const already_there = itemInfo(1);
        writeFinishedFile(already_there);
        const library_file = await files_api.registerFileDB(already_there._filename, 'video');
        assert(library_file && library_file.uid);

        const items = [already_there, itemInfo(2), itemInfo(3)];
        downloader_api.getVideoInfoByURL = async () => items.map(item => ({...item}));
        config_api.setConfigItem('ytdl_warn_on_duplicate', true);
        files_api.findExistingDuplicateByInfo = async info => (info.id === already_there.id ? {uid: library_file.uid} : null);

        const download = await downloader_api.createDownload('https://example.com/collections/progress', 'video', {ui_uid: uuid()});
        await downloader_api.collectInfo(download.uid);
        const collected = await getDownload(download.uid);
        assert.strictEqual(collected.expected_file_size, 2000);
        assert.deepStrictEqual(collected.playlist_item_progress.map(item => [item.status, item.progress_path_index]), [['duplicate', null], ['pending', 0], ['pending', 1]]);
        assert.strictEqual(collected.args[collected.args.indexOf('--playlist-items') + 1], '2-3');

        // Halfway through the second item, as the fragment yt-dlp is writing.
        const run = holdDownloader({on_start: () => fs.writeFileSync(path.join(media.video, 'Item 2.f137.mp4.part'), Buffer.alloc(500))});
        const downloading = downloader_api.downloadQueuedFile(download.uid);

        const in_progress = await waitFor(async () => {
            const current = await getDownload(download.uid);
            return current.playlist_item_progress[1].status === 'downloading' ? current : null;
        });
        assert.strictEqual(in_progress.percent_complete, '25.00');
        assert.deepStrictEqual(in_progress.playlist_item_progress.map(item => [item.status, item.percent_complete, item.downloaded_size]), [
            ['duplicate', 100, 1000],
            ['downloading', 50, 500],
            ['pending', 0, 0]
        ]);

        // yt-dlp reports the second item; the third never arrived.
        fs.removeSync(path.join(media.video, 'Item 2.f137.mp4.part'));
        writeFinishedFile(items[1]);
        run.finish({parsed_output: [items[1]], err: null});
        const file_uids = await downloading;

        const finished = await getDownload(download.uid);
        assert.strictEqual(finished.finished, true);
        assert.strictEqual(finished.percent_complete, 100);
        assert.deepStrictEqual(finished.playlist_item_progress.map(item => [item.status, item.percent_complete, item.downloaded_size]), [
            ['duplicate', 100, 1000],
            ['complete', 100, 1000],
            ['failed', 0, 0]
        ]);
        assert.strictEqual(file_uids.length, 2);
        assert.strictEqual(file_uids[0], library_file.uid);
        const playlist = await files_api.getPlaylist(finished.container.id, null);
        assert.strictEqual(playlist.name, 'Progress playlist');
        assert.deepStrictEqual(playlist.uids, file_uids);
    });

    it('reads progress from the lines yt-dlp prints, including a last line with no newline', async function() {
        // No size to expect, so the lines printed are the only progress there is.
        const info = itemInfo(1, {playlist_index: undefined, playlist_title: undefined, filesize: undefined, vbr: undefined, abr: undefined});
        downloader_api.getVideoInfoByURL = async () => [info];
        const download = await downloader_api.createDownload('https://example.com/clips/progress-item-1', 'video', {ui_uid: uuid()});
        await downloader_api.collectInfo(download.uid);
        assert.strictEqual((await getDownload(download.uid)).expected_file_size, 0);

        // An older stream API, with removeListener but no off().
        const stdout = new EventEmitter();
        stdout.off = undefined;
        const run = holdDownloader({child_process: {stdout, stderr: null}});
        const downloading = downloader_api.downloadQueuedFile(download.uid);
        await waitFor(() => run.calls.length === 1);

        stdout.emit('data', Buffer.from('[download]  12.5% of ~1.00KiB at 1.00KiB/s ETA 00:01\n[download]  40.0% of'));
        await waitFor(async () => (await getDownload(download.uid)).percent_complete === '12.50');
        stdout.emit('data', Buffer.from(' ~1.00KiB at 1.00KiB/s ETA 00:01'));
        stdout.emit('end');
        await waitFor(async () => (await getDownload(download.uid)).percent_complete === '40.00');

        run.finish({parsed_output: null, err: 'ERROR: the connection dropped'});
        assert.strictEqual(await downloading, false);
        assert.strictEqual(stdout.listenerCount('data'), 0);
        assert.strictEqual(stdout.listenerCount('end'), 0);
        const failed = await getDownload(download.uid);
        assert.strictEqual(failed.error_type, 'unknown_error');
        assert(failed.error.includes('the connection dropped'));
    });
});
