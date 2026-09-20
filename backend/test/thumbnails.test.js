const { assert } = require('./test-shared');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const transcoding_api = require('../transcoding');
const files_api = require('../files');
const thumbnails_api = require('../thumbnails');

const ffmpeg_binary = process.env.FFMPEG_PATH || 'ffmpeg';
const has_ffmpeg = spawnSync(ffmpeg_binary, ['-version'], {stdio: 'ignore'}).status === 0;

/**
 * A real file, because the point of these cases is what ffprobe reports back. Tags written
 * to mp4 need use_metadata_tags or the muxer silently drops the ones it does not know,
 * which is exactly the behavior the recovery chain has to survive.
 */
function writeSampleVideo(output_path, {duration = 2, tags = {}, use_metadata_tags = false} = {}) {
    const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${duration}:size=320x240:rate=10`];
    if (use_metadata_tags) args.push('-movflags', 'use_metadata_tags');
    for (const [key, value] of Object.entries(tags)) args.push('-metadata', `${key}=${value}`);
    args.push(output_path);
    return spawnSync(ffmpeg_binary, args, {stdio: 'ignore'}).status === 0;
}

describe('Container metadata recovery', function() {
    describe('extractUrlFromContainerTags', function() {
        it('reads the URL yt-dlp writes, whatever the container spelled it', function() {
            // probeMedia lower-cases the keys, so mkv's PURL arrives as purl.
            assert.strictEqual(
                files_api.extractUrlFromContainerTags({purl: 'https://example.com/watch?v=abc'}),
                'https://example.com/watch?v=abc'
            );
        });

        it('falls back to comment, which survives an mp4 muxed without use_metadata_tags', function() {
            assert.strictEqual(
                files_api.extractUrlFromContainerTags({comment: 'https://example.com/v/1'}),
                'https://example.com/v/1'
            );
        });

        it('prefers purl over comment when both are present', function() {
            assert.strictEqual(
                files_api.extractUrlFromContainerTags({comment: 'https://example.com/b', purl: 'https://example.com/a'}),
                'https://example.com/a'
            );
        });

        it('ignores a comment that is prose rather than a bare URL', function() {
            // A comment is free text on files that did not come from yt-dlp.
            assert.strictEqual(files_api.extractUrlFromContainerTags({comment: 'see https://example.com later'}), '');
            assert.strictEqual(files_api.extractUrlFromContainerTags({comment: 'Recorded on holiday'}), '');
        });

        it('returns empty for missing or non-string tags', function() {
            assert.strictEqual(files_api.extractUrlFromContainerTags({}), '');
            assert.strictEqual(files_api.extractUrlFromContainerTags({purl: 12345}), '');
            assert.strictEqual(files_api.extractUrlFromContainerTags(), '');
        });
    });

    describe('normalizeContainerDate', function() {
        it('reads the YYYYMMDD that yt-dlp writes', function() {
            assert.strictEqual(files_api.normalizeContainerDate('20260920'), '2026-09-20');
        });

        it('reads an ISO timestamp, which other tools write', function() {
            assert.strictEqual(files_api.normalizeContainerDate('2026-09-20T12:00:00Z'), '2026-09-20');
        });

        it('returns null for anything it cannot make sense of', function() {
            assert.strictEqual(files_api.normalizeContainerDate('last tuesday'), null);
            assert.strictEqual(files_api.normalizeContainerDate(''), null);
            assert.strictEqual(files_api.normalizeContainerDate(), null);
        });
    });

    describe('resolveSeekSeconds', function() {
        it('uses the requested timestamp when the video is long enough', function() {
            assert.strictEqual(thumbnails_api.resolveSeekSeconds(30, 120), 30);
        });

        it('backs off to the midpoint for a video shorter than the timestamp', function() {
            // The scripts in #497/#498 seeked to 30s unconditionally and counted every short
            // video as a failure, because ffmpeg returns no frame past the end.
            assert.strictEqual(thumbnails_api.resolveSeekSeconds(30, 10), 5);
        });

        it('keeps the requested timestamp when the duration is unknown', function() {
            assert.strictEqual(thumbnails_api.resolveSeekSeconds(30, null), 30);
            assert.strictEqual(thumbnails_api.resolveSeekSeconds(30, 0), 30);
        });

        it('falls back to the default for a missing or nonsensical timestamp', function() {
            assert.strictEqual(thumbnails_api.resolveSeekSeconds(null, 120), 30);
            assert.strictEqual(thumbnails_api.resolveSeekSeconds(-5, 120), 30);
        });
    });

    // These read what ffprobe actually reports rather than a fixture of what we think it
    // reports, which is the only way the tag-name handling is worth anything.
    (has_ffmpeg ? describe : describe.skip)('probeMedia against real files', function() {
        let temp_dir;

        before(function() {
            this.timeout(30000);
            temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-thumbnails-'));
        });

        after(function() {
            if (temp_dir) fs.removeSync(temp_dir);
        });

        it('lower-cases mp4 tags so purl is found', async function() {
            this.timeout(30000);
            const sample_path = path.join(temp_dir, 'tagged.mp4');
            assert(writeSampleVideo(sample_path, {
                use_metadata_tags: true,
                tags: {purl: 'https://example.com/watch?v=mp4', title: 'MP4 Sample'}
            }), 'ffmpeg could not write the sample');

            const probed = await transcoding_api.probeMedia(sample_path);
            assert(probed, 'probeMedia returned nothing');
            assert.strictEqual(files_api.extractUrlFromContainerTags(probed.tags), 'https://example.com/watch?v=mp4');
            assert.strictEqual(probed.tags.title, 'MP4 Sample');
        });

        it('lower-cases mkv tags, where the same field is written as PURL', async function() {
            this.timeout(30000);
            const sample_path = path.join(temp_dir, 'tagged.mkv');
            assert(writeSampleVideo(sample_path, {
                tags: {PURL: 'https://example.com/watch?v=mkv'}
            }), 'ffmpeg could not write the sample');

            const probed = await transcoding_api.probeMedia(sample_path);
            assert(probed, 'probeMedia returned nothing');
            assert.strictEqual(files_api.extractUrlFromContainerTags(probed.tags), 'https://example.com/watch?v=mkv');
        });

        it('reports duration and height, which the import fallback recorded as zero', async function() {
            this.timeout(30000);
            const sample_path = path.join(temp_dir, 'plain.mp4');
            assert(writeSampleVideo(sample_path, {duration: 2}), 'ffmpeg could not write the sample');

            const probed = await transcoding_api.probeMedia(sample_path);
            assert(probed, 'probeMedia returned nothing');
            assert(Number(probed.format.duration) > 0, `expected a duration, got ${probed.format.duration}`);
            const video_stream = probed.streams.find(stream => stream.codec_type === 'video');
            assert.strictEqual(video_stream.height, 240);
        });

        it('resolves null for a file ffprobe cannot read', async function() {
            const junk_path = path.join(temp_dir, 'not-media.mp4');
            fs.writeFileSync(junk_path, 'this is not a video');

            assert.strictEqual(await transcoding_api.probeMedia(junk_path), null);
        });
    });
});
