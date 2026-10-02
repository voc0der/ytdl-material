const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const { startApp, addSampleMedia } = require('./helpers/app-process');

function clipInfo(id, title, upload_date) {
    return {
        id: id,
        display_id: id,
        title: title,
        uploader: `${title} uploader`,
        webpage_url: `https://example.com/clips/${id}`,
        thumbnail: `https://example.com/clips/${id}.jpg`,
        extractor: 'generic',
        extractor_key: 'Generic',
        upload_date: upload_date
    };
}

const FIRST = clipInfo('clip-1', 'First clip', '20240101');
const SECOND = clipInfo('clip-2', 'Second clip', '20250101');
const SONG = clipInfo('song-1', 'A song', '20230101');

/*************************************************
 * Queue entries the downloads page lists. None of
 * them is waiting to run -- each is finished or
 * paused -- so the queue never starts a real
 * download. Each carries fields the list must
 * leave out.
 ************************************************/
const QUEUED_DOWNLOADS = [
    {uid: 'download-done', url: 'https://example.com/clips/done', type: 'video', title: 'Done', finished: true, running: false, paused: false,
        error: null, timestamp_start: 3000, step_index: 3, percent_complete: 100, options: {customArgs: 'secret'}, logs: ['private']},
    {uid: 'download-failed', url: 'https://example.com/clips/failed', type: 'video', title: 'Failed', finished: true, running: false, paused: false,
        error: 'ERROR: a long yt-dlp error with paths in it', error_type: 'network', timestamp_start: 2000, options: {}},
    {uid: 'download-paused', url: 'https://example.com/clips/paused', type: 'audio', title: 'Paused', finished: false, running: false, paused: true,
        finished_step: true, error: null, timestamp_start: 1000, options: {}}
];

const NOTIFICATIONS = [
    {uid: 'note-1', type: 'download_complete', user_uid: null, read: false, timestamp: 1, data: {}},
    {uid: 'note-2', type: 'download_error', user_uid: null, read: false, timestamp: 2, data: {}}
];

/*************************************************
 * The library, through the real routes in a
 * single-user server: the records the import task
 * finds on disk, and everything the pages do with
 * them.
 ************************************************/
