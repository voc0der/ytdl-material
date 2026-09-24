/*************************************************
 * Codec names, as the library stores them.
 *
 * yt-dlp and ffprobe name the same codec in
 * different ways -- 'avc1.640028' and 'h264',
 * 'hvc1.1.6.L120.90' and 'hevc' -- so both are
 * folded into one short name here, and anything
 * that compares codecs compares these.
 ************************************************/

// The codecs a library can be converted to, which is what ytdl_preferred_codec accepts.
const PREFERRED_CODECS = ['h264', 'hevc', 'av1', 'vp9'];

// Keyed on the part of a codec string before the first dot, so profile and level
// suffixes ('avc1.640028', 'vp09.00.50.08') do not matter.
const VIDEO_CODEC_ALIASES = {
    avc1: 'h264', avc2: 'h264', avc3: 'h264', avc4: 'h264', avc: 'h264', h264: 'h264', x264: 'h264',
    // dvh1 and dvhe are Dolby Vision carried in HEVC
    hvc1: 'hevc', hev1: 'hevc', hevc: 'hevc', h265: 'hevc', x265: 'hevc', dvh1: 'hevc', dvhe: 'hevc',
    av01: 'av1', av1: 'av1', dav1: 'av1',
    vp09: 'vp9', vp9: 'vp9',
    vp08: 'vp8', vp8: 'vp8',
    mp4v: 'mpeg4', mpeg4: 'mpeg4'
};

const AUDIO_CODEC_ALIASES = {
    mp4a: 'aac', aac: 'aac',
    opus: 'opus',
    vorbis: 'vorbis',
    mp3: 'mp3',
    flac: 'flac',
    alac: 'alac',
    'ac-3': 'ac3', ac3: 'ac3',
    'ec-3': 'eac3', eac3: 'eac3',
    dtsc: 'dts', dts: 'dts'
};

// MP3 can travel in MP4 under an mp4a object type, which a prefix match would call AAC.
const MP4A_MP3_TYPES = ['mp4a.40.34', 'mp4a.69', 'mp4a.6b'];

function codecPrefix(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed || trimmed === 'none') return null;
    return trimmed.split('.')[0];
}

function normalizeVideoCodec(raw) {
    const prefix = codecPrefix(raw);
    if (!prefix) return null;
    return VIDEO_CODEC_ALIASES[prefix] || prefix;
}

function normalizeAudioCodec(raw) {
    const prefix = codecPrefix(raw);
    if (!prefix) return null;
    if (MP4A_MP3_TYPES.includes(raw.trim().toLowerCase())) return 'mp3';
    if (prefix.startsWith('pcm_')) return 'pcm';
    return AUDIO_CODEC_ALIASES[prefix] || prefix;
}

const CODEC_LABELS = {h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg4: 'MPEG-4'};

// For log lines, which name codecs the way people search for them.
function describeCodec(codec) {
    if (!codec) return 'no video';
    return CODEC_LABELS[codec] || codec.toUpperCase();
}

// Unset, 'false' and anything unrecognized all mean no preference.
function normalizePreferredCodec(raw) {
    if (typeof raw !== 'string') return null;
    const codec = normalizeVideoCodec(raw);
    return PREFERRED_CODECS.includes(codec) ? codec : null;
}

// Embedded cover art is a second video stream, flagged attached_pic, and is not the video.
function findVideoStream(streams = []) {
    return streams.find(stream => stream && stream.codec_type === 'video'
        && !(stream.disposition && stream.disposition.attached_pic)) || null;
}

function findAudioStreams(streams = []) {
    return streams.filter(stream => stream && stream.codec_type === 'audio');
}

/**
 * The codecs of a file as probeMedia describes it.
 * @returns {{vcodec: string|null, acodec: string|null}}
 */
function readCodecsFromProbe(probed) {
    const streams = probed && Array.isArray(probed.streams) ? probed.streams : [];
    const video_stream = findVideoStream(streams);
    const audio_stream = findAudioStreams(streams)[0];
    return {
        vcodec: video_stream ? normalizeVideoCodec(video_stream.codec_name) : null,
        acodec: audio_stream ? normalizeAudioCodec(audio_stream.codec_name) : null
    };
}

/**
 * The codecs yt-dlp says it downloaded, from a .info.json. Only trustworthy for a file
 * nothing re-encoded afterwards, so this is the fallback when the file cannot be probed.
 */
function readCodecsFromInfo(info) {
    if (!info || typeof info !== 'object') return null;
    if (info.vcodec === undefined && info.acodec === undefined) return null;
    return {
        vcodec: normalizeVideoCodec(info.vcodec),
        acodec: normalizeAudioCodec(info.acodec)
    };
}

