const { assert, fs, path, files_api, db_api, utils, useTemporaryMediaRoots } = require('./test-shared');
const { useFakeMongo, MONGO_URL } = require('./helpers/fake-mongo');

describe('File metadata recovery', function() {
    let media;
    let originals;
    const stub = (object, name, value) => { originals.push([object, name, object[name]]); object[name] = value; };
    beforeEach(function() { media = useTemporaryMediaRoots(); originals = []; });
    afterEach(function() {
        for (const [object, name, value] of originals.reverse()) object[name] = value;
        media.restore();
    });

    it('hydrates and persists source identity from a sidecar, then uses the cached result', async function() {
        const file = { uid: 'clip', path: path.join(media.video, 'clip.mp4'), isAudio: false };
        fs.writeFileSync(file.path, 'media');
        fs.writeJSONSync(path.join(media.video, 'clip.info.json'), { id: ' source ', extractor_key: 'Generic' });
        const writes = [];
        stub(db_api, 'updateRecord', async (...args) => { writes.push(args); return true; });
        assert.strictEqual(await files_api.hydrateFileSourceMetadata(file, true), file);
        assert.strictEqual(file.source_id, 'source');
        assert.strictEqual(file.source_extractor, 'Generic');
        assert.strictEqual(file.duplicate_key, 'Generic:source:video');
        assert.deepStrictEqual(writes, [['files', { uid: 'clip' }, {
            source_id: 'source', source_extractor: 'Generic', duplicate_key: 'Generic:source:video', source_metadata_checked: true
        }]]);
        stub(utils, 'getJSON', () => { throw new Error('cached metadata should not be read again'); });
        assert.strictEqual(await files_api.hydrateFileSourceMetadata(file, true), file);
        assert.strictEqual(writes.length, 1);
        assert.strictEqual(await files_api.hydrateFileSourceMetadata(null), null);
    });

    it('uses the source URL when a sidecar has no identity and marks unrecognized files as checked', async function() {
        const writes = [];
        stub(db_api, 'updateRecord', async (...args) => { writes.push(args); return true; });
        const audio = { uid: 'audio', url: 'https://www.twitch.tv/videos/123', isAudio: true };
        await files_api.hydrateFileSourceMetadata(audio, true);
        assert.strictEqual(audio.duplicate_key, 'twitch:123:audio');
        const unknown = { uid: 'unknown', url: 'https://example.test/clip' };
        await files_api.hydrateFileSourceMetadata(unknown, true);
        assert.strictEqual(unknown.source_metadata_checked, true);
        assert.strictEqual(unknown.duplicate_key, undefined);
        assert.deepStrictEqual(writes[1], ['files', { uid: 'unknown' }, { source_metadata_checked: true }]);
        const fromInfo = files_api.extractSourceMetadataFromInfo({ webpage_url: audio.url }, 'audio');
        assert.strictEqual(fromInfo.duplicate_key, audio.duplicate_key);
        assert.strictEqual(files_api.extractSourceMetadataFromInfo({ id: 123 }).duplicate_key, 'unknown:123:video');
        for (const value of [null, '', 1, 'not a url', 'https://twitch.tv/channel']) {
            assert.strictEqual(files_api.extractSourceMetadataFromUrl(value), null);
        }
    });

    it('creates category playlists scoped to the owner and respects sharing restrictions', async function() {
        const filters = [];
        media.restore();
        media = useTemporaryMediaRoots({ ytdl_multi_user_mode: true });
        stub(db_api, 'getRecord', async table => table === 'categories' ? { uid: 'category', name: 'Science' } : null);
        stub(db_api, 'getRecords', async (table, filter) => { filters.push(filter); return [{ uid: 'owned' }]; });
        const playlist = await files_api.getPlaylist('category', 'alice');
        assert.strictEqual(playlist.auto, true);
        assert.deepStrictEqual(playlist.uids, ['owned']);
        assert.deepStrictEqual(filters[0], { 'category.uid': 'category', user_uid: 'alice' });
        assert.strictEqual(await files_api.getPlaylist('category', 'alice', true), null);
    });

    it('converts legacy playlist filenames and skips missing media', async function() {
        const legacy = { id: 'mix', name: 'Mix', fileNames: ['present', 'missing'], sharingEnabled: true };
        const writes = [];
        stub(db_api, 'getRecord', async () => legacy);
        stub(files_api, 'getVideoUIDByID', async (name, owner) => {
            assert.strictEqual(owner, 'alice');
            return name === 'present' ? 'uid-present' : null;
        });
        stub(files_api, 'updatePlaylist', async (...args) => { writes.push(args); return true; });
        const playlist = await files_api.getPlaylist('mix', 'alice', true);
        assert.deepStrictEqual(playlist.uids, ['uid-present']);
        assert.deepStrictEqual(writes, [[legacy, 'alice']]);
    });

    it('falls back to category properties and reports missing records or failed playlist work', async function() {
        const calls = [];
        stub(db_api, 'updateRecord', async (table, ...args) => { calls.push([table, ...args]); return table === 'categories'; });
        assert.strictEqual(await files_api.setPlaylistProperty('category', { name: 'Renamed' }), true);
        assert.deepStrictEqual(calls, [
            ['playlists', { id: 'category' }, { name: 'Renamed' }], ['categories', { uid: 'category' }, { name: 'Renamed' }]
        ]);
        db_api.updateRecord = async () => false;
        assert.strictEqual(await files_api.setPlaylistProperty('missing', {}), false);
        stub(db_api, 'getRecord', async () => { throw new Error('database unavailable'); });
        assert.strictEqual(await files_api.syncSubscriptionPlaylist('sub'), null);
        stub(db_api, 'getRecords', async () => { throw new Error('database unavailable'); });
        assert.strictEqual(await files_api.cleanupSubscriptionPlaylists('sub'), false);
        assert.strictEqual(await files_api.syncSubscriptionPlaylist(null), null);
        assert.strictEqual(await files_api.cleanupSubscriptionPlaylists(null), true);
    });
});

describe('Duplicate metadata in remote storage', function() {
    const fake = useFakeMongo();
    const source = { source_metadata_checked: true, source_id: 'clip', source_extractor: 'generic', duplicate_key: 'generic:clip:video' };
    const files = [
        { ...source, uid: 'old', registered: 1, user_uid: 'alice' },
        { ...source, uid: 'new', registered: 2, user_uid: 'alice' },
        { ...source, uid: 'other-owner', registered: 3, user_uid: 'bob' },
        { ...source, uid: 'other-source', source_id: 'other', duplicate_key: 'generic:other:video', user_uid: 'alice' }
    ];
    let media;
    before(async function() {
        media = useTemporaryMediaRoots({ ytdl_multi_user_mode: true });
        await fake.install({ connect: true, collections: { [MONGO_URL]: { files } } });
    });
    after(function() { media.restore(); });

    it('counts duplicate groups and fetches only the caller\'s matching records', async function() {
        assert.deepStrictEqual(await files_api.getDuplicateSummary('alice'), { has_duplicates: true, duplicate_group_count: 1 });
        const groups = await files_api.getDuplicateGroups('alice');
        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0].kept_file.uid, 'old');
        assert.deepStrictEqual(groups[0].duplicate_files.map(file => file.uid), ['old', 'new']);
        assert.strictEqual(groups[0].duplicate_count, 1);
        assert.deepStrictEqual(await files_api.getDuplicateSummary('bob'), { has_duplicates: false, duplicate_group_count: 0 });
        assert.deepStrictEqual(await files_api.getDuplicateGroups('bob'), []);
    });
});
