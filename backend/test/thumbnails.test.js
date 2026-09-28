const { assert, db_api, downloader_api, useTemporaryMediaRoots } = require('./test-shared');
const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const transcoding_api = require('../transcoding');
const files_api = require('../files');
const thumbnails_api = require('../thumbnails');
const logger = require('../logger');

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

describe('Cover art generation', function() {
    this.timeout(30000);

    const SAMPLE_MP4 = path.join(__dirname, 'sample_mp4.mp4');
    const SOURCE_BYTES = Buffer.from('the thumbnail the source publishes');
    const FRAME_BYTES = Buffer.from('a frame grabbed from the file');

    let server;
    let server_url;
    let server_hits;
    let media;
    let originals;
    let info_calls;
    let frame_grabs;
    let warnings;
    let errors;

    before(async function() {
        server = http.createServer((req, res) => {
            server_hits.push(req.url);
            if (req.url === '/thumb.jpg') {
                res.writeHead(200, {'Content-Type': 'image/jpeg'});
                return res.end(SOURCE_BYTES);
            }
            res.writeHead(404);
            res.end();
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        server_url = `http://127.0.0.1:${server.address().port}`;
    });

    after(function(done) {
        server.close(done);
    });

    beforeEach(async function() {
        media = useTemporaryMediaRoots();
        server_hits = [];
        info_calls = [];
        frame_grabs = [];
        warnings = [];
        errors = [];
        originals = {
            getVideoInfoByURL: downloader_api.getVideoInfoByURL,
            probeMedia: transcoding_api.probeMedia,
            runFfmpeg: transcoding_api.runFfmpeg,
            generateThumbnailForFile: thumbnails_api.generateThumbnailForFile,
            getFilesMissingThumbnails: thumbnails_api.getFilesMissingThumbnails,
            warn: logger.warn,
            error: logger.error
        };
        logger.warn = message => warnings.push(String(message));
        logger.error = message => errors.push(String(message));
        sourceReports({});
        probeReports(120);
        frameGrabsSucceed();
        await db_api.removeAllRecords('files');
    });

    afterEach(async function() {
        downloader_api.getVideoInfoByURL = originals.getVideoInfoByURL;
        transcoding_api.probeMedia = originals.probeMedia;
        transcoding_api.runFfmpeg = originals.runFfmpeg;
        thumbnails_api.generateThumbnailForFile = originals.generateThumbnailForFile;
        thumbnails_api.getFilesMissingThumbnails = originals.getFilesMissingThumbnails;
        logger.warn = originals.warn;
        logger.error = originals.error;
        await db_api.removeAllRecords('files');
        media.restore();
    });

    // What yt-dlp says about the source, standing in for a network call.
    function sourceReports(info) {
        downloader_api.getVideoInfoByURL = async (url, args) => {
            info_calls.push({url, args});
            if (info instanceof Error) throw info;
            return info;
        };
    }

    function probeReports(duration_seconds) {
        // ffprobe reports the duration as a string.
        transcoding_api.probeMedia = async () => ({streams: [], format: {duration: String(duration_seconds)}, tags: {}});
    }

    function frameGrabsSucceed() {
        transcoding_api.runFfmpeg = async args => {
            frame_grabs.push(args);
            fs.writeFileSync(args[args.length - 1], FRAME_BYTES);
            return {success: true, error: null};
        };
    }

    function seekOf(args) {
        return args[args.indexOf('-ss') + 1];
    }

    async function addVideo(name, fields = {}) {
        const file_path = path.join(media.video, `${name}.mp4`);
        fs.copyFileSync(SAMPLE_MP4, file_path);
        const file_obj = {
            uid: `thumbnail-${name}`,
            title: name,
            path: file_path,
            url: `https://source.example.test/watch?v=${name}`,
            ...fields
        };
        await db_api.insertRecordIntoTable('files', {...file_obj});
        return file_obj;
    }

    function webpFor(file_obj) {
        return thumbnails_api.getGeneratedThumbnailPath(file_obj.path);
    }

    describe('generateThumbnailForFile', function() {
        it('prefers the thumbnail the source publishes', async function() {
            sourceReports({thumbnail: `${server_url}/thumb.jpg`});
            const file_obj = await addVideo('source');

            const result = await thumbnails_api.generateThumbnailForFile(file_obj);

            assert.deepStrictEqual(result, {thumbnail_path: webpFor(file_obj), method: 'source', seek_seconds: null});
            assert.deepStrictEqual(info_calls, [{url: file_obj.url, args: ['--skip-download']}]);
            assert.deepStrictEqual(frame_grabs, []);
            assert.deepStrictEqual(fs.readFileSync(webpFor(file_obj)), SOURCE_BYTES);
            assert.strictEqual(fs.statSync(webpFor(file_obj)).mode & 0o777, 0o644);

            const record = await db_api.getRecord('files', {uid: file_obj.uid});
            assert.strictEqual(record.thumbnailPath, webpFor(file_obj));
            assert.strictEqual(record.thumbnailURL, 'local');
        });

        it('keeps the thumbnail URL a record already has', async function() {
            const file_obj = await addVideo('remote-art', {thumbnailURL: 'https://images.example.test/1.jpg'});

            await thumbnails_api.generateThumbnailForFile(file_obj);

            const record = await db_api.getRecord('files', {uid: file_obj.uid});
            assert.strictEqual(record.thumbnailPath, webpFor(file_obj));
            assert.strictEqual(record.thumbnailURL, 'https://images.example.test/1.jpg');
        });

        it('reads the first entry when the metadata comes back as a list', async function() {
            sourceReports([{thumbnail: `  ${server_url}/thumb.jpg  `}, {thumbnail: `${server_url}/other.jpg`}]);
            const file_obj = await addVideo('listed');

            const result = await thumbnails_api.generateThumbnailForFile(file_obj);

            assert.strictEqual(result.method, 'source');
            assert.deepStrictEqual(server_hits, ['/thumb.jpg']);
        });

        it('fetches nothing but http and https', async function() {
            const secret = path.join(media.base, 'secret.txt');
            fs.writeFileSync(secret, 'not for the thumbnail');
            sourceReports({thumbnail: `file://${secret}`});
            const file_obj = await addVideo('file-url');

            const result = await thumbnails_api.generateThumbnailForFile(file_obj);

            assert.strictEqual(result.method, 'frame');
            assert.deepStrictEqual(fs.readFileSync(webpFor(file_obj)), FRAME_BYTES);
        });

        it('falls back to a frame when the source thumbnail cannot be downloaded', async function() {
            sourceReports({thumbnail: `${server_url}/gone.jpg`});
            const file_obj = await addVideo('gone');

            const result = await thumbnails_api.generateThumbnailForFile(file_obj);

            assert.deepStrictEqual(result, {thumbnail_path: webpFor(file_obj), method: 'frame', seek_seconds: 30});
            assert.deepStrictEqual(server_hits, ['/gone.jpg']);
            assert(warnings.some(message => message.includes(`${server_url}/gone.jpg`)), warnings.join('\n'));
            assert.deepStrictEqual(fs.readFileSync(webpFor(file_obj)), FRAME_BYTES);
        });

        it('falls back to a frame when the metadata lookup fails', async function() {
            sourceReports(new Error('yt-dlp could not reach the source'));
            const file_obj = await addVideo('offline');

            const result = await thumbnails_api.generateThumbnailForFile(file_obj);

            assert.strictEqual(result.method, 'frame');
            assert(warnings.some(message => message.includes('yt-dlp could not reach the source')), warnings.join('\n'));
        });

        it('does not look the source up when told not to', async function() {
            sourceReports({thumbnail: `${server_url}/thumb.jpg`});
            const file_obj = await addVideo('frame-only');

            const result = await thumbnails_api.generateThumbnailForFile(file_obj, {allow_source_fetch: false, timestamp_seconds: 12});

            assert.deepStrictEqual(result, {thumbnail_path: webpFor(file_obj), method: 'frame', seek_seconds: 12});
            assert.deepStrictEqual(info_calls, []);
            assert.strictEqual(frame_grabs.length, 1);
            assert.strictEqual(seekOf(frame_grabs[0]), '12');
            assert.strictEqual(frame_grabs[0][frame_grabs[0].indexOf('-i') + 1], file_obj.path);
        });

        it('does not look the source up for a record with no URL', async function() {
            const file_obj = await addVideo('imported', {url: '   '});

            const result = await thumbnails_api.generateThumbnailForFile(file_obj);

            assert.strictEqual(result.method, 'frame');
            assert.deepStrictEqual(info_calls, []);
        });

        it('seeks to the middle of a video shorter than the timestamp', async function() {
            probeReports(10);
            const file_obj = await addVideo('short');

            const result = await thumbnails_api.generateThumbnailForFile(file_obj);

            assert.strictEqual(result.seek_seconds, 5);
            assert.strictEqual(seekOf(frame_grabs[0]), '5');
        });

        it('removes what a failed frame grab left behind and records nothing', async function() {
            // ffmpeg exits non-zero *and* leaves a truncated file when it cannot finish.
            transcoding_api.runFfmpeg = async args => {
                fs.writeFileSync(args[args.length - 1], 'trunc');
                return {success: false, error: 'Invalid data found when processing input'};
            };
            const file_obj = await addVideo('broken');

            assert.strictEqual(await thumbnails_api.generateThumbnailForFile(file_obj), null);

            assert(!fs.existsSync(webpFor(file_obj)));
            assert(warnings.some(message => message.includes('Invalid data found')), warnings.join('\n'));
            const record = await db_api.getRecord('files', {uid: file_obj.uid});
            assert.strictEqual(record.thumbnailPath, undefined);
        });

        it('returns null for a record without a path', async function() {
            assert.strictEqual(await thumbnails_api.generateThumbnailForFile(null), null);
            assert.strictEqual(await thumbnails_api.generateThumbnailForFile({uid: 'no-path'}), null);
            assert.deepStrictEqual(frame_grabs, []);
        });

        it('refuses a file outside the media roots', async function() {
            const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-outside-'));
            try {
                const file_path = path.join(outside, 'elsewhere.mp4');
                fs.copyFileSync(SAMPLE_MP4, file_path);

                const result = await thumbnails_api.generateThumbnailForFile({uid: 'elsewhere', path: file_path, url: 'https://source.example.test/x'});

                assert.strictEqual(result, null);
                assert.deepStrictEqual(info_calls, []);
                assert.deepStrictEqual(frame_grabs, []);
                assert(!fs.existsSync(path.join(outside, 'elsewhere.webp')));
            } finally {
                fs.removeSync(outside);
            }
        });

        it('refuses a path that is a directory', async function() {
            assert.strictEqual(await thumbnails_api.generateThumbnailForFile({uid: 'root', path: media.video}), null);
            assert.deepStrictEqual(frame_grabs, []);
        });

        it('will not overwrite a file outside the media roots through a planted symlink', async function() {
            const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-outside-'));
            try {
                const target = path.join(outside, 'overwritten.webp');
                fs.writeFileSync(target, 'original');
                const file_obj = await addVideo('planted');
                fs.symlinkSync(target, webpFor(file_obj));

                assert.strictEqual(await thumbnails_api.generateThumbnailForFile(file_obj), null);

                assert.deepStrictEqual(frame_grabs, []);
                assert.strictEqual(fs.readFileSync(target, 'utf8'), 'original');
                assert(warnings.some(message => message.includes('outside the media roots')), warnings.join('\n'));
            } finally {
                fs.removeSync(outside);
            }
        });
    });

    describe('getFilesMissingThumbnails', function() {
        it('lists files with no cover art, or whose cover art is gone', async function() {
            const sidecar = path.join(media.video, 'has-art.jpg');
            fs.writeFileSync(sidecar, 'art');
            await db_api.insertRecordIntoTable('files', {uid: 'never-had-art', path: path.join(media.video, 'never-had-art.mp4')});
            await db_api.insertRecordIntoTable('files', {uid: 'has-art', path: path.join(media.video, 'has-art.mp4'), thumbnailPath: sidecar});
            await db_api.insertRecordIntoTable('files', {uid: 'lost-art', path: path.join(media.video, 'lost-art.mp4'), thumbnailPath: path.join(media.video, 'lost-art.jpg')});
            await db_api.insertRecordIntoTable('files', {uid: 'no-path'});

            const missing = await thumbnails_api.getFilesMissingThumbnails();

            assert.deepStrictEqual(missing.map(file_obj => file_obj.uid).sort(), ['lost-art', 'never-had-art']);
        });

        it('returns nothing for an empty library', async function() {
            assert.deepStrictEqual(await thumbnails_api.getFilesMissingThumbnails(), []);
        });
    });

    describe('generateMissingThumbnails', function() {
        function missing(count) {
            const files = Array.from({length: count}, (_, index) => ({uid: `file-${index}`}));
            thumbnails_api.getFilesMissingThumbnails = async () => files;
            return files;
        }

        it('counts what was generated and what was not', async function() {
            missing(4);
            const outcomes = {
                'file-0': async () => ({thumbnail_path: '/media/file-0.webp'}),
                'file-1': async () => null,
                'file-2': async () => { throw new Error('ffprobe went away'); },
                'file-3': async () => ({thumbnail_path: '/media/file-3.webp'})
            };
            thumbnails_api.generateThumbnailForFile = file_obj => outcomes[file_obj.uid]();

            const results = await thumbnails_api.generateMissingThumbnails();

            assert.deepStrictEqual(results, {generated: 2, failed: 2, total: 4});
            assert(errors.some(message => message.includes('file-2') && message.includes('ffprobe went away')), errors.join('\n'));
        });

        it('works through the library two files at a time', async function() {
            const files = missing(5);
            const seen = [];
            let in_flight = 0;
            let peak = 0;
            thumbnails_api.generateThumbnailForFile = async file_obj => {
                seen.push(file_obj.uid);
                peak = Math.max(peak, ++in_flight);
                await new Promise(resolve => setTimeout(resolve, 5));
                in_flight--;
                return {thumbnail_path: `/media/${file_obj.uid}.webp`};
            };

            const results = await thumbnails_api.generateMissingThumbnails();

            assert.strictEqual(peak, 2);
            assert.deepStrictEqual(seen.sort(), files.map(file_obj => file_obj.uid));
            assert.deepStrictEqual(results, {generated: 5, failed: 0, total: 5});
        });

        it('still gets through everything when asked for no concurrency at all', async function() {
            missing(3);
            let in_flight = 0;
            let peak = 0;
            thumbnails_api.generateThumbnailForFile = async () => {
                peak = Math.max(peak, ++in_flight);
                await new Promise(resolve => setTimeout(resolve, 5));
                in_flight--;
                return {thumbnail_path: '/media/x.webp'};
            };

            const results = await thumbnails_api.generateMissingThumbnails(0);

            assert.strictEqual(peak, 1);
            assert.deepStrictEqual(results, {generated: 3, failed: 0, total: 3});
        });

        it('does nothing when nothing is missing', async function() {
            missing(0);
            thumbnails_api.generateThumbnailForFile = async () => assert.fail('nothing to generate');

            assert.deepStrictEqual(await thumbnails_api.generateMissingThumbnails(), {generated: 0, failed: 0, total: 0});
        });
    });

    (has_ffmpeg ? describe : describe.skip)('against real ffmpeg', function() {
        beforeEach(function() {
            transcoding_api.probeMedia = originals.probeMedia;
            transcoding_api.runFfmpeg = originals.runFfmpeg;
        });

        it('grabs a real frame from the middle of a one-second video', async function() {
            const file_obj = await addVideo('real');

            const result = await thumbnails_api.generateThumbnailForFile(file_obj, {allow_source_fetch: false});

            assert.deepStrictEqual(result, {thumbnail_path: webpFor(file_obj), method: 'frame', seek_seconds: 0.5});
            const written = fs.readFileSync(webpFor(file_obj));
            assert.strictEqual(written.toString('ascii', 0, 4), 'RIFF');
            assert.strictEqual(written.toString('ascii', 8, 12), 'WEBP');
        });

        it('leaves nothing behind for a file ffmpeg cannot decode', async function() {
            const file_obj = await addVideo('junk');
            fs.writeFileSync(file_obj.path, 'this is not a video');

            assert.strictEqual(await thumbnails_api.generateThumbnailForFile(file_obj, {allow_source_fetch: false}), null);
            assert(!fs.existsSync(webpFor(file_obj)));
        });
    });
});