describe('The library through the server', function() {
    this.timeout(30000);

    let app;
    const files = {};

    const getFile = async (uid) => (await app.api.post('/api/getFile').send({uid}).expect(200)).body.file;
    const allFiles = async (options = {}) => (await app.api.post('/api/getAllFiles').send(options).expect(200)).body;

    before(async function() {
        app = await startApp({
            prepare: async ({root, media}) => {
                await addSampleMedia(media.video, {name: 'first', info: FIRST});
                await addSampleMedia(media.video, {name: 'second', info: SECOND});
                // The same source as 'first', so the two are duplicates.
                await addSampleMedia(media.video, {name: 'first-again', info: FIRST});
                await addSampleMedia(media.audio, {type: 'audio', name: 'song', info: SONG});
                // An install past the migrations that rebuild the database from db.json,
                // which would otherwise replace these on first start.
                await fs.outputJSON(path.join(root, 'appdata', 'db.json'), {
                    simplified_db_migration_complete: true,
                    new_db_system_migration_complete: true
                });
                await fs.outputJSON(path.join(root, 'appdata', 'local_db.json'), {
                    download_queue: QUEUED_DOWNLOADS,
                    notifications: NOTIFICATIONS
                });
            }
        });

        await app.api.post('/api/runTask').send({task_key: 'missing_db_records'}).expect(200);
        for (const file of (await allFiles()).files) {
            files[path.basename(file.path, path.extname(file.path))] = file;
        }
        assert.deepStrictEqual(Object.keys(files).sort(), ['first', 'first-again', 'second', 'song']);
    });

    after(async function() {
        if (app) await app.stop();
    });

    describe('Listing', function() {
        it('lists videos and audio separately', async function() {
            const {mp4s} = (await app.api.get('/api/getMp4s').expect(200)).body;
            const {mp3s} = (await app.api.get('/api/getMp3s').expect(200)).body;
            assert.deepStrictEqual(mp4s.map(file => file.title).sort(), ['First clip', 'First clip', 'Second clip']);
            assert.deepStrictEqual(mp3s.map(file => file.title), ['A song']);
        });

        it('sorts, pages and counts', async function() {
            const sorted = await allFiles({sort: {by: 'upload_date', order: -1}});
            assert.strictEqual(sorted.file_count, 4);
            assert.deepStrictEqual(sorted.files.map(file => file.title), ['Second clip', 'First clip', 'First clip', 'A song']);

            const page = await allFiles({sort: {by: 'upload_date', order: 1}, range: [0, 2]});
            assert.strictEqual(page.file_count, 4);
            assert.deepStrictEqual(page.files.map(file => file.title), ['A song', 'First clip']);
        });

        it('filters by type and by text', async function() {
            const audio = await allFiles({file_type_filter: 'audio_only'});
            assert.deepStrictEqual(audio.files.map(file => file.uid), [files.song.uid]);

            const search = await allFiles({text_search: 'second'});
            assert.deepStrictEqual(search.files.map(file => file.uid), [files.second.uid]);
        });

        it('returns one file, or says it has none', async function() {
            const file = await getFile(files.second.uid);
            assert.strictEqual(file.title, 'Second clip');
            assert.strictEqual(file.url, 'https://example.com/clips/clip-2');

            const missing = await app.api.post('/api/getFile').send({uid: 'no-such-file'}).expect(200);
            assert.deepStrictEqual(missing.body, {success: false});
        });
    });

    describe('Editing a file', function() {
        it('saves the fields the info dialog edits', async function() {
            const res = await app.api.post('/api/updateFile').send({
                uid: files.second.uid,
                change_obj: {title: 'Renamed clip', favorite: true}
            }).expect(200);
            assert.deepStrictEqual(res.body, {success: true});

            const file = await getFile(files.second.uid);
            assert.strictEqual(file.title, 'Renamed clip');
            assert.strictEqual(file.favorite, true);
            assert.deepStrictEqual((await allFiles({favorite_filter: true})).files.map(file => file.uid), [files.second.uid]);
        });

        it('drops fields it does not edit, and refuses when nothing is left', async function() {
            const res = await app.api.post('/api/updateFile').send({
                uid: files.second.uid,
                change_obj: {path: '/etc/passwd', user_uid: 'someone-else'}
            }).expect(200);
            assert.deepStrictEqual(res.body, {success: false, error: 'No editable changes provided'});
            assert.strictEqual((await getFile(files.second.uid)).path, files.second.path);
        });

        it('refuses a thumbnail outside the media folders', async function() {
            const res = await app.api.post('/api/updateFile').send({
                uid: files.second.uid,
                change_obj: {thumbnailPath: path.join(app.root, 'appdata', 'default.json')}
            }).expect(200);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.error, /inside a configured media folder/);
        });

        it('says when the file does not exist', async function() {
            const res = await app.api.post('/api/updateFile').send({uid: 'no-such-file', change_obj: {title: 'x'}}).expect(200);
            assert.deepStrictEqual(res.body, {success: false, error: 'File could not be found'});
        });

        it('counts a view', async function() {
            await app.api.post('/api/incrementViewCount').send({file_uid: files.song.uid}).expect(200);
            await app.api.post('/api/incrementViewCount').send({file_uid: files.song.uid}).expect(200);
            assert.strictEqual((await getFile(files.song.uid)).local_view_count, 2);
            await app.api.post('/api/incrementViewCount').send({file_uid: 'no-such-file'}).expect(404);
        });

        it('turns sharing on and off', async function() {
            await app.api.post('/api/enableSharing').send({uid: files.song.uid, is_playlist: false}).expect(200);
            assert.strictEqual((await getFile(files.song.uid)).sharingEnabled, true);
            await app.api.post('/api/disableSharing').send({uid: files.song.uid, is_playlist: false}).expect(200);
            assert.strictEqual((await getFile(files.song.uid)).sharingEnabled, false);
        });

        it('tracks where another player is in a stream', async function() {
            const stream = {uid: files.song.uid, playback_timestamp: 42, unix_timestamp: Date.now() / 1000, playing: true};
            await app.api.post('/api/updateConcurrentStream').send(stream).expect(200);
            const live = await app.api.post('/api/checkConcurrentStream').send({uid: files.song.uid}).expect(200);
            assert.strictEqual(live.body.stream.playback_timestamp, 42);

            // A stream nobody has updated for a while is dropped.
            await app.api.post('/api/updateConcurrentStream').send({...stream, unix_timestamp: Date.now() / 1000 - 60}).expect(200);
            const dead = await app.api.post('/api/checkConcurrentStream').send({uid: files.song.uid}).expect(200);
            assert.strictEqual(dead.body.stream, undefined);
        });
    });

    describe('Playlists', function() {
        let playlist;

        it('creates one from files', async function() {
            const res = await app.api.post('/api/createPlaylist').send({playlistName: 'Mix', uids: [files.first.uid]}).expect(200);
            assert.strictEqual(res.body.success, true);
            playlist = res.body.new_playlist;
            assert.strictEqual(playlist.name, 'Mix');
            assert.deepStrictEqual(playlist.uids, [files.first.uid]);
        });

        it('adds a file, and refuses one that does not exist', async function() {
            const added = await app.api.post('/api/addFileToPlaylist').send({playlist_id: playlist.id, file_uid: files.song.uid}).expect(200);
            assert.strictEqual(added.body.success, true);
            const refused = await app.api.post('/api/addFileToPlaylist').send({playlist_id: playlist.id, file_uid: 'no-such-file'}).expect(200);
            assert.deepStrictEqual(refused.body, {success: false});
        });

        it('returns it with its files in order', async function() {
            const res = await app.api.post('/api/getPlaylist').send({playlist_id: playlist.id, include_file_metadata: true}).expect(200);
            assert.strictEqual(res.body.success, true);
            assert.deepStrictEqual(res.body.playlist.uids, [files.first.uid, files.song.uid]);
            assert.deepStrictEqual(res.body.file_objs.map(file => file.uid), [files.first.uid, files.song.uid]);
        });

        it('saves a reordered playlist', async function() {
            const reordered = {...playlist, uids: [files.song.uid, files.first.uid]};
            await app.api.post('/api/updatePlaylist').send({playlist: reordered}).expect(200);
            const res = await app.api.post('/api/getPlaylist').send({playlist_id: playlist.id}).expect(200);
            assert.deepStrictEqual(res.body.playlist.uids, [files.song.uid, files.first.uid]);
        });

        it('lists it with the cover art of the file it plays first', async function() {
            // The reordered playlist plays the song first, so the song's art is its cover.
            const art_path = files.song.path.replace(/\.[^.]+$/, '.jpg');
            await fs.writeFile(art_path, 'cover art');
            await app.api.post('/api/updateFile').send({uid: files.song.uid, change_obj: {thumbnailPath: art_path}}).expect(200);

            const res = await app.api.post('/api/getPlaylists').send({}).expect(200);
            const listed = res.body.playlists.find(item => item.id === playlist.id);
            assert.strictEqual(listed.thumbnailFileUid, files.song.uid);
            const cover = await app.api.get(`/api/thumbnail/${encodeURIComponent(listed.thumbnailFileUid)}`).expect(200);
            assert.strictEqual(cover.body.toString(), 'cover art');
        });

        it('lists playlists, with categories alongside when asked', async function() {
            const category = (await app.api.post('/api/createCategory').send({name: 'As a playlist'}).expect(200)).body.new_category;
            try {
                const plain = await app.api.post('/api/getPlaylists').send({}).expect(200);
                assert.deepStrictEqual(plain.body.playlists.map(item => item.id), [playlist.id]);

                const with_categories = await app.api.post('/api/getPlaylists').send({include_categories: true}).expect(200);
                assert(with_categories.body.playlists.some(item => item.id === playlist.id));
            } finally {
                await app.api.post('/api/deleteCategory').send({category_uid: category.uid}).expect(200);
            }
        });

        it('deletes the playlist and keeps its files', async function() {
            const res = await app.api.post('/api/deletePlaylist').send({playlist_id: playlist.id}).expect(200);
            assert.deepStrictEqual(res.body, {success: true, playlist_removed: true, deleted_file_count: 0, failed_file_count: 0});
            assert(fs.existsSync(files.first.path));
            const gone = await app.api.post('/api/getPlaylist').send({playlist_id: playlist.id}).expect(200);
            assert.strictEqual(gone.body.success, false);

            const again = await app.api.post('/api/deletePlaylist').send({playlist_id: playlist.id}).expect(200);
            assert.strictEqual(again.body.playlist_removed, false);
        });
    });

    describe('Categories', function() {
        const categories = async () => (await app.api.post('/api/getAllCategories').send({}).expect(200)).body.categories;

        it('adds the defaults only to an empty list', async function() {
            const created = await app.api.post('/api/createDefaultCategories').send({}).expect(200);
            assert.strictEqual(created.body.success, true);
            assert(created.body.categories.length > 0);
            assert.strictEqual((await categories()).length, created.body.categories.length);

            const refused = await app.api.post('/api/createDefaultCategories').send({}).expect(200);
            assert.strictEqual(refused.body.success, false);
            assert.match(refused.body.error, /no categories exist/);
        });

        it('edits, replaces and deletes them', async function() {
            const [first] = await categories();
            await app.api.post('/api/updateCategory').send({category: {...first, name: 'Renamed'}}).expect(200);
            assert((await categories()).some(category => category.uid === first.uid && category.name === 'Renamed'));

            const replacement = {uid: 'only-category', name: 'Only', rules: [], show_as_filter: true, custom_output: ''};
            await app.api.post('/api/updateCategories').send({categories: [replacement]}).expect(200);
            assert.deepStrictEqual((await categories()).map(category => category.uid), ['only-category']);

            await app.api.post('/api/deleteCategory').send({category_uid: 'only-category'}).expect(200);
            assert.deepStrictEqual(await categories(), []);
        });
    });

    describe('Archives', function() {
        const archive_upload = (text) => `data:text/plain;base64,${Buffer.from(text).toString('base64')}`;
        const archives = async () => (await app.api.post('/api/getArchives').send({type: 'audio'}).expect(200)).body.archives;

        it('imports an archive file, skipping lines that are not an extractor and an id', async function() {
            const res = await app.api.post('/api/importArchive').send({
                archive: archive_upload('generic one\ngeneric two\nnot a valid line at all\n'),
                type: 'audio'
            }).expect(200);
            assert.deepStrictEqual(res.body, {success: true, imported_count: 2});
            assert.deepStrictEqual((await archives()).map(item => item.id).sort(), ['one', 'two']);
        });

        it('exports it as a download', async function() {
            const res = await app.api.post('/api/downloadArchive').send({type: 'audio'}).buffer(true)
                .parse((stream, callback) => {
                    let text = '';
                    stream.on('data', chunk => text += chunk);
                    stream.on('end', () => callback(null, text));
                }).expect(200);
            assert.strictEqual(res.headers['content-disposition'], 'attachment; filename=archive.txt');
            assert.deepStrictEqual(res.body.split('\n').sort(), ['generic one', 'generic two']);
        });

        it('removes items', async function() {
            const res = await app.api.post('/api/deleteArchiveItems').send({archives: [{extractor: 'generic', id: 'one', type: 'audio'}]}).expect(200);
            assert(res.body.success);
            assert.deepStrictEqual((await archives()).map(item => item.id), ['two']);
        });
    });

    describe('Duplicates', function() {
        it('finds files from the same source', async function() {
            const summary = await app.api.post('/api/getDuplicateSummary').send({}).expect(200);
            assert.deepStrictEqual(summary.body, {has_duplicates: true, duplicate_group_count: 1});

            const {duplicates} = (await app.api.post('/api/getDuplicates').send({}).expect(200)).body;
            assert.strictEqual(duplicates.length, 1);
        });

        it('removes all but one of them', async function() {
            const res = await app.api.post('/api/removeNewestDuplicates').send({duplicate_key: files.first.duplicate_key}).expect(200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.removed_uids.length, 1);

            const remaining = (await allFiles({text_search: 'First'})).files;
            assert.strictEqual(remaining.length, 1);
            const removed = [files.first, files['first-again']].find(file => file.uid === res.body.removed_uids[0]);
            assert(!fs.existsSync(removed.path));

            const summary = await app.api.post('/api/getDuplicateSummary').send({}).expect(200);
            assert.strictEqual(summary.body.has_duplicates, false);
        });

        it('does nothing for a key with one file or none', async function() {
            const res = await app.api.post('/api/removeDuplicates').send({duplicate_key: 'Generic:nothing:video', removal_mode: 'oldest'}).expect(200);
            assert.deepStrictEqual(res.body, {success: true, removed_uids: []});
            const empty = await app.api.post('/api/removeDuplicates').send({}).expect(200);
            assert.deepStrictEqual(empty.body, {success: false, removed_uids: []});
        });
    });

    describe('Downloads page', function() {
        const list = async (body = {}) => (await app.api.post('/api/downloads').send(body).expect(200)).body;

        it('pages the queue, newest first, with only the fields the page shows', async function() {
            const page = await list({page_size: 2});
            assert.strictEqual(page.total_count, 3);
            assert.strictEqual(page.page_size, 2);
            assert.deepStrictEqual(page.downloads.map(download => download.uid), ['download-done', 'download-failed']);
            assert.strictEqual(page.downloads[0].logs, undefined);
            assert.strictEqual(page.downloads[0].options, undefined);

            const last = await list({page_size: 2, page: 99});
            assert.strictEqual(last.page, 1);
            assert.deepStrictEqual(last.downloads.map(download => download.uid), ['download-paused']);
        });

        it('summarizes an error rather than sending its output', async function() {
            const {downloads} = await list({uids: ['download-failed']});
            assert.strictEqual(downloads.length, 1);
            assert.strictEqual(downloads[0].error, 'Download failed (network). Detailed output is unavailable for this legacy queue entry.');
            assert.strictEqual(downloads[0].error_details_omitted, true);
        });

        it('lists only what is unfinished when asked', async function() {
            const unfinished = await list({only_unfinished: true});
            assert.deepStrictEqual(unfinished.downloads.map(download => download.uid), ['download-paused']);
        });

        it('checks the uids it is asked for', async function() {
            await app.api.post('/api/downloads').send({uids: 'download-done'}).expect(400);
            const too_many = Array.from({length: 101}, (_, i) => `download-${i}`);
            await app.api.post('/api/downloads').send({uids: too_many}).expect(400);
            assert.deepStrictEqual(await list({uids: []}), {downloads: [], total_count: 0, page: 0, page_size: 0});
            assert.deepStrictEqual(await list({uids: [' ', 7]}), {downloads: [], total_count: 0, page: 0, page_size: 0});
        });

        it('returns one download, or null', async function() {
            const found = await app.api.post('/api/download').send({download_uid: 'download-done'}).expect(200);
            assert.strictEqual(found.body.download.title, 'Done');
            const missing = await app.api.post('/api/download').send({download_uid: 'no-such-download'}).expect(200);
            assert.deepStrictEqual(missing.body, {download: null});
        });

        it('refuses to act on a download that is not in the queue', async function() {
            for (const route of ['clearDownload', 'pauseDownload', 'resumeDownload', 'restartDownload', 'cancelDownload']) {
                const res = await app.api.post(`/api/${route}`).send({download_uid: 'no-such-download'}).expect(200);
                assert.strictEqual(res.body.success, false, route);
            }
        });

        it('clears finished downloads, and keeps the rest', async function() {
            const res = await app.api.post('/api/clearDownloads').send({clear_finished: true}).expect(200);
            assert(res.body.success);
            const remaining = (await list()).downloads.map(download => download.uid).sort();
            assert.deepStrictEqual(remaining, ['download-failed', 'download-paused']);
        });
    });

    describe('Notifications', function() {
        const notifications = async () => (await app.api.post('/api/getNotifications').send({}).expect(200)).body.notifications;

        it('lists them and marks them read', async function() {
            const uids = (await notifications()).map(note => note.uid);
            assert(uids.includes('note-1') && uids.includes('note-2'));
            await app.api.post('/api/setNotificationsToRead').send({}).expect(200);
            assert((await notifications()).every(note => note.read === true));
        });

        it('deletes one, then the rest', async function() {
            const missing = await app.api.post('/api/deleteNotification').send({}).expect(200);
            assert.deepStrictEqual(missing.body, {success: false});

            await app.api.post('/api/deleteNotification').send({uid: 'note-1'}).expect(200);
            const uids = (await notifications()).map(note => note.uid);
            assert(!uids.includes('note-1') && uids.includes('note-2'));

            await app.api.post('/api/deleteAllNotifications').send({}).expect(200);
            assert.deepStrictEqual(await notifications(), []);
        });
    });

    describe('Subscriptions without any', function() {
        it('lists none, and says so for one that does not exist', async function() {
            const list = await app.api.post('/api/getSubscriptions').send({}).expect(200);
            assert.deepStrictEqual(list.body, {subscriptions: []});

            await app.api.post('/api/getSubscription').send({id: 'no-such-subscription'}).expect(400);
            await app.api.get('/api/subscriptionArtwork/no-such-subscription').expect(404);

            const download = await app.api.post('/api/downloadVideosForSubscription').send({subID: 'no-such-subscription'}).expect(200);
            assert.deepStrictEqual(download.body, {success: false});
        });

        it('refuses arguments that could run commands, and URLs that are not http', async function() {
            const exec = await app.api.post('/api/subscribe').send({
                name: 'Refused', url: 'https://example.com/channel', customArgs: '--exec,,rm -rf /'
            }).expect(400);
            assert.deepStrictEqual(exec.body, {success: false, error: 'These arguments are not allowed: --exec'});

            const local_file = await app.api.post('/api/subscribe').send({name: 'Refused', url: 'file:///etc/passwd'}).expect(400);
            assert.strictEqual(local_file.body.error, 'Only http and https URLs can be downloaded');
            await app.api.post('/api/downloadFile').send({url: 'file:///etc/passwd', type: 'video'}).expect(400);

            assert.deepStrictEqual((await app.api.post('/api/getSubscriptions').send({}).expect(200)).body, {subscriptions: []});
        });
    });

    describe('Building download arguments', function() {
        it('generates the arguments a download would run with', async function() {
            const audio = (await app.api.post('/api/generateArgs').send({url: 'https://example.com/clips/new', type: 'audio'}).expect(200)).body.args;
            assert(audio.includes('-x'));
            assert(audio[audio.indexOf('-o') + 1].startsWith(app.media.audio));

            const video = (await app.api.post('/api/generateArgs')
                .send({url: 'https://example.com/clips/new', type: 'video', selectedHeight: '720'}).expect(200)).body.args;
            assert(video.includes('best[height=720]+bestaudio'));
            assert(video[video.indexOf('-o') + 1].startsWith(app.media.video));
        });
    });

    describe('Snipping', function() {
        it('cuts a range into a new file, reporting progress until it is done', async function() {
            const started = await app.api.post('/api/snipFile').send({uid: files.second.uid, start: 0, end: 1}).expect(200);
            assert.strictEqual(started.body.success, true);

            let status;
            const deadline = Date.now() + 20000;
            do {
                await new Promise(resolve => setTimeout(resolve, 100));
                status = (await app.api.post('/api/getSnipStatus').send({job_uid: started.body.job_uid}).expect(200)).body;
            } while (status.status === 'snipping' && Date.now() < deadline);

            assert.strictEqual(status.status, 'complete', JSON.stringify(status));
            assert.strictEqual(status.percent, 100);
            assert(status.file && status.file.uid);
            assert(fs.existsSync((await getFile(status.file.uid)).path));
        });

        it('says when there is nothing to snip or no such job', async function() {
            const no_uid = await app.api.post('/api/snipFile').send({}).expect(200);
            assert.deepStrictEqual(no_uid.body, {success: false, error: 'uid is required'});
            const no_job = await app.api.post('/api/getSnipStatus').send({job_uid: '__proto__'}).expect(200);
            assert.strictEqual(no_job.body.success, false);
        });
    });

    describe('Telegram webhook', function() {
        let config_file;

        before(async function() {
            config_file = (await app.api.get('/api/config').expect(200)).body.config_file;
        });

        after(async function() {
            await app.api.post('/api/setConfig').send({new_config_file: config_file}).expect(200);
        });

        it('is not there while the integration is off', async function() {
            await app.api.post('/api/telegramRequest').send({message: {text: 'hi'}}).expect(404);
        });

        it('checks the secret, the message and the chat before doing anything', async function() {
            const enabled = JSON.parse(JSON.stringify(config_file));
            Object.assign(enabled.YtdlMaterial.API, {use_telegram_API: true, telegram_webhook_secret: 'hook-secret', telegram_chat_id: '42'});
            await app.api.post('/api/setConfig').send({new_config_file: enabled}).expect(200);

            const message = {message: {text: 'https://example.com/clips/9', chat: {id: 7}}};
            await app.api.post('/api/telegramRequest').send(message).expect(401);
            await app.api.post('/api/telegramRequest').set('X-Telegram-Bot-Api-Secret-Token', 'wrong').send(message).expect(401);
            await app.api.post('/api/telegramRequest').set('X-Telegram-Bot-Api-Secret-Token', 'hook-secret').send({}).expect(400);
            await app.api.post('/api/telegramRequest').set('X-Telegram-Bot-Api-Secret-Token', 'hook-secret').send(message).expect(403);
        });
    });

    // Last, since it empties the library.
    describe('Deleting', function() {
        it('deletes one file from disk and the database', async function() {
            const deleted = await app.api.post('/api/deleteFile').send({uid: files.song.uid}).expect(200);
            assert.strictEqual(deleted.body, true);
            assert(!fs.existsSync(files.song.path));
            const res = await app.api.post('/api/getFile').send({uid: files.song.uid}).expect(200);
            assert.strictEqual(res.body.success, false);
        });

        it('deletes everything a search matches', async function() {
            const before = (await allFiles()).file_count;
            const res = await app.api.post('/api/deleteAllFiles').send({text_search: 'Renamed'}).expect(200);
            assert.deepStrictEqual(res.body, {file_count: 1, delete_count: 1});
            assert.strictEqual((await allFiles()).file_count, before - 1);
        });
    });
});
