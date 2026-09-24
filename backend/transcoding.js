const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config_api = require('./config');
const logger = require('./logger');

const FLIGHT_TEST_TIMEOUT_MS = 30000;
const DEFAULT_VAAPI_DEVICE = '/dev/dri/renderD128';

// Containers that can hold the h264 streams produced by the hardware encoders below
const HW_ELIGIBLE_EXTS = ['.mp4', '.m4v', '.mkv', '.mov', '.ts'];

// Each mode has two independent halves. `input_options` and `video_encoder` accelerate the
// encode and are what the base flight test proves. `decode_input_options` additionally moves
// decoding onto the GPU, which is the expensive half for high resolution or AV1 sources.
//
// Decode options deliberately omit -hwaccel_output_format: without it the decoded frames are
// returned to system memory, so the existing filters (VAAPI's hwupload in particular) and the
// encoder still receive frames in the layout they expect. Keeping frames on the GPU would be
// faster still, but it requires filter chains matched to each mode and breaks the moment a
// source needs a filter that has no hardware equivalent.
//
// AMF has no decode counterpart on the platforms this image targets, so it stays encode-only.
//
// `quality_options` give whole-file encodes a constant quality target. Without one NVENC
// encodes everything at its 2 Mbit/s default whatever the resolution, and QSV and AMF leave
// the rate to the driver. VAAPI already defaults to constant QP, so it needs nothing.
//
// `encoders` are what a codec conversion uses for each codec. `video_encoder` stays the h264
// one, which is what cropping and playback copies ask for and what the base flight test proves.
const TRANSCODING_MODES = {
    amf: {
        label: 'AMD AMF',
        video_encoder: 'h264_amf',
        encoders: {h264: 'h264_amf', hevc: 'hevc_amf', av1: 'av1_amf'},
        input_options: [],
        decode_input_options: [],
        video_filters: [],
        quality_options: ['-rc', 'cqp', '-qp_i', '23', '-qp_p', '23']
    },
    nvenc: {
        label: 'Nvidia NVENC',
        video_encoder: 'h264_nvenc',
        encoders: {h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: 'av1_nvenc'},
        input_options: [],
        decode_input_options: ['-hwaccel', 'cuda'],
        video_filters: [],
        quality_options: ['-rc', 'vbr', '-cq', '23', '-b:v', '0']
    },
    qsv: {
        label: 'Intel Quicksync (QSV)',
        video_encoder: 'h264_qsv',
        encoders: {h264: 'h264_qsv', hevc: 'hevc_qsv', av1: 'av1_qsv', vp9: 'vp9_qsv'},
        input_options: [],
        decode_input_options: ['-hwaccel', 'qsv'],
        video_filters: [],
        quality_options: ['-q:v', '23']
    },
    vaapi: {
        label: 'VAAPI',
        video_encoder: 'h264_vaapi',
        encoders: {h264: 'h264_vaapi', hevc: 'hevc_vaapi', av1: 'av1_vaapi', vp9: 'vp9_vaapi'},
        input_options: ['-vaapi_device', DEFAULT_VAAPI_DEVICE],
        decode_input_options: ['-hwaccel', 'vaapi'],
        video_filters: ['format=nv12', 'hwupload'],
        quality_options: []
    }
};

// What a codec conversion encodes with when no GPU encoder can. A conversion replaces the
// library's copy for good, unlike a playback copy, so these favour quality over speed.
// x265 otherwise prints its own banner to stderr, which would bury ffmpeg's error line.
const SOFTWARE_ENCODERS = {
    h264: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'],
    hevc: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '22', '-x265-params', 'log-level=error'],
    av1: ['-c:v', 'libsvtav1', '-preset', '8', '-crf', '30'],
    vp9: ['-c:v', 'libvpx-vp9', '-crf', '31', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4']
};

