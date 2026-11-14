const { assert, path, fs, db_api, config_api, downloader_api, youtubedl_api, archive_api, useTemporaryMediaRoots } = require('./test-shared');
const notifications = require('../notifications');

describe('Downloader recovery', function() {
    let media;
    let originals;
    const stub = (object, name, value) => { originals.push([object, name, object[name]]); object[name] = value; };
    beforeEach(async function() {
        originals = [];
        media = useTemporaryMediaRoots({ ytdl_default_downloader: 'yt-dlp', ytdl_playlist_chunk_size: 2,
            ytdl_max_concurrent_downloads: 2, ytdl_skip_join_only_videos: true });
        await db_api.removeAllRecords('download_queue');
        await db_api.removeAllRecords('subscriptions');
        stub(notifications, 'sendDownloadErrorNotification', async () => {});
    });
    afterEach(async function() {
        for (const [object, name, value] of originals.reverse()) object[name] = value;
        await db_api.removeAllRecords('download_queue');
        await db_api.removeAllRecords('subscriptions');
        media.restore();
    });

    it('keeps actionable error details while omitting large captured stdout', function() {
        assert.strictEqual(downloader_api.formatDownloaderError({ shortMessage: ' short failure ' }), 'short failure');
        assert.strictEqual(downloader_api.formatDownloaderError({ message: 'command failed\nprivate output', stdout: Buffer.from('large') }),
            'command failed\nCaptured stdout (5 characters) was omitted from this stored error.');
        assert.match(downloader_api.formatDownloaderError({ stdout: 123 }), /Captured stdout \(3 characters\)/);
        assert.match(downloader_api.formatDownloaderError({ stdout: 'body' }), /produced no JSON error details/);
        assert.strictEqual(downloader_api.formatDownloaderError(Buffer.from(' error ')), 'error');
        assert.strictEqual(downloader_api.formatDownloaderError({}, 'fallback'), 'fallback');
        assert.strictEqual(downloader_api.formatDownloaderError(null, 'fallback'), 'fallback');
    });

    it('falls back to a single queued download when a playlist probe fails or returns no usable entries', async function() {
        const responses = [null, {}, { callback: Promise.resolve({ parsed_output: [] }) },
            { callback: Promise.resolve({ parsed_output: [{ entries: [] }] }) },
            { callback: Promise.resolve({ parsed_output: [{}] }) }];
        stub(youtubedl_api, 'runYoutubeDL', async () => responses.shift());
        for (let i = 0; i < 5; i++) {
            const downloads = await downloader_api.createDownloads('https://example.test/?list=fixture', 'video', {}, null, null, null, null, true);
            assert.strictEqual(downloads.length, 1);
            assert.strictEqual(downloads[0].paused, true);
        }
        youtubedl_api.runYoutubeDL = async () => { throw new Error('probe failed'); };
        assert.strictEqual((await downloader_api.createDownloads('https://example.test/?list=fixture', 'video')).length, 1);
    });

    it('chunks line-delimited playlist metadata using the largest index, including missing entries', async function() {
        const argumentsSeen = [];
        stub(youtubedl_api, 'runYoutubeDL', async (url, args) => {
            argumentsSeen.push(args);
            return { callback: Promise.resolve({ parsed_output: [{ playlist_title: 'Series', playlist_index: 1 }, null, { playlist_index: 5 }] }) };
        });
        const options = { youtubeUsername: 'fixture', youtubePassword: 'fixture-password' };
        const downloads = await downloader_api.createDownloads('https://example.test/?list=fixture', 'video', options);
        assert.deepStrictEqual(downloads.map(download => download.options.playlistChunkRange), ['1-2', '3-4', '5-5']);
        assert(downloads.every(download => download.title.includes('Series')));
        assert(argumentsSeen[0].includes('--yes-playlist'));
        assert(argumentsSeen[0].includes('--username'));
        assert(argumentsSeen[0].includes('--password'));
    });

    it('archives a member-only subscription item and completes its last queued refresh item', async function() {
        const archived = [];
        stub(archive_api, 'addToArchive', async (...args) => { archived.push(args); return true; });
        const download = await downloader_api.createDownload('https://example.test/clip', 'video', {}, 'alice', 'sub');
        await db_api.insertRecordIntoTable('subscriptions', { id: 'sub', refresh_status: { phase: 'queued', queued_count: 1, skipped_count: 0 } });
        stub(youtubedl_api, 'runYoutubeDL', async () => ({ callback: Promise.resolve({
            parsed_output: [], err: { stderr: '[generic] clip: Join this channel to get access to members-only content' }
        }) }));
        assert.strictEqual(await downloader_api.getVideoInfoByURL(download.url, [], download.uid), null);
        const stored = await db_api.getRecord('download_queue', { uid: download.uid });
        assert.strictEqual(stored.error_type, 'join_only');
        assert.strictEqual(stored.finished, true);
        assert.strictEqual(stored.running, false);
        assert(archived.some(args => args[0] === 'generic' && args[1] === 'clip' && args[4] === 'alice' && args[5] === 'sub'));
        const sub = await db_api.getRecord('subscriptions', { id: 'sub' });
        assert.strictEqual(sub.refresh_status.phase, 'complete');
        assert.strictEqual(sub.refresh_status.skipped_count, 1);
        assert(sub.refresh_status.completed_at > 0);
    });

    it('still removes a skipped queue entry if archiving its source fails', async function() {
        const download = await downloader_api.createDownload('https://example.test/clip', 'video', {}, null, 'sub', null,
            [{ id: 'clip', extractor: 'generic', webpage_url: 'https://example.test/clip' }], true);
        stub(archive_api, 'addToArchive', async () => { throw new Error('archive offline'); });
        assert.strictEqual(await downloader_api.clearDownload(download.uid), true);
        assert.strictEqual(await db_api.getRecord('download_queue', { uid: download.uid }), undefined);
    });

    it('extracts archived source identity from alternate link forms when clearing paused subscription items', async function() {
        const archived = [];
        stub(archive_api, 'addToArchive', async (...args) => { archived.push(args); return true; });
        for (const url of ['https://youtu.be/clip', 'https://www.youtube.com/embed/clip', 'https://www.youtube.com/shorts/clip', 'https://www.youtube.com/live/clip']) {
            const download = await downloader_api.createDownload(url, 'video', {}, null, 'sub', null, null, true);
            await downloader_api.clearDownload(download.uid);
        }
        assert.strictEqual(archived.length, 4);
        assert(archived.every(args => args[0] === 'youtube' && args[1] === 'clip'));
    });

    it('refuses repeated pause, resume and cancellation after a download has ended', async function() {
        const download = await downloader_api.createDownload('https://example.test/clip', 'video', {});
        await db_api.updateRecord('download_queue', { uid: download.uid }, { finished: true });
        assert.strictEqual(await downloader_api.pauseDownload(download.uid), false);
        assert.strictEqual(await downloader_api.cancelDownload(download.uid), false);
        assert.strictEqual(await downloader_api.resumeDownload(download.uid), false);
        await db_api.updateRecord('download_queue', { uid: download.uid }, { paused: true, cancelled: true });
        assert.strictEqual(await downloader_api.pauseDownload(download.uid), false);
        assert.strictEqual(await downloader_api.cancelDownload(download.uid), false);
        assert.strictEqual(await downloader_api.resumeDownload(download.uid), false);
    });

    it('keeps cookies, an external downloader and rate limits when preparing a replacement', async function() {
        config_api.setConfigItem('ytdl_use_cookies', true);
        config_api.setConfigItem('ytdl_use_default_downloading_agent', false);
        config_api.setConfigItem('ytdl_custom_downloading_agent', 'aria2c');
        config_api.setConfigItem('ytdl_download_rate_limit', '2M');
        stub(fs, 'pathExists', async file => path.basename(file) === 'cookies.txt');
        const args = await downloader_api.generateReacquireArgs({ output_template: 'copy.%(ext)s', format_selector: '137+140', merge_output_format: 'mp4' });
        for (const [flag, value] of [['--cookies', path.join('appdata', 'cookies.txt')], ['--external-downloader', 'aria2c'], ['-r', '2M'], ['-f', '137+140']]) {
            assert.strictEqual(args[args.indexOf(flag) + 1], value);
        }
        assert(args.includes('--embed-metadata'));
        assert(!args.includes('--write-info-json'));
    });
});
