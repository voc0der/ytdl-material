const { assert, fs, path, utils, useTemporaryMediaRoots } = require('./test-shared');
const { Readable, Writable } = require('stream');
const transcoding = require('../transcoding');

describe('Media utilities', function() {
    let media;
    let originals;
    const stub = (object, name, fn) => {
        originals.push([object, name, object[name]]);
        object[name] = fn;
    };
    beforeEach(function() { media = useTemporaryMediaRoots(); originals = []; });
    afterEach(function() {
        for (const [object, name, fn] of originals.reverse()) object[name] = fn;
        media.restore();
    });

    for (const type of ['audio', 'video']) {
        it(`reads ${type} sidecars in both naming conventions and skips files without metadata`, async function() {
            const base = media[type];
            const ext = type === 'audio' ? 'mp3' : 'mp4';
            const info = { title: 'Clip', upload_date: '20240102', duration: 12, webpage_url: 'https://example.test/clip' };
            for (const name of ['standard', 'alternate', 'missing']) fs.writeFileSync(path.join(base, `${name}.${ext}`), 'media');
            fs.writeJSONSync(path.join(base, 'standard.info.json'), info);
            fs.writeJSONSync(path.join(base, `alternate.${ext}.info.json`), info);
            const files = await utils.getDownloadedFilesByType(base + path.sep, type);
            assert.deepStrictEqual(files.map(file => file.id).sort(), ['alternate', 'standard']);
            for (const file of files) {
                assert.strictEqual(file.isAudio, type === 'audio');
                assert.strictEqual(file.size, 5);
                assert.strictEqual(file.upload_date, '2024-01-02');
                assert.strictEqual(file.title, 'Clip');
            }
            const metadata = await utils.getDownloadedFilesByType(base + path.sep, type, true);
            assert.deepStrictEqual(metadata.map(file => file.id).sort(), ['alternate', 'standard']);
            assert(metadata.every(file => file.upload_date === '20240102'));
            assert.deepStrictEqual(await utils.getDownloadedFilesByType(path.join(base, 'absent'), type), []);
            const read = type === 'audio' ? utils.getJSONMp3 : utils.getJSONMp4;
            assert.deepStrictEqual(read('standard'), info);
            assert.deepStrictEqual(read('alternate'), info);
            assert.strictEqual(read('absent'), 0);
            utils.deleteJSONFile(path.join(base, `alternate.${ext}`), type);
            assert.strictEqual(read('alternate'), 0);
        });
    }

    it('scans a supplied file list, preserves the accumulator and tolerates disappearing entries', async function() {
        fs.outputFileSync(path.join(media.video, 'nested/clip.MP4'), 'media');
        fs.outputFileSync(path.join(media.video, 'first.mp4'), 'media');
        const result = ['already-found'];
        assert.strictEqual(await utils.recFindByExt(media.video, 'mp4', ['first.mp4', 'nested'], result, false), result);
        assert.deepStrictEqual(result, ['already-found', path.join(media.video, 'first.mp4')]);
        assert.deepStrictEqual(await utils.recFindByExt(media.video, 'mp4', ['disappeared']), []);
        assert.deepStrictEqual(await utils.recFindByExt(path.join(media.video, 'missing'), 'mp4'), []);
        assert.strictEqual((await utils.recFindByExt(media.video, 'mp4')).length, 2);
    });

    it('builds search prefixes, category membership and normalized filenames', function() {
        assert.strictEqual(utils.createEdgeNGrams('space cat'), 'spa spac space cat');
        assert.strictEqual(utils.createEdgeNGrams('hi'), 'hi');
        assert.strictEqual(utils.createEdgeNGrams(null), null);
        assert.strictEqual(utils.getTrueFileName('clip.webm', 'audio'), 'clip.mp3');
        assert.strictEqual(utils.getTrueFileName('clip.webm', 'video', 'mkv'), 'clip.mkv');
        assert.strictEqual(utils.getTrueFileName('clip.mp4', 'video'), 'clip.mp4');
        assert.strictEqual(utils.durationStringToNumber('1:02:03'), 3723);
        assert.strictEqual(utils.durationStringToNumber(15), 15);
        const category = { uid: 'science' };
        const files = [{ uid: 'one', category }, { uid: 'two' }, { uid: 'three', category: { uid: 'art' } }];
        assert.deepStrictEqual(utils.addUIDsToCategory(category, files), [files[0]]);
        assert.deepStrictEqual(category.uids, ['one']);
    });

    it('waits for an existing file or a matching rename and times out for an absent file', async function() {
        const target = path.join(media.video, 'ready');
        fs.writeFileSync(target, 'ready');
        assert.strictEqual(await utils.checkExistsWithTimeout(target, 200), true);
        fs.unlinkSync(target);
        const waiting = utils.checkExistsWithTimeout(target, 500);
        fs.writeFileSync(path.join(media.video, 'unrelated'), 'other');
        fs.writeFileSync(target, 'ready');
        assert.strictEqual(await waiting, true);
        await assert.rejects(utils.checkExistsWithTimeout(path.join(media.video, 'never'), 20), /was not created/);
    });

    it('recovers metadata from mixed stdout after an unavailable entry', function() {
        const error = { stderr: 'This video is unavailable', stdout: 'diagnostic\n[prefix] {"id":"one"}\r\n\n{"id":"two"}' };
        assert.deepStrictEqual(utils.parseOutputJSON(null, error), [{ id: 'one' }, { id: 'two' }]);
        assert.strictEqual(utils.parseOutputJSON(null, { stderr: 'Private video', stdout: {} }), null);
        assert.strictEqual(utils.parseOutputJSON(null, { stderr: 'connection failed' }), null);
        assert.deepStrictEqual(utils.parseOutputJSON(null, 'Private video'), []);
        assert.strictEqual(utils.parseOutputJSON(['prefix {"broken":'], null), null);
    });

    it('streams Node responses and propagates input and output errors', async function() {
        let bytes = '';
        const output = new Writable({ write(chunk, encoding, done) { bytes += chunk; done(); } });
        await utils.writeFetchResponseToFile({ body: Readable.from(['first', 'second']) }, output, 'fixture');
        assert.strictEqual(bytes, 'firstsecond');
        await assert.rejects(utils.writeFetchResponseToFile({}, output, 'empty'), /body is empty/);
        const error = new Error('write failed');
        await assert.rejects(utils.writeFetchResponseToFile({ body: Readable.from(['data']) },
            new Writable({ write(chunk, encoding, done) { done(error); } }), 'fixture'), failure => failure === error);
        const input = new Readable({ read() { this.destroy(error); } });
        const sink = new Writable({ write(chunk, encoding, done) { done(); } });
        await assert.rejects(utils.writeFetchResponseToFile({ body: input }, sink, 'fixture'), failure => failure === error);
        sink.destroy();
    });

    it('retries failed hardware cropping in software and clamps progress to the selected range', async function() {
        const hardware = { input_options: ['-hwaccel', 'vaapi'], video_filters: ['scale=128:96'], video_encoder: 'h264_vaapi' };
        stub(transcoding, 'getFfmpegAttempts', () => [hardware, null]);
        stub(transcoding, 'describeFfmpegSettings', setting => setting ? 'hardware' : 'software');
        const source = path.join(media.video, 'clip.mp4');
        const output = path.join(media.video, 'trim.mp4');
        fs.writeFileSync(source, 'original');
        const attempts = [];
        const progress = [];
        stub(transcoding, 'runFfmpeg', async (args, options) => {
            attempts.push(args);
            if (attempts.length === 1) { fs.writeFileSync(output, 'partial'); return { success: false, error: 'device failed' }; }
            assert.strictEqual(fs.existsSync(output), false, 'partial hardware output must be removed');
            for (const seconds of [-1, 1, 5]) options.on_progress_seconds(seconds);
            fs.writeFileSync(output, 'complete');
            return { success: true };
        });
        assert.strictEqual(await utils.snipFile(source, output, 3, 5, '.mp4', value => progress.push(value)), true);
        assert.deepStrictEqual(progress, [0, 50, 100]);
        assert.deepStrictEqual(attempts[0], ['-y', '-hwaccel', 'vaapi', '-i', source, '-ss', '3', '-t', '2', '-vf', 'scale=128:96', '-c:v', 'h264_vaapi', output]);
        assert.deepStrictEqual(attempts[1], ['-y', '-i', source, '-ss', '3', '-t', '2', output]);
        assert.strictEqual(fs.readFileSync(source, 'utf8'), 'original');
        assert.strictEqual(fs.readFileSync(output, 'utf8'), 'complete');
    });
});
