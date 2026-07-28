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
const TRANSCODING_MODES = {
    amf: {
        label: 'AMD AMF',
        video_encoder: 'h264_amf',
        input_options: [],
        decode_input_options: [],
        video_filters: []
    },
    nvenc: {
        label: 'Nvidia NVENC',
        video_encoder: 'h264_nvenc',
        input_options: [],
        decode_input_options: ['-hwaccel', 'cuda'],
        video_filters: []
    },
    qsv: {
        label: 'Intel Quicksync (QSV)',
        video_encoder: 'h264_qsv',
        input_options: [],
        decode_input_options: ['-hwaccel', 'qsv'],
        video_filters: []
    },
    vaapi: {
        label: 'VAAPI',
        video_encoder: 'h264_vaapi',
        input_options: ['-vaapi_device', DEFAULT_VAAPI_DEVICE],
        decode_input_options: ['-hwaccel', 'vaapi'],
        video_filters: ['format=nv12', 'hwupload']
    }
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

let config_change_subscription_active = false;

exports.TRANSCODING_MODES = TRANSCODING_MODES;

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
        hardware_decode: use_hardware_decode
    };
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
        } catch (e) {
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
