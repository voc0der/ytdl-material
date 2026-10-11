const {assert, fs, path, db_api, files_api, archive_api, youtubedl_api, useTemporaryMediaRoots} = require('./test-shared');
const downloader = require('../downloader');
const notifications = require('../notifications');
const hooks = require('../hooks');

describe('Retrying a skipped duplicate', function() {
    this.timeout(10000);
    let roots, info, existing, run_result, active_uid;
    const original = {};
    const url = 'https://example.com/clip';
    const options = {maxHeight: '720', selectedAudioLanguage: 'en', disableSponsorBlock: true};

    beforeEach(async function() {
        roots = useTemporaryMediaRoots({ytdl_warn_on_duplicate: true, ytdl_use_youtubedl_archive: true,
            ytdl_include_metadata: true, ytdl_multi_user_mode: false, ytdl_max_concurrent_downloads: 0});
        for (const table of ['files', 'download_queue', 'archives', 'categories', 'playlists']) await db_api.removeAllRecords(table);
        for (const [object, key] of [[downloader, 'getVideoInfoByURL'], [youtubedl_api, 'runYoutubeDL'],
            [notifications, 'sendDownloadNotification'], [notifications, 'sendDownloadErrorNotification'], [hooks, 'queueDownloadFinishedHooks']]) {
            original[key] = object[key];
        }
        notifications.sendDownloadNotification = () => {};
        notifications.sendDownloadErrorNotification = () => {};
        hooks.queueDownloadFinishedHooks = () => {};
        run_result = null;
        active_uid = null;
        await seedMedia('video');
        downloader.getVideoInfoByURL = async () => [{...info}];
        youtubedl_api.runYoutubeDL = async (_url, args) => {
            assert(fs.existsSync(existing.path), 'the original must survive while the download runs');
            const type = existing.isAudio ? 'audio' : 'video';
            const ext = type === 'audio' ? 'mp3' : 'mp4';
            const output = args[args.lastIndexOf('-o') + 1].replace('%(ext)s', ext).replace(/%%/g, '%');
            assert.notStrictEqual(output, existing.path);
            fs.copyFileSync(path.join(__dirname, `sample_${ext}.${ext}`), output);
            const output_info = {...info, _filename: output, title: 'New download'};
            fs.writeJSONSync(output.replace(/\.[^.]+$/, '.info.json'), output_info);
            return {callback: Promise.resolve(run_result ? await run_result(output_info) : {parsed_output: [output_info], err: null})};
        };
    });

    afterEach(function() {
        downloader.getVideoInfoByURL = original.getVideoInfoByURL;
        youtubedl_api.runYoutubeDL = original.runYoutubeDL;
        notifications.sendDownloadNotification = original.sendDownloadNotification;
        notifications.sendDownloadErrorNotification = original.sendDownloadErrorNotification;
        hooks.queueDownloadFinishedHooks = original.queueDownloadFinishedHooks;
        roots.restore();
    });

    async function seedMedia(type) {
        const ext = type === 'audio' ? 'mp3' : 'mp4';
        const file_path = path.join(roots[type], `original.${ext}`);
        info = {...fs.readJSONSync(path.join(__dirname, `sample_${ext}.info.json`)),
            id: 'clip', extractor: 'generic', webpage_url: url, _filename: file_path};
        fs.copyFileSync(path.join(__dirname, `sample_${ext}.${ext}`), file_path);
        fs.writeJSONSync(file_path.replace(/\.[^.]+$/, '.info.json'), info);
        fs.writeFileSync(file_path.replace(/\.[^.]+$/, '.player-subtitles.vtt'), 'WEBVTT\n');
        existing = {...await files_api.registerFileDB(file_path, type)};
        await db_api.updateRecord('files', {uid: existing.uid}, {favorite: true, category: {uid: 'category', name: 'Saved'}});
        await archive_api.addToArchive(info.extractor, info.id, type, info.title);
    }

    async function skipDuplicate() {
        const download = await downloader.createDownload(url, existing.isAudio ? 'audio' : 'video', {...options});
        await downloader.collectInfo(download.uid);
        const skipped = await db_api.getRecord('download_queue', {uid: download.uid});
        assert.strictEqual(skipped.duplicate_skip_only, true, 'a library duplicate should prompt even when archived');
        assert.strictEqual(skipped.finished, true);
        return download.uid;
    }

    async function retry(action) {
        const skipped_uid = await skipDuplicate();
        const queued = await downloader.retryDuplicateDownload(skipped_uid, action);
        assert(queued);
        assert.strictEqual(await db_api.getRecord('download_queue', {uid: skipped_uid}), undefined);
        for (const [key, value] of Object.entries(options)) assert.strictEqual(queued.options[key], value);
        assert.strictEqual(queued.options.ignoreArchive, true);
        active_uid = queued.uid;
        await downloader.collectInfo(queued.uid);
        const collected = await db_api.getRecord('download_queue', {uid: queued.uid});
        assert.strictEqual(collected.duplicate_skip_only, false);
        assert(!collected.args.includes('--download-archive'));
        assert(!collected.error);
        return queued;
    }

    for (const type of ['video', 'audio']) {
        it(`overwrites ${type} only after success, preserving identity and library references`, async function() {
            if (type === 'audio') {
                await db_api.removeAllRecords('files');
                await seedMedia(type);
            }
            await db_api.insertRecordIntoTable('playlists', {id: 'saved', uids: [existing.uid]});
            const queued = await retry('overwrite');
            const uids = await downloader.downloadQueuedFile(queued.uid);
            assert.deepStrictEqual(uids, [existing.uid]);
            const files = await db_api.getRecords('files');
            assert.strictEqual(files.length, 1);
            const replacement = files[0];
            assert.strictEqual(replacement.uid, existing.uid);
            assert.strictEqual(replacement.share_id, existing.share_id);
            assert.strictEqual(replacement.registered, existing.registered);
            assert.strictEqual(replacement.favorite, true);
            assert.deepStrictEqual(replacement.category, {uid: 'category', name: 'Saved'});
            assert.strictEqual(replacement.title, 'New download');
            assert(fs.existsSync(replacement.path));
            assert(!fs.existsSync(existing.path));
            assert(!fs.existsSync(existing.path.replace(/\.[^.]+$/, '.info.json')));
            assert(!fs.existsSync(existing.path.replace(/\.[^.]+$/, '.player-subtitles.vtt')));
            assert.deepStrictEqual((await db_api.getRecord('playlists', {id: 'saved'})).uids, [existing.uid]);
            assert(await archive_api.existsInArchive(info.extractor, info.id, type));
        });
    }

    it('keeps both copies when requested, despite duplicate warnings and the archive', async function() {
        const queued = await retry('copy');
        const uids = await downloader.downloadQueuedFile(queued.uid);
        assert.strictEqual(uids.length, 1);
        assert.notStrictEqual(uids[0], existing.uid);
        const files = await db_api.getRecords('files');
        assert.strictEqual(files.length, 2);
        assert(files.every(file => fs.existsSync(file.path)));
    });

    it('accepts warning text from a successful replacement process', async function() {
        const queued = await retry('overwrite');
        run_result = async output_info => ({parsed_output: [output_info], err: 'WARNING: optional metadata unavailable'});
        assert.deepStrictEqual(await downloader.downloadQueuedFile(queued.uid), [existing.uid]);
        assert(!fs.existsSync(existing.path));
    });

    it('removes custom archive arguments without adding a flag unsupported by older downloaders', async function() {
        const uid = await skipDuplicate();
        await db_api.updateRecord('download_queue', {uid}, {options: {
            ...options, additionalArgs: '--download-archive,,first.txt,,--download-archive=second.txt'
        }});
        const queued = await downloader.retryDuplicateDownload(uid, 'overwrite');
        await downloader.collectInfo(queued.uid);
        const collected = await db_api.getRecord('download_queue', {uid: queued.uid});
        assert(!collected.args.some(arg => arg.includes('download-archive') || arg === 'first.txt' || arg === 'second.txt'));
    });

    for (const failure of ['error', 'cancelled', 'paused', 'wrong source', 'missing media']) {
        it(`keeps the original when the replacement has ${failure}`, async function() {
            const queued = await retry('overwrite');
            run_result = async output_info => {
                if (failure === 'cancelled' || failure === 'paused') {
                    await db_api.updateRecord('download_queue', {uid: active_uid}, {[failure]: true});
                }
                if (failure === 'wrong source') {
                    fs.writeJSONSync(output_info._filename.replace(/\.[^.]+$/, '.info.json'), {...output_info, id: 'different'});
                }
                if (failure === 'missing media') fs.removeSync(output_info._filename);
                return {parsed_output: [output_info], err: failure === 'error' ? new Error('failed') : null};
            };
            await downloader.downloadQueuedFile(queued.uid);
            assert(fs.existsSync(existing.path));
            assert.strictEqual((await files_api.getVideo(existing.uid)).path, existing.path);
            assert.strictEqual((await db_api.getRecords('files')).length, 1);
        });
    }

    it('does not remove old media still referenced by another library record', async function() {
        await db_api.insertRecordIntoTable('files', {...existing, uid: 'legacy-copy'});
        const queued = await retry('overwrite');
        await downloader.downloadQueuedFile(queued.uid);
        assert(fs.existsSync(existing.path));
        assert.notStrictEqual((await files_api.getVideo(existing.uid)).path, existing.path);
    });

    it('allows only one concurrent retry of a skipped download', async function() {
        const uid = await skipDuplicate();
        const results = await Promise.all([downloader.retryDuplicateDownload(uid, 'copy'), downloader.retryDuplicateDownload(uid, 'overwrite')]);
        assert.strictEqual(results.filter(Boolean).length, 1);
        assert.strictEqual((await db_api.getRecords('download_queue')).length, 1);
    });

    it('rejects invalid actions, another owner, active downloads, and playlist skips', async function() {
        const uid = await skipDuplicate();
        assert.strictEqual(await downloader.retryDuplicateDownload(uid, 'delete'), false);
        assert.strictEqual(await downloader.retryDuplicateDownload(uid, 'overwrite', 'someone-else'), false);
        assert.strictEqual(await downloader.retryDuplicateDownload({$ne: null}, 'overwrite'), false);
        await db_api.updateRecord('download_queue', {uid}, {finished: false});
        assert.strictEqual(await downloader.retryDuplicateDownload(uid, 'overwrite'), false);
        await db_api.updateRecord('download_queue', {uid}, {finished: true, playlist_item_progress: [{id: 'one'}]});
        assert.strictEqual(await downloader.retryDuplicateDownload(uid, 'overwrite'), false);
        assert(fs.existsSync(existing.path));
    });
});
