const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const unzipper = require('unzipper');

const zip_api = require('../zip');
const { hasPython, hasUnzip, readWithPython, zipStructure } = require('./helpers/zip-readers');

/*************************************************
 * backend/zip.js against readers that did not
 * write it: Python's zipfile, which checks every
 * CRC-32, unzipper, which the updater already uses
 * to read releases, and Info-ZIP's unzip where a
 * test needs files back on disk.
 ************************************************/
describe('Zip files', function() {
    this.timeout(30000);

    let dir;

    beforeEach(async function() {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytdl-zip-test-'));
    });

    afterEach(async function() {
        await fs.remove(dir);
    });

    async function contentsByUnzipper(zip_path) {
        const directory = await unzipper.Open.file(zip_path);
        const contents = {};
        for (const file of directory.files) {
            contents[file.path] = file.type === 'Directory' ? null : await file.buffer();
        }
        return contents;
    }

    function requirePython(test) {
        if (!hasPython()) test.skip();
    }

    it('stores files under their own names, which both readers give back as they were', async function() {
        requirePython(this);
        // Bigger than one read, so the checksum is carried across chunks.
        const video = path.join(dir, 'source', 'clip.mp4');
        const audio = path.join(dir, 'source', 'café — song.mp3');
        await fs.outputFile(video, crypto.randomBytes(2.5 * 1024 * 1024));
        await fs.outputFile(audio, 'not really audio');
        const mtime = new Date(2024, 4, 17, 13, 37, 42);
        await fs.utimes(video, mtime, mtime);

        const zip_path = path.join(dir, 'container.zip');
        await zip_api.zipFiles(zip_path, [{path: video, name: 'clip.mp4'}, {path: audio, name: 'café — song.mp3'}]);

        const read = readWithPython(zip_path);
        assert.strictEqual(read.bad, null, 'every CRC-32 must check out');
        assert.deepStrictEqual(read.entries.map(entry => [entry.name, entry.size, entry.method]), [
            ['clip.mp4', 2.5 * 1024 * 1024, zip_api.METHOD.STORE],
            ['café — song.mp3', 16, zip_api.METHOD.STORE]
        ]);
        assert.deepStrictEqual(read.entries[0].date_time, [2024, 5, 17, 13, 37, 42]);
        assert.strictEqual(read.entries[0].mode, 0o100000 | ((await fs.stat(video)).mode & 0o7777));

        const contents = await contentsByUnzipper(zip_path);
        assert(contents['clip.mp4'].equals(await fs.readFile(video)));
        assert.strictEqual(contents['café — song.mp3'].toString(), 'not really audio');

        // Nothing here needs ZIP64, and names are marked as UTF-8.
        const structure = zipStructure(zip_path);
        assert.strictEqual(structure.zip64_end, false);
        assert(structure.entries.every(entry => !entry.zip64 && entry.version_needed === 20 && (entry.flags & 0x0800)));
    });

    it('deflates when asked', async function() {
        requirePython(this);
        const text = path.join(dir, 'source', 'db.json');
        await fs.outputFile(text, JSON.stringify({files: Array.from({length: 2000}, (_, index) => ({uid: index, title: 'same title'}))}));

        const zip_path = path.join(dir, 'compressed.zip');
        await zip_api.zipFiles(zip_path, [{path: text, name: 'db.json'}], {compress: true});

        const [entry] = readWithPython(zip_path).entries;
        assert.strictEqual(entry.method, zip_api.METHOD.DEFLATE);
        assert(entry.compressed < entry.size / 4, `expected real compression, got ${entry.compressed} of ${entry.size}`);
        assert((await contentsByUnzipper(zip_path))['db.json'].equals(await fs.readFile(text)));
    });

    /*************************************************
     * The ZIP64 branches run only for sizes or
     * offsets of 4 GiB and up, so a test can only
     * reach them by forcing them. The real thing is
     * checked by the opt-in test at the end.
     ************************************************/
    it('writes ZIP64 records that readers accept', async function() {
        requirePython(this);
        const tree = path.join(dir, 'tree');
        await fs.outputFile(path.join(tree, 'folder', 'a.txt'), 'first');
        await fs.outputFile(path.join(tree, 'b.bin'), crypto.randomBytes(300000));

        const zip_path = path.join(dir, 'zip64.zip');
        await zip_api.zipFolder(zip_path, tree, {zip64: true, compress: true});

        const structure = zipStructure(zip_path);
        assert.strictEqual(structure.zip64_end, true, 'a ZIP64 end record and locator must come before the end record');
        assert(structure.entries.every(entry => entry.zip64 && entry.version_needed === 45));

        const read = readWithPython(zip_path);
        assert.strictEqual(read.bad, null);
        assert.deepStrictEqual(read.entries.map(entry => entry.name), ['b.bin', 'folder/', 'folder/a.txt']);
        const contents = await contentsByUnzipper(zip_path);
        assert.strictEqual(contents['folder/a.txt'].toString(), 'first');
        assert(contents['b.bin'].equals(await fs.readFile(path.join(tree, 'b.bin'))));
    });

    it('sees ahead which sizes need 64 bits, allowing for deflate growing what it cannot shrink', function() {
        const {STORE, DEFLATE} = zip_api.METHOD;
        assert.strictEqual(zip_api.needsZip64(0xFFFFFFFE, STORE), false);
        // 0xFFFFFFFF itself is the value that means "look in the ZIP64 field".
        assert.strictEqual(zip_api.needsZip64(0xFFFFFFFF, STORE), true);
        assert.strictEqual(zip_api.needsZip64(0xFFFFFFFF - 1000000, STORE), false);
        assert.strictEqual(zip_api.needsZip64(0xFFFFFFFF - 1000000, DEFLATE), true);
        assert.strictEqual(zip_api.needsZip64(1024, DEFLATE), false);
    });

    it('stores a folder\'s folders, files and links, and leaves out what it is told to', async function() {
        requirePython(this);
        const tree = path.join(dir, 'tree');
        await fs.outputFile(path.join(tree, 'appdata', 'db.json'), '{}');
        await fs.ensureDir(path.join(tree, 'appdata', 'empty'));
        await fs.outputFile(path.join(tree, 'media', 'video.mp4'), 'video');
        await fs.outputFile(path.join(tree, '.git', 'config'), 'git');
        await fs.symlink(path.join(tree, 'appdata', 'db.json'), path.join(tree, 'db-link'));
        // A link back up to the folder itself: following it would never end.
        await fs.symlink('..', path.join(tree, 'appdata', 'loop'));

        const zip_path = path.join(dir, 'tree.zip');
        await zip_api.zipFolder(zip_path, tree, {
            skip: (absolute, entry) => entry.name.startsWith('.') || absolute === path.join(tree, 'media')
        });

        const read = readWithPython(zip_path);
        assert.strictEqual(read.bad, null);
        assert.deepStrictEqual(read.entries.map(entry => entry.name),
            ['appdata/', 'appdata/db.json', 'appdata/empty/', 'appdata/loop', 'db-link']);
        const by_name = Object.fromEntries(read.entries.map(entry => [entry.name, entry]));
        assert.strictEqual(by_name['appdata/'].mode & 0o170000, 0o040000);
        assert.strictEqual(by_name['appdata/'].dos & 0x10, 0x10, 'folders carry the MS-DOS folder bit too');
        assert.strictEqual(by_name['db-link'].mode & 0o170000, 0o120000);

        // Links are stored relative to their folder, so they work wherever the archive is unpacked.
        const contents = await contentsByUnzipper(zip_path);
        assert.strictEqual(contents['db-link'].toString(), 'appdata/db.json');
        assert.strictEqual(contents['appdata/loop'].toString(), '..');

        if (hasUnzip()) {
            const out = path.join(dir, 'unpacked');
            execFileSync('unzip', ['-q', zip_path, '-d', out]);
            assert((await fs.lstat(path.join(out, 'db-link'))).isSymbolicLink());
            assert.strictEqual(await fs.readFile(path.join(out, 'db-link'), 'utf8'), '{}');
            assert((await fs.stat(path.join(out, 'appdata', 'empty'))).isDirectory());
        }
    });

    it('stops when its signal aborts, partway through a file', async function() {
        const big = path.join(dir, 'big.bin');
        await fs.outputFile(big, Buffer.alloc(32 * 1024 * 1024, 7));
        const controller = new AbortController();
        const zip_path = path.join(dir, 'aborted.zip');

        const writing = zip_api.zipFiles(zip_path, [{path: big, name: 'big.bin'}], {signal: controller.signal});
        setImmediate(() => controller.abort());
        await assert.rejects(writing, {name: 'AbortError'});
        // The archive is closed, for the caller to remove.
        await fs.remove(zip_path);
    });

    it('says which file could not be read', async function() {
        await assert.rejects(zip_api.zipFiles(path.join(dir, 'missing.zip'), [{path: path.join(dir, 'gone.mp4'), name: 'gone.mp4'}]),
            {code: 'ENOENT'});
    });

    /*************************************************
     * Sizes and offsets past 4 GiB, for real: a
     * 4.25 GiB file, then a small one whose header
     * starts past 4 GiB. Reads and writes over 4 GiB,
     * so it runs only when YTDL_TEST_ZIP64_DIR names
     * a folder on a disk with room for it:
     *
     *   YTDL_TEST_ZIP64_DIR=/path/with/5GB npx mocha test/zip.test.js
     ************************************************/
    it('zips a file over 4 GiB, and one after it', async function() {
        const scratch = process.env.YTDL_TEST_ZIP64_DIR;
        if (!scratch || !hasPython()) this.skip();
        this.timeout(10 * 60 * 1000);

        const work = await fs.mkdtemp(path.join(scratch, 'ytdl-zip64-'));
        try {
            const big = path.join(work, 'big.mp4');
            const size = 4.25 * 1024 * 1024 * 1024;
            // Sparse, so the source takes no space; the archive does.
            await fs.close(await fs.open(big, 'w'));
            await fs.truncate(big, size);
            const small = path.join(work, 'after.txt');
            await fs.outputFile(small, 'after the big one');

            const zip_path = path.join(work, 'big.zip');
            await zip_api.zipFiles(zip_path, [{path: big, name: 'big.mp4'}, {path: small, name: 'after.txt'}]);

            const structure = zipStructure(zip_path);
            assert.strictEqual(structure.zip64_end, true, 'the central directory starts past 4 GiB');
            assert.deepStrictEqual(structure.entries.map(entry => entry.zip64), [true, true]);

            const read = readWithPython(zip_path);
            assert.strictEqual(read.bad, null);
            assert.deepStrictEqual(read.entries.map(entry => [entry.name, entry.size]), [['big.mp4', size], ['after.txt', 17]]);
            const directory = await unzipper.Open.file(zip_path);
            assert.strictEqual((await directory.files.find(file => file.path === 'after.txt').buffer()).toString(), 'after the big one');
        } finally {
            await fs.remove(work);
        }
    });
});