const MODE_ALIASES = {
    amd: 'amf',
    nvidia: 'nvenc',
    cuda: 'nvenc',
    intel: 'qsv',
    quicksync: 'qsv'
};

const DISABLED_VALUES = ['off', 'none', 'false', 'no', '0', 'disabled'];

const flight_test_status = {
    mode: null,
    label: null,
    in_progress: false,
    checked: false,
    available: null,
    // hardware decode is tested separately: a GPU that can encode cannot be assumed to
    // decode, so this stays false unless its own flight test passed
    decode_available: false,
    decode_error: null,
    error: null,
    last_checked: null
};

// `${mode}:${codec}` -> {available, error}. The base flight test only proves the h264
// encoder, and a GPU that encodes h264 may have no HEVC or AV1 encoder at all, so each codec
// is tested the first time a conversion asks for it. Cleared whenever the base test reruns.
const codec_flight_tests = new Map();

let config_change_subscription_active = false;

exports.TRANSCODING_MODES = TRANSCODING_MODES;
exports.SOFTWARE_ENCODERS = SOFTWARE_ENCODERS;

exports.normalizeTranscodingMode = (raw_value) => {
    if (!raw_value || typeof raw_value !== 'string') return null;
    const normalized_value = raw_value.trim().toLowerCase();
    if (normalized_value === '' || DISABLED_VALUES.includes(normalized_value)) return null;
    const mode = TRANSCODING_MODES[normalized_value] ? normalized_value : MODE_ALIASES[normalized_value];
    if (!mode) {
        logger.warn(`Unknown transcoding mode '${raw_value}'. Falling back to software processing. Valid modes: ${Object.keys(TRANSCODING_MODES).join(', ')}`);
        return null;
    }
    return mode;
}

exports.getTranscodingMode = () => {
    return exports.normalizeTranscodingMode(config_api.getConfigItem('ytdl_transcoding'));
}

// Explains why hardware encoding will not be used for the given extension, or null when it
// will be. Falling back to software is silent by nature, so callers use this to say why.
exports.describeHardwareSkipReason = (ext) => {
    const mode = exports.getTranscodingMode();
    if (!mode) return 'hardware transcoding is disabled';
    if (!HW_ELIGIBLE_EXTS.includes((ext || '').toLowerCase())) {
        return `'${ext}' is not a hardware-eligible container (${HW_ELIGIBLE_EXTS.join(', ')})`;
    }
    if (!flight_test_status.checked) return 'the hardware flight test has not finished yet';
    if (!flight_test_status.available) {
        return `the hardware flight test failed${flight_test_status.error ? ` (${flight_test_status.error})` : ''}`;
    }
    if (flight_test_status.mode !== mode) {
        return `the flight test ran for '${flight_test_status.mode}' but the configured mode is now '${mode}'`;
    }
    return null;
}

// Returns the ffmpeg settings needed to hardware process a file with the given extension, or
// null if the file should use software processing instead. Hardware decoding is included only
// when its own flight test passed; pass allow_hardware_decode: false to get the encode-only
// settings, which is what callers retry with when a decode-accelerated run fails.
exports.getHardwareFfmpegSettings = (ext, {allow_hardware_decode = true} = {}) => {
    const skip_reason = exports.describeHardwareSkipReason(ext);
    if (skip_reason) {
        logger.debug(`Using software encoding because ${skip_reason}.`);
        return null;
    }
    const mode = exports.getTranscodingMode();
    const mode_info = TRANSCODING_MODES[mode];
    const use_hardware_decode = allow_hardware_decode
        && flight_test_status.decode_available
        && mode_info.decode_input_options.length > 0;

    return {
        mode: mode,
        label: mode_info.label,
        input_options: [...mode_info.input_options, ...(use_hardware_decode ? mode_info.decode_input_options : [])],
        video_filters: [...mode_info.video_filters],
        video_encoder: mode_info.video_encoder,
        quality_options: [...mode_info.quality_options],
        hardware_decode: use_hardware_decode
    };
}

