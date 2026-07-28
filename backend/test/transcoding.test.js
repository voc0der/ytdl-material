/* eslint-disable no-undef */
const { assert, config_api } = require('./test-shared');
const transcoding_api = require('../transcoding');

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
