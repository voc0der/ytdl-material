const assert = require('assert');
const codecs = require('../codecs');

describe('Codecs', function() {
    it('folds yt-dlp and ffprobe names for the same video codec together', function() {
        const cases = {
            'avc1.640028': 'h264', 'avc3.4d401f': 'h264', h264: 'h264',
            'hvc1.1.6.L120.90': 'hevc', 'hev1.2.4.L153.B0': 'hevc', hevc: 'hevc', h265: 'hevc', 'dvh1.05.06': 'hevc',
            'av01.0.08M.08': 'av1', av1: 'av1',
            'vp09.00.50.08': 'vp9', vp9: 'vp9', 'vp9.2': 'vp9',
            vp8: 'vp8', theora: 'theora'
        };
        for (const [raw, expected] of Object.entries(cases)) {
            assert.strictEqual(codecs.normalizeVideoCodec(raw), expected, raw);
        }
        for (const nothing of ['none', '', null, undefined, 42]) {
            assert.strictEqual(codecs.normalizeVideoCodec(nothing), null, String(nothing));
        }
    });

    it('folds audio codec names together, and does not mistake MP3 in MP4 for AAC', function() {
        const cases = {
            'mp4a.40.2': 'aac', aac: 'aac', opus: 'opus', vorbis: 'vorbis', mp3: 'mp3', 'mp4a.40.34': 'mp3',
            'ac-3': 'ac3', 'ec-3': 'eac3', eac3: 'eac3', flac: 'flac', pcm_s16le: 'pcm'
        };
        for (const [raw, expected] of Object.entries(cases)) {
            assert.strictEqual(codecs.normalizeAudioCodec(raw), expected, raw);
        }
        assert.strictEqual(codecs.normalizeAudioCodec('none'), null);
    });

    it('accepts only the codecs a library can be converted to as a preference', function() {
        assert.strictEqual(codecs.normalizePreferredCodec('hevc'), 'hevc');
        assert.strictEqual(codecs.normalizePreferredCodec('H265'), 'hevc');
        assert.strictEqual(codecs.normalizePreferredCodec(' av1 '), 'av1');
        assert.strictEqual(codecs.normalizePreferredCodec('h264'), 'h264');
        for (const unset of ['', 'none', 'false', false, null, undefined, 'mpeg4', 'vp8']) {
            assert.strictEqual(codecs.normalizePreferredCodec(unset), null, String(unset));
        }
    });

    it('reads codecs from a probe without mistaking cover art for the video', function() {
        const probed = {streams: [
            {codec_type: 'video', codec_name: 'mjpeg', disposition: {attached_pic: 1}},
            {codec_type: 'audio', codec_name: 'opus'},
            {codec_type: 'video', codec_name: 'av1', disposition: {attached_pic: 0}}
        ]};
        assert.deepStrictEqual(codecs.readCodecsFromProbe(probed), {vcodec: 'av1', acodec: 'opus'});
        assert.deepStrictEqual(codecs.readCodecsFromProbe({streams: [{codec_type: 'audio', codec_name: 'mp3'}]}), {vcodec: null, acodec: 'mp3'});
        assert.strictEqual(codecs.readCodecsFromInfo({}), null);
        assert.deepStrictEqual(codecs.readCodecsFromInfo({vcodec: 'avc1.640028', acodec: 'opus'}), {vcodec: 'h264', acodec: 'opus'});
    });

    it('keeps a container that can hold the codec, and moves to MP4 otherwise', function() {
        assert.strictEqual(codecs.chooseOutputExtension('.mp4', 'hevc'), '.mp4');
        assert.strictEqual(codecs.chooseOutputExtension('.MKV', 'av1'), '.mkv');
        assert.strictEqual(codecs.chooseOutputExtension('.webm', 'vp9'), '.webm');
        assert.strictEqual(codecs.chooseOutputExtension('.webm', 'hevc'), '.mp4');
        assert.strictEqual(codecs.chooseOutputExtension('.mov', 'av1'), '.mp4');
        assert.strictEqual(codecs.chooseOutputExtension('.avi', 'h264'), '.mp4');

        assert.strictEqual(codecs.containerAcceptsAudio('.mp4', 'opus'), true);
        assert.strictEqual(codecs.containerAcceptsAudio('.mp4', 'vorbis'), false);
        assert.strictEqual(codecs.containerAcceptsAudio('.mkv', 'vorbis'), true);
        assert.strictEqual(codecs.containerAcceptsAudio('.webm', 'aac'), false);
    });

    it('re-downloads at the closest resolution that is not smaller than the file', function() {
        const formats = [
            {format_id: '137', vcodec: 'avc1.640028', height: 1080, tbr: 4000},
            {format_id: 'hevc-480', vcodec: 'hvc1.1.6.L93.90', height: 480, tbr: 900},
            {format_id: 'hevc-720-low', vcodec: 'hvc1.1.6.L120.90', height: 720, fps: 30, tbr: 1500},
            {format_id: 'hevc-720-high', vcodec: 'hvc1.1.6.L120.90', height: 720, fps: 30, tbr: 2500},
            {format_id: 'hevc-2160', vcodec: 'hvc1.1.6.L153.90', height: 2160, tbr: 16000},
            {format_id: 'hevc-drm', vcodec: 'hvc1.1.6.L120.90', height: 720, tbr: 9000, has_drm: true}
        ];
        assert.strictEqual(codecs.pickReacquireFormat(formats, 'hevc', 720).format_id, 'hevc-720-high');
        assert.strictEqual(codecs.pickReacquireFormat(formats, 'hevc', 1080).format_id, 'hevc-2160');
        assert.strictEqual(codecs.pickReacquireFormat(formats, 'hevc', 0).format_id, 'hevc-480');
        assert.strictEqual(codecs.pickReacquireFormat(formats, 'av1', 480), null);
        assert.strictEqual(codecs.pickReacquireFormat(null, 'hevc', 480), null);
    });

    it('finds the audio format a file was originally downloaded with', function() {
        const info = {requested_formats: [
            {format_id: '137', vcodec: 'avc1.640028', acodec: 'none'},
            {format_id: '251-drc', vcodec: 'none', acodec: 'opus'}
        ]};
        assert.strictEqual(codecs.getOriginalAudioFormatId(info), '251-drc');
        assert.strictEqual(codecs.getOriginalAudioFormatId({format_id: '18'}), null);
        assert.strictEqual(codecs.getOriginalAudioFormatId(null), null);
    });

    it('treats lengths a frame or two apart as the same video', function() {
        assert(codecs.durationsMatch(212, 212.04));
        assert(codecs.durationsMatch(1, 2.5));
        assert(codecs.durationsMatch(3600, 3630));
        assert(!codecs.durationsMatch(212, 180));
        assert(!codecs.durationsMatch(0, 0));
    });

    it('names a codec the way yt-dlp sorts formats by it', function() {
        assert.strictEqual(codecs.getFormatSortCodec('hevc'), 'h265');
        assert.strictEqual(codecs.getFormatSortCodec('av1'), 'av01');
        assert.strictEqual(codecs.getFormatSortCodec(null), null);
    });
});