// Degrade one step at a time rather than straight to software. A GPU that cannot decode
// a particular source can usually still encode it, so a failed hardware decode should
// cost the hardware encode too only if that fails as well. The trailing null is software.
exports.getFfmpegAttempts = (ext) => {
    const attempts = [];
    const full_settings = exports.getHardwareFfmpegSettings(ext);
    if (full_settings) {
        attempts.push(full_settings);
        if (full_settings.hardware_decode) {
            attempts.push(exports.getHardwareFfmpegSettings(ext, {allow_hardware_decode: false}));
        }
    }
    attempts.push(null);
    return attempts;
}

/*************************************************
 * Whether the configured GPU can encode a codec,
 * tested once per mode and codec.
 *
 * h264 is what the base flight test already
 * proved, so it answers from that. Anything else
 * waits for the base test, since a GPU that cannot
 * encode h264 here is not going to encode HEVC.
 ************************************************/
exports.testCodecEncoder = async (codec) => {
    const mode = exports.getTranscodingMode();
    if (!mode) return {available: false, error: 'hardware transcoding is disabled'};
    const skip_reason = exports.describeHardwareSkipReason('.mp4');
    if (skip_reason) return {available: false, error: skip_reason};

    const encoder = TRANSCODING_MODES[mode].encoders[codec];
    if (!encoder) return {available: false, error: `${TRANSCODING_MODES[mode].label} has no ${codec} encoder`};
    if (encoder === TRANSCODING_MODES[mode].video_encoder) return {available: true, error: null};

    const cache_key = `${mode}:${codec}`;
    if (!codec_flight_tests.has(cache_key)) {
        codec_flight_tests.set(cache_key, runCodecFlightTest(TRANSCODING_MODES[mode], encoder));
    }
    return await codec_flight_tests.get(cache_key);
}

async function runCodecFlightTest(mode_info, encoder) {
    const args = [
        '-hide_banner', '-v', 'error',
        ...mode_info.input_options,
        '-f', 'lavfi', '-i', 'color=black:size=320x240:rate=30:duration=0.25'
    ];
    if (mode_info.video_filters.length > 0) args.push('-vf', mode_info.video_filters.join(','));
    args.push('-c:v', encoder, '-frames:v', '4', '-f', 'null', '-');

    const result = await runFfmpegFlightTest(args);
    if (result.success) {
        logger.info(`Hardware flight test succeeded for ${encoder}. Codec conversions to it will use ${mode_info.label}.`);
    } else {
        logger.warn(`Hardware flight test failed for ${encoder}, so codec conversions to it will use the CPU. Error: ${result.error}`);
    }
    return {available: result.success, error: result.success ? null : result.error};
}

/**
 * The hardware->software ladder for encoding to a codec, as getFfmpegAttempts gives it for
 * h264. Each hardware rung carries that codec's encoder in `video_encoder`; the trailing
 * null is software, which codec conversions take from SOFTWARE_ENCODERS.
 *
 * Eligibility is judged on MP4 because the caller has already picked a container that
 * holds the codec, the same way playback copies are judged on the MP4 they write.
 */
exports.getCodecEncodeAttempts = async (codec) => {
    const attempts = [];
    const full_settings = exports.getHardwareFfmpegSettings('.mp4');
    if (full_settings && (await exports.testCodecEncoder(codec)).available) {
        const encoder = TRANSCODING_MODES[full_settings.mode].encoders[codec];
        attempts.push({...full_settings, video_encoder: encoder});
        if (full_settings.hardware_decode) {
            attempts.push({...exports.getHardwareFfmpegSettings('.mp4', {allow_hardware_decode: false}), video_encoder: encoder});
        }
    }
    attempts.push(null);
    return attempts;
}

