const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const filename = path.resolve(__dirname, '../transcoding.js');

describe('Transcoding process failures and hardware fallback', function() {
    let dir;
    let harnesses;

    beforeEach(function() {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-transcoding-failures-'));
        harnesses = [];
    });

    afterEach(function() {
        fs.rmSync(dir, {recursive: true, force: true});
        for (const h of harnesses) {
            assert.equal(h.unexpected_spawns, 0, 'every process must have an explicit outcome');
            assert.equal(h.outcomes.length, 0, 'all expected processes must run');
            assert.equal(h.timers.size, 0, 'finished processes must cancel their timeout');
        }
    });

    // Load the real module with controlled child processes and timers. Hardware states
    // are reached through the public flight test, without depending on a host GPU.
    function load(outcomes, mode = 'nvenc') {
        const h = {outcomes: [...outcomes], mode, calls: [], timers: new Set(), unlinked: [], unexpected_spawns: 0};
        harnesses.push(h);
        const spawn = (binary, args) => {
            if (!h.outcomes.length) {
                h.unexpected_spawns++;
                throw new Error('Unexpected media process');
            }
            const outcome = h.outcomes.shift();
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.signals = [];
            child.kill = signal => child.signals.push(signal);
            h.calls.push({binary, args: Array.from(args), child});
            if (outcome.throw) throw outcome.throw;
            if (!outcome.pending) queueMicrotask(() => {
                // A successful software sample encode creates the file the decode test
                // must remove, even when the subsequent GPU decode fails.
                if (args.includes('libx264') && args.at(-1).endsWith('.mp4') && !outcome.code && !outcome.error) {
                    fs.writeFileSync(args.at(-1), 'probe');
                }
                for (const chunk of outcome.stdout || []) child.stdout.emit('data', Buffer.from(chunk));
                if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr));
                if (outcome.error) child.emit('error', outcome.error);
                child.emit('close', outcome.code ?? 0);
            });
            return child;
        };
        h.api = {};
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
            exports: h.api,
            process: {pid: process.pid, env: {FFMPEG_PATH: '/fixture/ffmpeg', FFPROBE_PATH: '/fixture/ffprobe'}},
            setTimeout(callback, delay) {
                const timer = {callback, delay};
                h.timers.add(timer);
                return timer;
            },
            clearTimeout: timer => h.timers.delete(timer),
            require: name => ({
                child_process: {spawn},
                os: {tmpdir: () => dir},
                fs: {promises: {unlink: async file => {
                    h.unlinked.push(file);
                    await fs.promises.unlink(file);
                }}},
                './config': {getConfigItem: () => h.mode},
                './logger': {info() {}, warn() {}, debug() {}}
            }[name] || require(name))
        }, {filename});
        return h;
    }

    it('reassembles progress split across chunks and ignores invalid timestamps', async function() {
        const h = load([{stdout: [
            'frame=4\nout_time_u', 's=1500000\nout_time_ms=250',
            '0000\nout_time_us=N/A\nout_time_us=-1\nout_time_us=Infinity\n',
            'progress=continue\nout_time_us=0\n'
        ]}]);
        const progress = [];
        const result = await h.api.runFfmpeg(['-i', 'input.mp4', 'output.mp4'], {
            on_progress_seconds: seconds => progress.push(seconds)
        });

        assert.equal(result.success, true);
        assert.equal(result.error, null);
        assert.deepEqual(progress, [1.5, 2.5, 0]);
        assert.equal(h.calls[0].binary, '/fixture/ffmpeg');
        assert.deepEqual(h.calls[0].args, [
            '-hide_banner', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', 'input.mp4', 'output.mp4'
        ]);
    });

    for (const [name, outcome, error] of [
        ['a synchronous spawn failure', {throw: new Error('spawn denied')}, 'spawn denied'],
        ['an error followed by a successful close', {error: new Error('binary missing')}, 'binary missing'],
        ['a nonzero exit without stderr', {code: 9}, 'ffmpeg exited with code 9'],
        ['multiline stderr', {code: 1, stderr: '  device unavailable\nsecondary detail\n'}, 'device unavailable'],
        ['an oversized error line', {code: 1, stderr: 'x'.repeat(400)}, 'x'.repeat(300)]
    ]) {
        it(`reports ${name} as an encoding failure`, async function() {
            const h = load([outcome]);
            const result = await h.api.runFfmpeg(['-i', 'input.mp4', '-f', 'null', '-']);
            assert.equal(result.success, false);
            assert.equal(result.error, error);
            assert(!h.calls[0].args.includes('-progress'));
        });
    }

    for (const [name, outcome] of [
        ['spawn throws', {throw: new Error('spawn denied')}],
        ['the process emits an error before closing', {error: new Error('binary missing'), stdout: ['{"streams":[]}']}],
        ['the exit is nonzero despite valid JSON', {code: 1, stdout: ['{"streams":[]}']}],
        ['JSON is truncated', {stdout: ['{"streams":']}]
    ]) {
        it(`returns no probe metadata when ${name}`, async function() {
            const h = load([outcome, outcome]);
            assert.equal(await h.api.probeStreams('input.mp4'), null);
            assert.equal(await h.api.probeMedia('input.mp4'), null);
            assert(h.calls.every(call => call.binary === '/fixture/ffprobe'));
        });
    }

    it('combines probe chunks and normalizes container tag names', async function() {
        const h = load([{stdout: ['{"streams":[{"codec_name":"hevc"}],',
            '"format":{"duration":"12","tags":{"PURL":"https://example.test/media","Title":"Clip"}}}']}]);
        const result = await h.api.probeMedia('input.mkv');
        assert.equal(result.streams[0].codec_name, 'hevc');
        assert.equal(result.format.duration, '12');
        assert.equal(result.tags.purl, 'https://example.test/media');
        assert.equal(result.tags.title, 'Clip');
        assert.deepEqual(h.calls[0].args, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', 'input.mkv']);
    });

    it('treats absent or malformed stream and format fields as empty metadata', async function() {
        for (const metadata of [{}, {streams: {}, format: 'invalid'}, {streams: null, format: {tags: 42}}]) {
            const outcome = {stdout: [JSON.stringify(metadata)]};
            const h = load([outcome, outcome]);
            assert.equal(await h.api.probeStreams('input.mp4'), null);
            const media = await h.api.probeMedia('input.mp4');
            assert.equal(media.streams.length, 0);
            assert.deepEqual(Object.keys(media.tags), []);
            assert.equal(typeof media.format, 'object');
        }
    });

    for (const [name, outcome, expected] of [
        ['cannot spawn', {throw: new Error('spawn denied')}, 'spawn denied'],
        ['emits a process error', {error: new Error('binary missing')}, 'binary missing'],
        ['exits unsuccessfully', {code: 2}, 'ffmpeg exited with code 2']
    ]) {
        it(`keeps hardware disabled when the flight test ${name}`, async function() {
            const h = load([outcome]);
            assert.equal(await h.api.runFlightTest(), false);
            const status = h.api.getStatus();
            assert.equal(status.checked, true);
            assert.equal(status.in_progress, false);
            assert.equal(status.available, false);
            assert.equal(status.decode_available, false);
            assert.equal(status.error, expected);
            assert(h.api.describeHardwareSkipReason('.mp4').includes(expected));
            assert.equal(h.api.getHardwareFfmpegSettings('.mp4'), null);
            assert.equal((await h.api.testCodecEncoder('hevc')).available, false);
        });
    }

    it('kills a stalled flight test and ignores its later successful close', async function() {
        const h = load([{pending: true}]);
        const result = h.api.runFlightTest();
        assert.equal(h.api.getStatus().in_progress, true);
        assert.equal(h.api.getHardwareFfmpegSettings('.mp4'), null);
        const [timer] = h.timers;
        assert.equal(timer.delay, 30000);
        timer.callback();
        h.calls[0].child.emit('close', 0);

        assert.equal(await result, false);
        assert.deepEqual(h.calls[0].child.signals, ['SIGKILL']);
        assert.match(h.api.getStatus().error, /timed out after 30 seconds/);
        assert.equal(h.api.getStatus().in_progress, false);
    });

    for (const sample_fails of [false, true]) {
        it(`keeps hardware encoding when ${sample_fails ? 'building the decode sample' : 'GPU decoding'} fails`, async function() {
            const failed = {code: 1, stderr: 'decode unavailable'};
            const h = load(sample_fails ? [{}, failed] : [{}, {}, failed]);
            assert.equal(await h.api.runFlightTest(), true);
            const status = h.api.getStatus();
            assert.equal(status.available, true);
            assert.equal(status.error, null);
            assert.equal(status.decode_available, false);
            assert.equal(status.decode_error, sample_fails ? 'could not build a probe file (decode unavailable)' : 'decode unavailable');
            const attempts = h.api.getFfmpegAttempts('.MP4');
            assert.equal(attempts.length, 2);
            assert.equal(attempts[0].video_encoder, 'h264_nvenc');
            assert.equal(attempts[0].hardware_decode, false);
            assert(!attempts[0].input_options.includes('-hwaccel'));
            assert.equal(attempts[1], null);
            assert.equal(h.unlinked.length, 1);
            assert(!fs.existsSync(h.unlinked[0]), 'the sample is cleaned up after either failure');
        });
    }

    it('offers GPU decode, GPU encode only, then software after both flight tests pass', async function() {
        const h = load([{}, {}, {}]);
        assert.equal(await h.api.runFlightTest(), true);
        assert.equal(h.api.getStatus().decode_available, true);
        const attempts = h.api.getFfmpegAttempts('.mp4');
        assert.equal(attempts.length, 3);
        assert.equal(attempts[0].hardware_decode, true);
        assert.deepEqual(Array.from(attempts[0].input_options), ['-hwaccel', 'cuda']);
        assert.equal(attempts[1].hardware_decode, false);
        assert.equal(attempts[2], null);
        assert.equal(h.api.describeHardwareSkipReason('.mp4'), null);
        assert.deepEqual(fs.readdirSync(dir), []);

        h.mode = 'qsv';
        assert.match(h.api.describeHardwareSkipReason('.mp4'), /ran for 'nvenc'.*now 'qsv'/);
        assert.equal(h.api.getHardwareFfmpegSettings('.mp4'), null);
    });

    it('skips the decode probe for a mode that only supports hardware encoding', async function() {
        const h = load([{}], 'amf');
        assert.equal(await h.api.runFlightTest(), true);
        assert.equal(h.api.getStatus().decode_available, false);
        assert.equal(h.api.getStatus().decode_error, null);
        const attempts = h.api.getFfmpegAttempts('.mp4');
        assert.equal(attempts.length, 2);
        assert.equal(attempts[0].video_encoder, 'h264_amf');
        assert.equal(attempts[0].hardware_decode, false);
        assert.equal(attempts[1], null);
    });
});
