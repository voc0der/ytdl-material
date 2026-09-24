const { assert, config_api, fs, os, path } = require('./test-shared');
const transcoding_api = require('../transcoding');
const codecs = require('../codecs');

describe('Transcoding', function() {
    it('normalizeTranscodingMode', function() {
        assert(transcoding_api.normalizeTranscodingMode('nvenc') === 'nvenc');
        assert(transcoding_api.normalizeTranscodingMode('NVENC') === 'nvenc');
        assert(transcoding_api.normalizeTranscodingMode(' vaapi ') === 'vaapi');
        assert(transcoding_api.normalizeTranscodingMode('QSV') === 'qsv');
        assert(transcoding_api.normalizeTranscodingMode('amf') === 'amf');

        // aliases
        assert(transcoding_api.normalizeTranscodingMode('nvidia') === 'nvenc');
        assert(transcoding_api.normalizeTranscodingMode('cuda') === 'nvenc');
        assert(transcoding_api.normalizeTranscodingMode('amd') === 'amf');
        assert(transcoding_api.normalizeTranscodingMode('intel') === 'qsv');
        assert(transcoding_api.normalizeTranscodingMode('quicksync') === 'qsv');

        // disabled values
        assert(transcoding_api.normalizeTranscodingMode(false) === null);
        assert(transcoding_api.normalizeTranscodingMode(undefined) === null);
        assert(transcoding_api.normalizeTranscodingMode(null) === null);
        assert(transcoding_api.normalizeTranscodingMode('') === null);
        assert(transcoding_api.normalizeTranscodingMode('off') === null);
        assert(transcoding_api.normalizeTranscodingMode('none') === null);
        assert(transcoding_api.normalizeTranscodingMode('false') === null);

        // unknown values fall back to software
        assert(transcoding_api.normalizeTranscodingMode('garbage') === null);
    });

    it('getHardwareFfmpegSettings requires a passed flight test', async function() {
        const original_value = config_api.getConfigItem('ytdl_transcoding');
        try {
            config_api.setConfigItem('ytdl_transcoding', 'nvenc');
            // no flight test has succeeded, so hardware settings must not be handed out
            assert(transcoding_api.getHardwareFfmpegSettings('.mp4') === null);
        } finally {
            config_api.setConfigItem('ytdl_transcoding', original_value === undefined ? false : original_value);
        }
    });

    it('describeHardwareSkipReason explains why software encoding was chosen', async function() {
        const original_value = config_api.getConfigItem('ytdl_transcoding');
        try {
            config_api.setConfigItem('ytdl_transcoding', false);
            assert(transcoding_api.describeHardwareSkipReason('.mp4').includes('disabled'));

            config_api.setConfigItem('ytdl_transcoding', 'nvenc');
            // ineligible container is reported ahead of any flight test state
            const ext_reason = transcoding_api.describeHardwareSkipReason('.webm');
            assert(ext_reason.includes('.webm'));
            assert(ext_reason.includes('hardware-eligible'));

            // eligible container, but no flight test has passed in this process
            const flight_reason = transcoding_api.describeHardwareSkipReason('.mp4');
            assert(flight_reason !== null);
            assert(flight_reason.includes('flight test'));
        } finally {
            config_api.setConfigItem('ytdl_transcoding', original_value === undefined ? false : original_value);
        }
    });

    it('getHardwareFfmpegSettings and describeHardwareSkipReason always agree', async function() {
        const original_value = config_api.getConfigItem('ytdl_transcoding');
        try {
            for (const mode of [false, 'nvenc', 'vaapi', 'garbage']) {
                config_api.setConfigItem('ytdl_transcoding', mode);
                for (const ext of ['.mp4', '.webm', '.mkv', '']) {
                    const settings = transcoding_api.getHardwareFfmpegSettings(ext);
                    const skip_reason = transcoding_api.describeHardwareSkipReason(ext);
                    // exactly one of the two must be non-null, or the log would lie
                    assert((settings === null) === (skip_reason !== null));
                }
            }
        } finally {
            config_api.setConfigItem('ytdl_transcoding', original_value === undefined ? false : original_value);
        }
    });

    it('every mode declares both encode and decode option sets', function() {
        for (const [mode, mode_info] of Object.entries(transcoding_api.TRANSCODING_MODES)) {
            assert(Array.isArray(mode_info.input_options), `${mode} is missing input_options`);
            assert(Array.isArray(mode_info.decode_input_options), `${mode} is missing decode_input_options`);
            assert(Array.isArray(mode_info.video_filters), `${mode} is missing video_filters`);
            assert(Array.isArray(mode_info.quality_options), `${mode} is missing quality_options`);
            assert(typeof mode_info.video_encoder === 'string' && mode_info.video_encoder);

            // decode acceleration must be requested through -hwaccel, and must not pin frames
            // to GPU memory since the filter chains and encoders here expect system memory
            if (mode_info.decode_input_options.length > 0) {
                assert(mode_info.decode_input_options.includes('-hwaccel'), `${mode} decode options must use -hwaccel`);
                assert(!mode_info.decode_input_options.includes('-hwaccel_output_format'),
                    `${mode} must not pin decoded frames to GPU memory`);
            }
        }
    });

    it('getFfmpegAttempts always ends in software', async function() {
        const original_value = config_api.getConfigItem('ytdl_transcoding');
        try {
            config_api.setConfigItem('ytdl_transcoding', false);
            assert.deepStrictEqual(transcoding_api.getFfmpegAttempts('.mp4'), [null]);

            config_api.setConfigItem('ytdl_transcoding', 'nvenc');
            const attempts = transcoding_api.getFfmpegAttempts('.mp4');
            assert.strictEqual(attempts[attempts.length - 1], null);
            assert.strictEqual(transcoding_api.describeFfmpegSettings(null), 'software encoding');
        } finally {
            config_api.setConfigItem('ytdl_transcoding', original_value === undefined ? false : original_value);
        }
    });

    it('hardware decode stays off until its own flight test passes', async function() {
        const original_value = config_api.getConfigItem('ytdl_transcoding');
        try {
            config_api.setConfigItem('ytdl_transcoding', 'nvenc');
            const status = transcoding_api.getStatus();
            // encode may or may not be available in CI, but decode must never be assumed
            assert(status.decode_available === false);

            const settings = transcoding_api.getHardwareFfmpegSettings('.mp4');
            if (settings) {
                assert(settings.hardware_decode === false);
                assert(!settings.input_options.includes('-hwaccel'));
            }
        } finally {
            config_api.setConfigItem('ytdl_transcoding', original_value === undefined ? false : original_value);
        }
    });

    it('runFlightTest reports decode availability without claiming encode failed', async function() {
        const original_value = config_api.getConfigItem('ytdl_transcoding');
        try {
            config_api.setConfigItem('ytdl_transcoding', 'nvenc');
            await transcoding_api.runFlightTest();
            const status = transcoding_api.getStatus();

            assert(status.checked === true);
            assert(status.in_progress === false);
            // decode can only be available if encode was, never the other way around
            if (status.decode_available) assert(status.available === true);
            // a decode failure must not be recorded as an encode failure
            if (status.available === false) assert(status.decode_available === false);
        } finally {
            config_api.setConfigItem('ytdl_transcoding', original_value === undefined ? false : original_value);
        }
    });

    it('every mode encodes h264 with the encoder the base flight test proves', function() {
        for (const [mode, mode_info] of Object.entries(transcoding_api.TRANSCODING_MODES)) {
            assert.strictEqual(mode_info.encoders.h264, mode_info.video_encoder, mode);
            for (const [codec, encoder] of Object.entries(mode_info.encoders)) {
                assert(codecs.PREFERRED_CODECS.includes(codec), `${mode} names an unknown codec '${codec}'`);
                assert(encoder.startsWith(`${codec}_`), `${mode} encodes ${codec} with ${encoder}`);
            }
        }
        for (const codec of codecs.PREFERRED_CODECS) {
            assert(transcoding_api.SOFTWARE_ENCODERS[codec], `no software encoder for ${codec}`);
        }
    });

    it('getCodecEncodeAttempts is software only while hardware transcoding is off', async function() {
        const original_value = config_api.getConfigItem('ytdl_transcoding');
        try {
            config_api.setConfigItem('ytdl_transcoding', false);
            assert.deepStrictEqual(await transcoding_api.getCodecEncodeAttempts('hevc'), [null]);
            assert.strictEqual((await transcoding_api.testCodecEncoder('hevc')).available, false);
        } finally {
            config_api.setConfigItem('ytdl_transcoding', original_value === undefined ? false : original_value);
        }
    });

    describe('with a GPU that has no HEVC encoder', function() {
        let dir;
        let original_ffmpeg_path;
        let original_value;

        // Stands in for ffmpeg: every flight test passes except one asking for hevc_nvenc,
        // and each call is logged so the test can see what was run.
        beforeEach(async function() {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-fake-ffmpeg-'));
            const fake = path.join(dir, 'ffmpeg');
            fs.writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${path.join(dir, 'calls')}"\ncase "$*" in *hevc_nvenc*) echo "No capable devices found" >&2; exit 1;; esac\nexit 0\n`);
            fs.chmodSync(fake, 0o755);
            original_ffmpeg_path = process.env.FFMPEG_PATH;
            process.env.FFMPEG_PATH = fake;
            original_value = config_api.getConfigItem('ytdl_transcoding');
            config_api.setConfigItem('ytdl_transcoding', 'nvenc');
            await transcoding_api.runFlightTest();
        });

        afterEach(async function() {
            if (original_ffmpeg_path === undefined) delete process.env.FFMPEG_PATH;
            else process.env.FFMPEG_PATH = original_ffmpeg_path;
            config_api.setConfigItem('ytdl_transcoding', original_value === undefined ? false : original_value);
            await transcoding_api.runFlightTest();
            fs.removeSync(dir);
        });

        function calls() {
            return fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');
        }

        it('encodes to AV1 on the GPU, decoding there first', async function() {
            const attempts = await transcoding_api.getCodecEncodeAttempts('av1');
            assert.deepStrictEqual(attempts.map(attempt => attempt && attempt.video_encoder), ['av1_nvenc', 'av1_nvenc', null]);
            assert.strictEqual(attempts[0].hardware_decode, true);
            assert.strictEqual(attempts[1].hardware_decode, false);
        });

        it('falls back to the CPU for HEVC, and tests the encoder only once', async function() {
            assert.deepStrictEqual(await transcoding_api.getCodecEncodeAttempts('hevc'), [null]);
            assert.deepStrictEqual(await transcoding_api.getCodecEncodeAttempts('hevc'), [null]);
            assert.strictEqual(calls().filter(call => call.includes('hevc_nvenc')).length, 1);
        });

        it('takes h264 from the base flight test and VP9 from no encoder at all', async function() {
            const before = calls().length;
            assert.strictEqual((await transcoding_api.getCodecEncodeAttempts('h264'))[0].video_encoder, 'h264_nvenc');
            assert.deepStrictEqual(await transcoding_api.getCodecEncodeAttempts('vp9'), [null]);
            assert.strictEqual(calls().length, before, 'neither needs a flight test of its own');
        });
    });

    it('runFlightTest with transcoding disabled', async function() {
        const original_value = config_api.getConfigItem('ytdl_transcoding');
        try {
            config_api.setConfigItem('ytdl_transcoding', false);
            const result = await transcoding_api.runFlightTest();
            assert(result === null);
            const status = transcoding_api.getStatus();
            assert(status.mode === null);
            assert(status.checked === false);
            assert(status.in_progress === false);
        } finally {
            config_api.setConfigItem('ytdl_transcoding', original_value === undefined ? false : original_value);
        }
    });
});