exports.describeFfmpegSettings = (hardware_settings) => {
    if (!hardware_settings) return 'software encoding';
    const decode_label = hardware_settings.hardware_decode ? 'hardware decoding' : 'software decoding';
    return `${hardware_settings.label} (${hardware_settings.video_encoder}) with ${decode_label}`;
}

exports.getStatus = () => {
    return {...flight_test_status};
}

// Encodes a tiny generated clip with the configured hardware encoder to check whether
// the GPU and its drivers are actually usable inside this environment
exports.runFlightTest = async () => {
    const mode = exports.getTranscodingMode();
    flight_test_status.mode = mode;
    flight_test_status.label = mode ? TRANSCODING_MODES[mode].label : null;
    flight_test_status.checked = false;
    flight_test_status.available = null;
    flight_test_status.error = null;
    flight_test_status.decode_available = false;
    flight_test_status.decode_error = null;
    codec_flight_tests.clear();
    if (!mode) {
        flight_test_status.in_progress = false;
        return null;
    }

    const mode_info = TRANSCODING_MODES[mode];
    const args = [
        '-hide_banner', '-v', 'error',
        ...mode_info.input_options,
        '-f', 'lavfi', '-i', 'color=black:size=320x240:rate=30:duration=0.25'
    ];
    if (mode_info.video_filters.length > 0) args.push('-vf', mode_info.video_filters.join(','));
    args.push('-c:v', mode_info.video_encoder, '-frames:v', '4', '-f', 'null', '-');

    flight_test_status.in_progress = true;
    logger.info(`Running hardware transcoding flight test for ${mode_info.label}...`);

    const result = await runFfmpegFlightTest(args);

    flight_test_status.in_progress = false;
    flight_test_status.checked = true;
    flight_test_status.available = result.success;
    flight_test_status.error = result.success ? null : result.error;
    flight_test_status.last_checked = Date.now();

    if (result.success) {
        logger.info(`Hardware transcoding flight test succeeded for ${mode_info.label}. Hardware acceleration enabled.`);
    } else {
        logger.warn(`Hardware transcoding flight test failed for ${mode_info.label}. Falling back to software processing. Error: ${result.error}`);
        return flight_test_status.available;
    }

    // Encoding works. Decoding is a separate capability, so test it separately rather than
    // assuming it: a GPU that encodes h264 may still not decode every source codec.
    if (mode_info.decode_input_options.length === 0) {
        logger.info(`${mode_info.label} has no hardware decoding support. Decoding will use the CPU.`);
        return flight_test_status.available;
    }

    const decode_result = await runDecodeFlightTest(mode_info);
    flight_test_status.decode_available = decode_result.success;
    flight_test_status.decode_error = decode_result.success ? null : decode_result.error;

    if (decode_result.success) {
        logger.info(`Hardware decoding flight test succeeded for ${mode_info.label}. Decoding will use the GPU.`);
    } else {
        logger.info(`Hardware decoding is unavailable for ${mode_info.label}, so decoding will use the CPU. Encoding is still hardware accelerated. Reason: ${decode_result.error}`);
    }

    return flight_test_status.available;
}

// The base flight test decodes a generated pattern, which exercises no real codec path. To
// know whether hardware decoding works we have to hand ffmpeg an actually encoded file, so
// encode one in software first and then decode it back through the hardware pipeline.
async function runDecodeFlightTest(mode_info) {
    const sample_path = path.join(os.tmpdir(), `ytdl-material-hwdecode-probe-${process.pid}.mp4`);

    try {
        const encode_sample = await runFfmpegFlightTest([
            '-hide_banner', '-v', 'error', '-y',
            '-f', 'lavfi', '-i', 'color=black:size=320x240:rate=30:duration=0.25',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-frames:v', '4',
            sample_path
        ]);
        if (!encode_sample.success) {
            return {success: false, error: `could not build a probe file (${encode_sample.error})`};
        }

        const args = [
            '-hide_banner', '-v', 'error',
            ...mode_info.input_options,
            ...mode_info.decode_input_options,
            '-i', sample_path
        ];
        if (mode_info.video_filters.length > 0) args.push('-vf', mode_info.video_filters.join(','));
        args.push('-c:v', mode_info.video_encoder, '-frames:v', '4', '-f', 'null', '-');

        return await runFfmpegFlightTest(args);
    } finally {
        try {
            await fs.promises.unlink(sample_path);
        } catch {
            // probe file may never have been created; nothing to clean up
        }
    }
}

