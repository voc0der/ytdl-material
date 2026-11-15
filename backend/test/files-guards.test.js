const { assert, fs, os, path, files_api, db_api, useTemporaryMediaRoots } = require('./test-shared');
const logger = require('../logger');

// The checks files.js makes before it deletes, links or looks anything up, reached through
// the exported functions the routes call.
describe('File guards', function() {
    let media;
    let originals;
    let logged;
    let outside;
    const stub = (object, name, value) => { originals.push([object, name, object[name]]); object[name] = value; };

    beforeEach(function() {
        media = useTemporaryMediaRoots();
        originals = [];
        logged = [];
        outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-outside-'));
        stub(logger, 'error', message => logged.push(`error: ${message}`));
        stub(logger, 'warn', message => logged.push(`warn: ${message}`));
    });

    afterEach(function() {
        for (const [object, name, value] of originals.reverse()) object[name] = value;
        media.restore();
        fs.removeSync(outside);
    });

    it('refuses to delete media outside the media folders, and keeps its record', async function() {
        const stray = path.join(outside, 'clip.mp4');
        fs.writeFileSync(stray, 'not ours');
        const removed = [];
        stub(db_api, 'removeRecord', async (...args) => { removed.push(args); return true; });

        assert.strictEqual(await files_api.deleteFileObject({ uid: 'clip', path: stray, isAudio: false }), false);

        assert(fs.existsSync(stray));
        assert.deepStrictEqual(removed, []);
        assert.deepStrictEqual(logged, [`error: Refusing to delete ${stray}: it is not a regular file inside the configured media folders.`]);
    });

    it('deletes the media but not a sidecar that links out of the media folders', async function() {
        const clip = path.join(media.video, 'clip.mp4');
        const target = path.join(outside, 'elsewhere.json');
        fs.writeFileSync(clip, 'media');
        fs.writeFileSync(target, '{}');
        fs.symlinkSync(target, path.join(media.video, 'clip.info.json'));
        stub(db_api, 'removeRecord', async () => true);

        assert.strictEqual(await files_api.deleteFileObject({ uid: 'clip', path: clip, isAudio: false }), true);

        assert(!fs.existsSync(clip));
        assert(fs.existsSync(target));
        assert(logged.some(message => message.startsWith('error: Refusing to delete sidecar ') && message.endsWith('clip.info.json: it is outside the media folders.')));
    });

    it('leaves a moved file alone when more than one file could be the one its record meant', async function() {
        const recorded = path.join(media.video, 'old', 'clip.webm');
        const by_name = path.join(media.video, 'clip.webm');
        const by_id = path.join(media.video, 'nested', 'clip.mp4');
        fs.outputFileSync(by_name, 'one');
        fs.outputFileSync(by_id, 'two');
        stub(db_api, 'removeRecord', async () => true);

        await files_api.deleteFileObject({ uid: 'clip', id: 'nested/clip', path: recorded, isAudio: false });

        assert(logged.includes(`warn: Could not safely resolve stale DB path '${recorded}' because multiple matching files exist.`));
        assert(fs.existsSync(by_name) && fs.existsSync(by_id));
    });

    it('refuses playlist members that are not a list', async function() {
        stub(db_api, 'getRecord', async () => ({ id: 'mix', name: 'Mix', uids: [] }));
        const updates = [];
        stub(db_api, 'updateRecord', async (...args) => { updates.push(args); return true; });

        assert.strictEqual(await files_api.updatePlaylist({ id: 'mix', uids: 'clip' }), false);

        assert.deepStrictEqual(updates, []);
        assert(logged.includes('error: Refusing to update playlist mix: uids must be a list.'));
    });

    it('deletes nothing in batches when there is nothing to delete', async function() {
        stub(files_api, 'getVideosByUIDs', async () => []);
        for (const uids of [[], null, [null, undefined], ['gone']]) {
            assert.deepStrictEqual(await files_api.deleteFilesInBatches(uids), { deleted_count: 0, failed_count: 0 });
        }
    });

    it('finds an earlier copy by its address when its source has no identity', async function() {
        const queries = [];
        stub(db_api, 'getRecords', async (table, filter) => {
            queries.push(filter);
            return filter.url === 'https://example.test/clip' ? [{ uid: 'first', url: filter.url, source_metadata_checked: true }] : [];
        });

        const found = await files_api.findExistingDuplicateByInfo({ webpage_url: ' https://example.test/clip ' }, 'audio');

        assert.strictEqual(found.uid, 'first');
        assert.deepStrictEqual(queries.at(-1), { url: 'https://example.test/clip', isAudio: true });
        assert.strictEqual(await files_api.findExistingDuplicateByInfo({ webpage_url: 'https://example.test/other' }), null);
        assert.strictEqual(await files_api.findExistingDuplicateByInfo({}), null);
    });

    it('turns a file id into its uid, within the owner\'s library when there are accounts', async function() {
        media.restore();
        media = useTemporaryMediaRoots({ ytdl_multi_user_mode: true });
        const filters = [];
        stub(db_api, 'getRecord', async (table, filter) => {
            filters.push(filter);
            return filter.id === 'clip' ? { uid: 'clip-uid' } : null;
        });

        assert.strictEqual(await files_api.getVideoUIDByID('clip', 'alice'), 'clip-uid');
        assert.strictEqual(await files_api.getVideoUIDByID('missing', 'alice'), null);
        assert.deepStrictEqual(filters[0], { id: 'clip', user_uid: 'alice' });
    });

    it('reports no chapters, and the duration it was given, for a record with no file', function() {
        assert.deepStrictEqual(files_api.attachFileChapters({ uid: 'clip', duration: 42 }), { uid: 'clip', duration: 42, chapters: [] });
    });
});