// PQ and HLG. Converting these without tone mapping would flatten them to washed-out SDR.
function isHdrStream(stream) {
    return !!stream && ['smpte2084', 'arib-std-b67'].includes(stream.color_transfer);
}

// Which video codecs each container can carry, for deciding where a converted file goes.
const CONTAINERS = {
    '.mp4': {muxer: 'mp4', video: ['h264', 'hevc', 'av1', 'vp9'], audio: ['aac', 'mp3', 'opus', 'flac', 'alac', 'ac3', 'eac3']},
    '.m4v': {muxer: 'mp4', video: ['h264', 'hevc', 'av1', 'vp9'], audio: ['aac', 'mp3', 'opus', 'flac', 'alac', 'ac3', 'eac3']},
    '.mov': {muxer: 'mov', video: ['h264', 'hevc'], audio: ['aac', 'mp3', 'alac', 'ac3', 'eac3']},
    // null: Matroska takes any audio codec ffmpeg can decode
    '.mkv': {muxer: 'matroska', video: ['h264', 'hevc', 'av1', 'vp9'], audio: null},
    '.webm': {muxer: 'webm', video: ['av1', 'vp9'], audio: ['opus', 'vorbis']}
};

/**
 * Keep the file's own container where it can hold the codec, since that changes nothing
 * else about the file. MP4 otherwise: every codec here fits in it.
 */
function chooseOutputExtension(source_ext, codec) {
    const ext = (source_ext || '').toLowerCase();
    const container = CONTAINERS[ext];
    return container && container.video.includes(codec) ? ext : '.mp4';
}

function getMuxer(ext) {
    const container = CONTAINERS[(ext || '').toLowerCase()];
    return container ? container.muxer : null;
}

function containerAcceptsAudio(ext, audio_codec) {
    const container = CONTAINERS[(ext || '').toLowerCase()];
    if (!container) return false;
    return container.audio === null || container.audio.includes(audio_codec);
}

// What yt-dlp's --format-sort calls each codec.
const FORMAT_SORT_CODECS = {h264: 'h264', hevc: 'h265', av1: 'av01', vp9: 'vp9'};

function getFormatSortCodec(codec) {
    return FORMAT_SORT_CODECS[codec] || null;
}

/**
 * The format to download again when a source offers the preferred codec: the lowest
 * resolution that is still at least as tall as the file already on disk, so a download
 * made at 720p on purpose is not replaced by a 4K one. The fastest and then the highest
 * bitrate format at that height wins.
 *
 * @returns {object|null} a yt-dlp format entry
 */
function pickReacquireFormat(formats, codec, min_height = 0) {
    if (!Array.isArray(formats)) return null;
    const floor = Number(min_height) > 0 ? Number(min_height) : 0;
    const candidates = formats.filter(format => format
        && format.format_id
        && !format.has_drm
        && normalizeVideoCodec(format.vcodec) === codec
        && Number(format.height) > 0
        && Number(format.height) >= floor);
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => (Number(a.height) - Number(b.height))
        || ((Number(b.fps) || 0) - (Number(a.fps) || 0))
        || ((Number(b.tbr) || 0) - (Number(a.tbr) || 0)));
    return candidates[0];
}

/**
 * The audio format the file was originally downloaded with, so a new download keeps the
 * same language and quality rather than whatever the source now calls best.
 */
function getOriginalAudioFormatId(info) {
    if (!info || !Array.isArray(info.requested_formats)) return null;
    const audio_format = info.requested_formats.find(format => format
        && format.format_id
        && normalizeVideoCodec(format.vcodec) === null
        && normalizeAudioCodec(format.acodec) !== null);
    return audio_format ? String(audio_format.format_id) : null;
}

// Two runs of the same video can differ by a frame or two of container padding.
function durationsMatch(a, b) {
    const first = Number(a);
    const second = Number(b);
    if (!(first > 0) || !(second > 0)) return false;
    return Math.abs(first - second) <= Math.max(2, Math.max(first, second) * 0.01);
}

module.exports = {
    PREFERRED_CODECS,
    normalizeVideoCodec,
    normalizeAudioCodec,
    normalizePreferredCodec,
    describeCodec,
    findVideoStream,
    findAudioStreams,
    readCodecsFromProbe,
    readCodecsFromInfo,
    isHdrStream,
    chooseOutputExtension,
    getMuxer,
    containerAcceptsAudio,
    getFormatSortCodec,
    pickReacquireFormat,
    getOriginalAudioFormatId,
    durationsMatch
};