// ffmpeg emits a wall of stderr on failure; the first line names the actual problem
// (e.g. 'Cannot load libcuda.so.1' or 'No VA display found for device /dev/dri/renderD128')
function getPrimaryErrorLine(stderr) {
    const first_line = (stderr || '').trim().split('\n')[0] || '';
    return first_line.substring(0, 300);
}
exports.getPrimaryErrorLine = getPrimaryErrorLine;

/**
 * Run ffmpeg to completion.
 *
 * Resolves {success, error} rather than rejecting, so callers walking a hardware->software
 * ladder can test each rung without wrapping every attempt in try/catch.
 *
 * Progress comes from `-progress pipe:1`, which emits machine-readable `key=value` lines on
 * stdout. That is deliberately not the human-readable stderr status line: the stderr format
 * is presentational and has changed between ffmpeg releases, while `-progress` is a stable
 * contract intended for exactly this.
 *
 * @param {string[]} args ffmpeg arguments, excluding the binary itself
 * @param {function} [on_progress_seconds] called with output position in seconds as it advances
 */
function runFfmpeg(args, {on_progress_seconds = null} = {}) {
    return new Promise(resolve => {
        const ffmpeg_binary = process.env.FFMPEG_PATH || 'ffmpeg';
        // -hide_banner -v error keeps stderr to just the failure, so getPrimaryErrorLine
        // reports the actual problem instead of the version banner ffmpeg leads with.
        const full_args = ['-hide_banner', '-v', 'error'];
        if (on_progress_seconds) full_args.push('-progress', 'pipe:1', '-nostats');
        full_args.push(...args);
        let stderr = '';
        let stdout_remainder = '';
        let finished = false;

        const finish = (success, error) => {
            if (finished) return;
            finished = true;
            resolve({success: success, error: error});
        };

        let ffmpeg_process;
        try {
            ffmpeg_process = spawn(ffmpeg_binary, full_args);
        } catch (err) {
            finish(false, err.message);
            return;
        }

        if (on_progress_seconds) {
            ffmpeg_process.stdout.on('data', data => {
                // A chunk can split mid-line, so carry the tail over to the next one.
                const text = stdout_remainder + data.toString();
                const lines = text.split('\n');
                stdout_remainder = lines.pop();
                for (const line of lines) {
                    const [key, value] = line.split('=');
                    if (key !== 'out_time_us' && key !== 'out_time_ms') continue;
                    const parsed = Number(value);
                    if (!Number.isFinite(parsed) || parsed < 0) continue;
                    // out_time_ms is a misnomer upstream: both fields are microseconds.
                    on_progress_seconds(parsed / 1000000);
                }
            });
        }

        ffmpeg_process.stderr.on('data', data => stderr += data.toString());
        ffmpeg_process.on('error', err => finish(false, err.message));
        ffmpeg_process.on('close', code => {
            if (code === 0) finish(true, null);
            else finish(false, getPrimaryErrorLine(stderr) || `ffmpeg exited with code ${code}`);
        });
    });
}
exports.runFfmpeg = runFfmpeg;

/**
 * Run ffprobe and resolve its parsed JSON, or null when it cannot be run, exits non-zero,
 * or prints something that is not JSON. Callers treat all three the same way.
 */
