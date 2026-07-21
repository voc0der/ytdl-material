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
