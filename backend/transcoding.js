const { spawn } = require('child_process');

const config_api = require('./config');
const logger = require('./logger');

const FLIGHT_TEST_TIMEOUT_MS = 30000;
const DEFAULT_VAAPI_DEVICE = '/dev/dri/renderD128';

// Containers that can hold the h264 streams produced by the hardware encoders below
const HW_ELIGIBLE_EXTS = ['.mp4', '.m4v', '.mkv', '.mov', '.ts'];

const TRANSCODING_MODES = {
    amf: {
        label: 'AMD AMF',
        video_encoder: 'h264_amf',
        input_options: [],
        video_filters: []
    },
    nvenc: {
        label: 'Nvidia NVENC',
        video_encoder: 'h264_nvenc',
        input_options: [],
        video_filters: []
    },
    qsv: {
        label: 'Intel Quicksync (QSV)',
        video_encoder: 'h264_qsv',
        input_options: [],
        video_filters: []
    },
    vaapi: {
        label: 'VAAPI',
        video_encoder: 'h264_vaapi',
        input_options: ['-vaapi_device', DEFAULT_VAAPI_DEVICE],
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

// Returns the ffmpeg settings needed to hardware encode a file with the given extension,
// or null if the file should use software processing instead
exports.getHardwareFfmpegSettings = (ext) => {
    const mode = exports.getTranscodingMode();
    if (!mode) return null;
    if (!HW_ELIGIBLE_EXTS.includes((ext || '').toLowerCase())) return null;
    // hardware encoding is only used once the flight test confirmed it works
    if (!flight_test_status.checked || !flight_test_status.available || flight_test_status.mode !== mode) return null;
    const mode_info = TRANSCODING_MODES[mode];
    return {
        mode: mode,
        input_options: [...mode_info.input_options],
        video_filters: [...mode_info.video_filters],
        video_encoder: mode_info.video_encoder
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
    }

    return flight_test_status.available;
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