function runFfprobeJson(args) {
    return new Promise(resolve => {
        const ffprobe_binary = process.env.FFPROBE_PATH || 'ffprobe';
        let stdout = '';
        let finished = false;

        const finish = (parsed) => {
            if (finished) return;
            finished = true;
            resolve(parsed);
        };

        let ffprobe_process;
        try {
            ffprobe_process = spawn(ffprobe_binary, args);
        } catch {
            finish(null);
            return;
        }

        ffprobe_process.stdout.on('data', data => stdout += data.toString());
        ffprobe_process.on('error', () => finish(null));
        ffprobe_process.on('close', code => {
            if (code !== 0) return finish(null);
            try {
                finish(JSON.parse(stdout));
            } catch {
                finish(null);
            }
        });
    });
}

/**
 * Read stream metadata for a file with ffprobe. Resolves null when the file cannot be
 * probed, so callers can treat "no usable metadata" and "probe failed" the same way.
 * @returns {Promise<object[]|null>} the `streams` array, or null
 */
async function probeStreams(file_path) {
    const parsed = await runFfprobeJson(['-v', 'quiet', '-print_format', 'json', '-show_streams', file_path]);
    if (!parsed) return null;
    return Array.isArray(parsed.streams) ? parsed.streams : null;
}
exports.probeStreams = probeStreams;

/**
 * Streams and container tags in one probe, for callers that want both and should not pay
 * for two ffprobe spawns to get them.
 *
 * Tag names are not portable: a URL written by `--add-metadata` comes back as lowercase
 * `purl` from mp4 and uppercase `PURL` from mkv and webm, so the tags are returned
 * lower-cased to spare every caller the same normalization.
 *
 * @returns {Promise<{streams: object[], format: object, tags: object}|null>}
 */
async function probeMedia(file_path) {
    const parsed = await runFfprobeJson([
        '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file_path
    ]);
    if (!parsed) return null;

    const format = parsed.format && typeof parsed.format === 'object' ? parsed.format : {};
    const raw_tags = format.tags && typeof format.tags === 'object' ? format.tags : {};
    const tags = {};
    for (const [key, value] of Object.entries(raw_tags)) {
        tags[String(key).toLowerCase()] = value;
    }

    return {
        streams: Array.isArray(parsed.streams) ? parsed.streams : [],
        format,
        tags
    };
}
exports.probeMedia = probeMedia;

function runFfmpegFlightTest(args) {
    return new Promise(resolve => {
        const ffmpeg_binary = process.env.FFMPEG_PATH || 'ffmpeg';
        let stderr = '';
        let finished = false;

        const finish = (success, error) => {
            if (finished) return;
            finished = true;
            resolve({success: success, error: error});
        };

        let ffmpeg_process = null;
        try {
            ffmpeg_process = spawn(ffmpeg_binary, args);
        } catch (err) {
            finish(false, err.message);
            return;
        }

        const timeout = setTimeout(() => {
            ffmpeg_process.kill('SIGKILL');
            finish(false, `Flight test timed out after ${FLIGHT_TEST_TIMEOUT_MS / 1000} seconds`);
        }, FLIGHT_TEST_TIMEOUT_MS);

        ffmpeg_process.stderr.on('data', data => stderr += data.toString());
        ffmpeg_process.on('error', err => {
            clearTimeout(timeout);
            finish(false, err.message);
        });
        ffmpeg_process.on('close', code => {
            clearTimeout(timeout);
            if (code === 0) finish(true, null);
            else finish(false, getPrimaryErrorLine(stderr) || `ffmpeg exited with code ${code}`);
        });
    });
}

// Kicks off the boot flight test without blocking startup, and re-runs it whenever
// the transcoding setting changes
exports.initialize = () => {
    exports.runFlightTest();
    if (config_change_subscription_active) return;
    config_change_subscription_active = true;
    config_api.config_updated.subscribe(change => {
        if (change && change.key === 'ytdl_transcoding') exports.runFlightTest();
    });
}
