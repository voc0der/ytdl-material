const { assert, config_api } = require('./test-shared');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const transcoding_api = require('../transcoding');

const root = path.resolve(__dirname, '..');
const SAMPLE = path.join(__dirname, 'sample_mp4.mp4');
const HOUR = 60 * 60 * 1000;

describe('Playback transcodes', function() {
    this.timeout(60000);
    let dir;
    let original_mode;

    beforeEach(function() {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-transcode-'));
        original_mode = config_api.getConfigItem('ytdl_transcoding');
        config_api.setConfigItem('ytdl_transcoding', false);
    });
    afterEach(function() {
        config_api.setConfigItem('ytdl_transcoding', original_mode === undefined ? false : original_mode);
        fs.rmSync(dir, {recursive: true, force: true});
    });

    // Loaded with its own __dirname so copies land in a throwaway appdata/transcodes.
    function load(transcoding = transcoding_api) {
        const exports = {};
        vm.runInNewContext(fs.readFileSync(path.join(root, 'playback-transcode.js'), 'utf8'), {
            exports, __dirname: dir,
            require: name => name === './transcoding' ? transcoding
                : name.startsWith('./') ? require(path.join(root, name)) : require(name)
        });
        return exports;
    }

    function source(name, contents = fs.readFileSync(SAMPLE)) {
        const source_path = path.join(dir, name);
        fs.writeFileSync(source_path, contents);
        return source_path;
    }

    async function settle(api, uid) {
        for (let i = 0; i < 600; i++) {
            const copy = api.getCopy(uid);
            if (copy.status !== 'pending') return copy;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`transcode of ${uid} never finished`);
    }

    function age(file_path, ms) {
        const then = new Date(Date.now() - ms);
        fs.utimesSync(file_path, then, then);
    }

    function transcodeDir() {
        return path.join(dir, 'appdata', 'transcodes');
    }

    it('asks every encoder for 8-bit H.264 and AAC in a fast-start MP4', function() {
        const api = load();
        const software = Array.from(api.buildTranscodeArgs('in.webm', 'out.part', null));
        assert.deepStrictEqual(software.slice(0, 3), ['-y', '-i', 'in.webm']);
        assert.strictEqual(software[software.indexOf('-vf') + 1], 'format=nv12');
        assert.strictEqual(software[software.indexOf('-c:v') + 1], 'libx264');
        assert.strictEqual(software[software.indexOf('-c:a') + 1], 'aac');
        assert(software.includes('0:V:0'), 'cover art must not be picked as the video stream');
        assert.deepStrictEqual(software.slice(-5), ['-movflags', '+faststart', '-f', 'mp4', 'out.part']);

        for (const [mode, mode_info] of Object.entries(transcoding_api.TRANSCODING_MODES)) {
            const settings = {...mode_info, input_options: [...mode_info.input_options, ...mode_info.decode_input_options]};
            const args = Array.from(api.buildTranscodeArgs('in.mp4', 'out.part', settings));
            const input_index = args.indexOf('-i');
            assert.deepStrictEqual(args.slice(1, input_index), settings.input_options, `${mode} input options must precede -i`);

            const filters = args[args.indexOf('-vf') + 1].split(',');
            assert.strictEqual(filters.filter(filter => filter === 'format=nv12').length, 1, `${mode} converts to 8-bit once`);
            assert.strictEqual(filters[filters.length - 1], mode_info.video_filters[mode_info.video_filters.length - 1] || 'format=nv12');

            const encoder_index = args.indexOf('-c:v');
            assert.strictEqual(args[encoder_index + 1], mode_info.video_encoder);
            assert.deepStrictEqual(args.slice(encoder_index + 2, encoder_index + 2 + mode_info.quality_options.length), mode_info.quality_options);
        }
    });

    it('makes a playable copy, reuses it, and redoes it once the source changes', async function() {
        const api = load();
        const file = {uid: 'file-1', path: source('source.mp4')};

        assert.strictEqual(api.request(file), false);
        assert.strictEqual(api.getCopy('file-1').status, 'pending');
        // a second link while it is queued must not queue it again
        assert.strictEqual(api.request(file), false);

        const copy = await settle(api, 'file-1');
        assert.strictEqual(copy.status, 'ready');
        assert.strictEqual(path.dirname(copy.path), transcodeDir());
        const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', copy.path]));
        assert.deepStrictEqual(probe.streams.map(stream => [stream.codec_name, stream.pix_fmt]), [['h264', 'yuv420p']]);
        assert.deepStrictEqual(fs.readdirSync(transcodeDir()), [path.basename(copy.path)], 'no partial file is left behind');

        assert.strictEqual(api.request(file), true, 'a copy newer than its source is reused');

        const later = new Date(Date.now() + HOUR);
        fs.utimesSync(file.path, later, later);
        assert.strictEqual(api.request(file), false, 'a source changed since the copy is transcoded again');
        assert.strictEqual((await settle(api, 'file-1')).status, 'ready');
    });

    it('records a failed transcode, and a new request retries it', async function() {
        const api = load();
        const file = {uid: 'broken', path: source('broken.mp4', 'not a video')};

        assert.strictEqual(api.request(file), false);
        assert.strictEqual((await settle(api, 'broken')).status, 'failed');
        assert.deepStrictEqual(fs.readdirSync(transcodeDir()), [], 'a failed attempt leaves nothing behind');

        fs.copyFileSync(SAMPLE, file.path);
        assert.strictEqual(api.request(file), false);
        assert.strictEqual((await settle(api, 'broken')).status, 'ready');
    });

    it('reaps only copies that are old and that no link or job still needs', async function() {
        let gate = null;
        const fake = {
            getFfmpegAttempts: () => [null],
            describeFfmpegSettings: () => 'software encoding',
            runFfmpeg: async args => {
                if (gate) await gate.promise;
                fs.writeFileSync(args[args.length - 1], 'copy');
                return {success: true, error: null};
            }
        };
        const api = load(fake);
        const source_path = source('source.mp4');
        const paths = {};
        for (const uid of ['old-unused', 'old-linked', 'fresh', 'busy']) {
            api.request({uid, path: source_path});
            paths[uid] = (await settle(api, uid)).path;
        }
        for (const uid of ['old-unused', 'old-linked', 'busy']) age(paths[uid], 7 * HOUR);
        const leftover = path.join(transcodeDir(), 'leftover.mp4.part');
        fs.writeFileSync(leftover, 'crashed');
        age(leftover, 7 * HOUR);

        // hold busy's redo in flight: its old copy is still what the job will replace
        let release;
        gate = {promise: new Promise(resolve => release = resolve)};
        assert.strictEqual(api.request({uid: 'busy', path: source_path}), false);

        const result = await api.reap(6 * HOUR, () => ['old-linked']);
        assert.strictEqual(result.removed, 2);
        assert.strictEqual(result.kept, 3);
        assert.strictEqual(api.getCopy('old-unused').status, 'missing');
        assert.strictEqual(api.getCopy('old-linked').status, 'ready');
        assert.strictEqual(api.getCopy('fresh').status, 'ready');
        assert(fs.existsSync(paths['busy']), 'a queued job keeps its copy');
        assert(!fs.existsSync(leftover));

        release();
        assert.strictEqual((await settle(api, 'busy')).status, 'ready');
    });

    it('reaps nothing when no copy was ever made', async function() {
        const result = await load().reap(6 * HOUR, () => []);
        assert.strictEqual(result.removed, 0);
        assert.strictEqual(result.kept, 0);
    });
});
