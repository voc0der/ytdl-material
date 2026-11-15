const { assert, fs, os, path, files_api, db_api, utils, config_api, useTemporaryMediaRoots } = require('./test-shared');
const transcoding = require('../transcoding');
const logger = require('../logger');

// The library's less travelled paths: subtitles it has to work out for itself, imports and
// snips that fail partway, and playlists that have to follow a subscription's files.
describe('File library edges', function() {
    let media;
    let originals;
    let logged;
    const stub = (object, name, value) => { originals.push([object, name, object[name]]); object[name] = value; };

    beforeEach(function() {
        originals = [];
        logged = [];
        media = useTemporaryMediaRoots({ ytdl_multi_user_mode: false, ytdl_include_metadata: true, ytdl_use_youtubedl_archive: false });
        stub(logger, 'warn', message => logged.push(`warn: ${message}`));
        stub(logger, 'error', message => logged.push(`error: ${message}`));
    });

    afterEach(function() {
        for (const [object, name, value] of originals.reverse()) object[name] = value;
        media.restore();
    });

    describe('subtitles', function() {
        let clip;
        beforeEach(function() {
            clip = { uid: 'clip', path: path.join(media.video, 'Clip.mp4'), isAudio: false, user_uid: null };
            fs.writeFileSync(clip.path, 'media');
            stub(transcoding, 'probeStreams', async () => [
                { codec_type: 'video' },
                { codec_type: 'subtitle', tags: {} },
                { codec_type: 'subtitle', tags: { language: 'fra', title: 'Français' } }
            ]);
        });

        it('names a track with neither a name nor a language by its number, and writes each track out when asked', async function() {
            const written = [];
            stub(transcoding, 'runFfmpeg', async args => { written.push(args.at(-1)); return { success: true }; });
            // An old sidecar that will not go is written over all the same.
            stub(fs, 'remove', async () => { throw new Error('busy'); });

            const with_subtitles = await files_api.attachFileSubtitles(clip, true);

            assert.deepStrictEqual(with_subtitles.subtitles.map(track => track.label), ['Subtitle 1', 'Français']);
            assert.deepStrictEqual(written, [path.join(media.video, 'Clip.player-subtitles.vtt'), path.join(media.video, 'Clip.player-subtitles.1.vtt')]);
            assert(logged.includes(`warn: Failed to remove stale subtitle sidecar '${written[0]}'.`));
        });

        it('gives up on a track ffmpeg cannot write out', async function() {
            stub(transcoding, 'runFfmpeg', async () => ({ success: false, error: 'Stream map matches no streams' }));
            const real_remove = fs.remove;
            let removals = 0;
            // The clean-up after the failure is the one that fails.
            stub(fs, 'remove', async file => { if (++removals > 1) throw new Error('busy'); return real_remove(file); });

            assert.strictEqual(await files_api.ensureSubtitleSidecarForFile(clip, 0), null);
            assert.deepStrictEqual(logged, [`warn: Failed to extract subtitle sidecar for '${clip.path}': Stream map matches no streams`]);
        });

        it('writes no sidecar outside the media folders', async function() {
            const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-elsewhere-'));
            const outside = path.join(elsewhere, 'Clip.mp4');
            fs.writeFileSync(outside, 'media');
            try {
                assert.strictEqual(await files_api.extractSubtitleSidecar(outside, 0), null);
                assert.deepStrictEqual(logged, [`warn: Refusing to write a subtitle sidecar outside the media roots: ${path.join(elsewhere, 'Clip.player-subtitles.vtt')}`]);
            } finally {
                fs.removeSync(elsewhere);
            }
        });

        it('reads no subtitles out of something that is not a regular file', async function() {
            const folder = path.join(media.video, 'Folder.mp4');
            fs.ensureDirSync(folder);
            assert.strictEqual(await files_api.ensureSubtitleSidecarForFile({ uid: 'folder', path: folder }, 0), null);
            assert.deepStrictEqual(logged, [`error: Refusing to extract subtitles from ${folder}: it is not a regular file inside its owner's media folder.`]);
        });
    });

    it('reads the source id out of a short or embedded address', function() {
        for (const address of ['https://www.youtube.com/shorts/abc123', 'https://www.youtube.com/embed/abc123', 'https://m.youtube.com/v/abc123']) {
            assert.strictEqual(files_api.extractSourceMetadataFromUrl(address).source_id, 'abc123', address);
        }
    });

    it('works out where a file it is handed came from, and drops its metadata file when metadata is not kept', async function() {
        config_api.setConfigItem('ytdl_include_metadata', false);
        const file_path = path.join(media.video, 'Given.mp4');
        fs.writeFileSync(file_path, 'media');
        fs.writeJSONSync(path.join(media.video, 'Given.info.json'), { id: 'given-id', extractor_key: 'Generic', title: 'Given' });
        const dropped = [];
        stub(utils, 'deleteJSONFile', (file, type) => dropped.push([file, type]));

        const registered = await files_api.registerFileDB(file_path, 'video', null, null, null, null,
            { id: 'given-id', title: 'Given', path: file_path, url: 'https://example.test/given', isAudio: false, vcodec: 'h264', acodec: 'aac' });
        try {
            assert.deepStrictEqual([registered.source_id, registered.duplicate_key], ['given-id', 'Generic:given-id:video']);
            assert.deepStrictEqual(dropped, [[file_path, 'video']]);
        } finally {
            await db_api.removeRecord('files', { uid: registered.uid });
        }
    });

    it('keeps the replaced file when its old media will not go, and says so', async function() {
        const replacement = path.join(media.video, 'Clip [redownload].mp4');
        fs.writeFileSync(replacement, 'new media');
        fs.writeJSONSync(path.join(media.video, 'Clip [redownload].info.json'), { id: 'clip-id', extractor_key: 'Generic', title: 'Clip' });
        const old_path = path.join(media.video, 'Clip.mp4');
        stub(files_api, 'getVideo', async uid => ({ uid, path: old_path, isAudio: false, user_uid: null, source_id: 'clip-id',
            source_extractor: 'Generic', duplicate_key: 'Generic:clip-id:video', source_metadata_checked: true }));
        stub(db_api, 'updateRecord', async () => true);
        stub(db_api, 'getRecords', async () => []);
        const replace = () => files_api.registerFileDB(replacement, 'video', null, null, null, null,
            { id: 'clip-id', title: 'Clip', path: replacement, url: 'https://example.test/clip', isAudio: false, vcodec: 'h264', acodec: 'aac', size: 9 },
            false, 'old');

        // Something that is not a media file has taken the old path.
        fs.ensureDirSync(old_path);
        assert.strictEqual((await replace()).path, replacement);
        assert(fs.existsSync(old_path));
        // Or looking for it fails.
        fs.removeSync(old_path);
        const real_path_exists = fs.pathExists;
        stub(fs, 'pathExists', async file => { if (file === old_path) throw new Error('permission denied'); return real_path_exists(file); });
        assert.strictEqual((await replace()).path, replacement);

        assert.deepStrictEqual(logged, [`error: Refusing to delete ${old_path}: it is not a regular file inside the configured media folders.`,
            'warn: Replaced file \'old\', but could not remove all of its old media and sidecars.',
            'warn: Replaced file \'old\', but could not remove its old media: permission denied']);
    });

    it('works out where the files it has not checked yet came from before counting duplicates', async function() {
        const writes = [];
        stub(db_api, 'getRecords', async (table, filter) => filter && filter.source_metadata_checked === null
            ? [{ uid: 'legacy', url: 'https://www.twitch.tv/videos/77' }] : []);
        stub(db_api, 'updateRecord', async (table, filter, update) => { writes.push([filter, update]); return true; });

        assert.strictEqual((await files_api.getDuplicateSummary()).has_duplicates, false);

        assert.deepStrictEqual(writes, [[{ uid: 'legacy' }, { source_id: '77', source_extractor: 'twitch', duplicate_key: 'twitch:77:video',
            source_metadata_checked: true }]]);
    });

    it('cannot import a file that is gone by the time it is read', async function() {
        const missing = path.join(media.video, 'Vanished.mp4');
        assert.strictEqual(await files_api.registerFileDB(missing, 'video', null, null, null, null, null, true), false);
        assert(logged.some(line => line.startsWith(`error: Could not stat ${missing}:`)), logged.join('\n'));
    });

    it('drops a snip it cannot register, after going on past a thumbnail it could not copy', async function() {
        const source = path.join(media.video, 'Long.mp4');
        fs.writeFileSync(source, 'media');
        stub(files_api, 'getVideo', async () => ({ uid: 'long', path: source, isAudio: false, duration: 60, title: 'Long', id: 'long' }));
        stub(utils, 'snipFile', async (from, to) => { fs.writeFileSync(to, 'snip'); return true; });
        // Named, but not on the disk.
        stub(utils, 'getDownloadedThumbnail', () => path.join(media.video, 'Long.jpg'));
        stub(files_api, 'registerFileDB', async () => false);

        assert.deepStrictEqual(await files_api.snipFile('long', 5, 10), { success: false, error: 'Failed to register the snipped file' });

        assert.deepStrictEqual(fs.readdirSync(media.video).filter(name => name.endsWith('.mp4')), ['Long.mp4']);
        assert(logged.some(line => line.startsWith(`warn: Could not copy thumbnail for snip of '${source}':`)), logged.join('\n'));
    });

    it('says which files it could not import, and goes on to the rest', async function() {
        for (const name of ['Refused.mp4', 'Broken.mp4']) fs.writeFileSync(path.join(media.video, name), 'media');
        stub(files_api, 'registerFileDB', async file_path => {
            if (file_path.endsWith('Broken.mp4')) throw new Error('bad header');
            return false;
        });

        assert.deepStrictEqual(await files_api.importUnregisteredFiles(), []);

        assert(logged.includes(`error: Failed to import ${path.join(media.video, 'Refused.mp4')} automatically.`), logged.join('\n'));
        assert(logged.includes(`error: Unexpected error importing ${path.join(media.video, 'Broken.mp4')}: bad header`), logged.join('\n'));
    });

    it('fills in a metadata field from the files on disk, or says why it could not', async function() {
        stub(db_api, 'getFileDirectoriesAndDBs', async () => [{ basePath: media.video, type: 'video' }]);
        stub(utils, 'getDownloadedFilesByType', async () => [{ uid: 'counted', view_count: 5 }, { uid: 'uncounted' }]);
        const updates = [];
        stub(db_api, 'bulkUpdateRecordsByKey', async (table, key, update) => { updates.push([table, key, update]); return true; });

        assert.strictEqual(await files_api.addMetadataPropertyToDB('view_count'), true);
        assert.deepStrictEqual(updates, [['files', 'uid', { counted: { view_count: 5 } }]]);

        db_api.getFileDirectoriesAndDBs = async () => { throw new Error('database offline'); };
        assert.strictEqual(await files_api.addMetadataPropertyToDB('view_count'), false);
        assert.deepStrictEqual(logged, ['error: Error: database offline']);
    });

    describe('a subscription\'s playlists', function() {
        let records;
        let filters;
        let updated;
        beforeEach(function() {
            filters = [];
            updated = [];
            records = { subscriptions: { id: 'sub', name: 'Channel', auto_create_playlist: true }, playlists: [], files: [] };
            stub(db_api, 'getRecord', async table => records[table]);
            stub(db_api, 'getRecords', async (table, filter) => { filters.push([table, filter]); return records[table]; });
            stub(db_api, 'updateRecord', async () => true);
            stub(files_api, 'getVideosByUIDs', async uids => uids.filter(uid => uid !== 'deleted').map(uid => ({ uid })));
            stub(files_api, 'updatePlaylist', async playlist => { updated.push([...playlist.uids]); return true; });
        });

        it('drops a deleted file from its playlist when a file it already holds arrives again', async function() {
            records.playlists = [{ id: 'own', source_sub_id: 'sub', uids: ['deleted', 'kept'] }];
            assert.deepStrictEqual((await files_api.syncSubscriptionPlaylist('sub', null, 'kept')).uids, ['kept']);
            assert.deepStrictEqual(updated, [['kept']]);
        });

        it('adds the subscription\'s files its playlist is missing', async function() {
            records.playlists = [{ id: 'own', source_sub_id: 'sub', uids: ['first'] }];
            records.files = [{ uid: 'first' }, { uid: 'second' }];
            assert.deepStrictEqual((await files_api.syncSubscriptionPlaylist('sub')).uids, ['first', 'second']);
            assert.deepStrictEqual(updated, [['first', 'second']]);
        });

        it('looks only at the account\'s own files and playlists when copying a channel\'s playlists', async function() {
            config_api.setConfigItem('ytdl_multi_user_mode', true);
            records.subscriptions = { id: 'sub', name: 'Channel', retrieve_channel_playlists: true,
                channel_playlists: [{ id: 'PL1', title: 'Talks', video_ids: ['v1'] }] };
            records.files = [{ uid: 'talk', source_id: 'v1' }];
            const created = [];
            stub(files_api, 'createPlaylist', async (name, uids, owner) => { created.push([name, uids, owner]); return { id: 'talks' }; });

            await files_api.syncSubscriptionPlaylist('sub', 'alice');

            assert.deepStrictEqual(created, [['Talks', ['talk'], 'alice']]);
            assert.deepStrictEqual(filters.filter(([table]) => table === 'files' || table === 'playlists').map(([, filter]) => filter.user_uid),
                ['alice', 'alice']);
        });

        it('reports a playlist it could not update when the subscription\'s files leave it', async function() {
            records.playlists = [{ id: 'mix', source_sub_id: 'sub', uids: ['from-sub', 'mine'] }];
            records.files = [{ uid: 'from-sub' }];
            files_api.updatePlaylist = async () => false;

            assert.strictEqual(await files_api.cleanupSubscriptionPlaylists('sub'), false);
            assert(filters.some(([table, filter]) => table === 'files' && filter.sub_id === 'sub'));
        });
    });

    it('deletes a file even when a stream of it will not close', async function() {
        const file_path = path.join(media.video, 'Open.mp4');
        fs.writeFileSync(file_path, 'media');
        await db_api.insertRecordIntoTable('files', { uid: 'open', path: file_path, isAudio: false, title: 'Open' });
        stub(config_api, 'descriptors', { open: [{ destroy() { throw new Error('already closed'); } }] });
        try {
            assert.strictEqual(await files_api.deleteFile('open'), true);
            assert(!fs.existsSync(file_path));
        } finally {
            await db_api.removeRecord('files', { uid: 'open' });
        }
    });

    it('counts the orphans it could not delete', async function() {
        fs.writeFileSync(path.join(media.video, 'Orphan.mp4'), 'media');
        fs.writeFileSync(path.join(media.video, 'Lonely.info.json'), '{}');
        stub(fs, 'remove', async () => { throw new Error('read-only file system'); });

        assert.deepStrictEqual(await files_api.deleteOrphanFiles(), { deleted_count: 0, failed_count: 2 });
    });

    it('searches titles through the text index on MongoDB', async function() {
        stub(db_api, 'isUsingMongoDB', () => true);
        const filters = [];
        stub(db_api, 'getRecords', async (table, filter) => { filters.push(filter); return table === 'files' && filter && filter.$text ? [] : 0; });

        await files_api.getAllFiles(null, null, ' talk ', null, false, null, null);

        assert.deepStrictEqual(filters[0].$text, { $search: utils.createEdgeNGrams('talk') });
    });
});
