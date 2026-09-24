const { assert, fs, os, path, db_api, config_api, downloader_api, youtubedl_api, useTemporaryMediaRoots } = require('./test-shared');
const { execFileSync } = require('child_process');
const codec_discovery = require('../codec-discovery');
const transcoding = require('../transcoding');

const SAMPLE = path.join(__dirname, 'sample_mp4.mp4');

function probe(file_path) {
    return JSON.parse(execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', file_path]));
}

function videoCodec(file_path) {
    return probe(file_path).streams.find(stream => stream.codec_type === 'video').codec_name;
}

function ffmpeg(args) {
    execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
}

describe('Codec discovery', function() {
    this.timeout(120000);

    let media = null;
    let work_dir = null;
    let fixtures = null;
    let file_count = 0;
    const stubbed = {};

    before(function() {
        fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-codec-fixtures-'));
        const color = ['-f', 'lavfi', '-i', 'color=black:size=64x64:rate=10:duration=1'];
        ffmpeg([...color, '-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', path.join(fixtures, 'hevc.mp4')]);
        ffmpeg([...color, '-c:v', 'libvpx-vp9', path.join(fixtures, 'vp9.webm')]);
        ffmpeg([...color, '-vf', 'setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc', '-c:v', 'libx264', path.join(fixtures, 'hdr.mp4')]);
    });

    after(function() {
        fs.removeSync(fixtures);
    });

    beforeEach(async function() {
        media = useTemporaryMediaRoots({ytdl_preferred_codec: '', ytdl_default_downloader: 'yt-dlp', ytdl_min_sleep_between_downloads: 0});
        work_dir = path.join(media.base, 'codec-work');
        codec_discovery.setWorkDir(work_dir);
        await db_api.removeAllRecords('files');
        await db_api.removeAllRecords('tasks', {key: codec_discovery.TASK_KEY});
        await setOptions({convert_to_preferred: true, max_conversions: 0});
        stubbed.getVideoInfoByURL = downloader_api.getVideoInfoByURL;
        stubbed.runYoutubeDL = youtubedl_api.runYoutubeDL;
        stubbed.runFfmpeg = transcoding.runFfmpeg;
    });

    afterEach(async function() {
        downloader_api.getVideoInfoByURL = stubbed.getVideoInfoByURL;
        youtubedl_api.runYoutubeDL = stubbed.runYoutubeDL;
        transcoding.runFfmpeg = stubbed.runFfmpeg;
        await db_api.removeAllRecords('files');
        await db_api.removeAllRecords('tasks', {key: codec_discovery.TASK_KEY});
        media.restore();
    });

    async function setOptions(options) {
        await db_api.removeAllRecords('tasks', {key: codec_discovery.TASK_KEY});
        await db_api.insertRecordIntoTable('tasks', {key: codec_discovery.TASK_KEY, title: 'Codec discovery', options, error: null});
    }

    async function addFile(source = SAMPLE, fields = {}) {
        file_count++;
        const file_path = path.join(media.video, `file-${file_count}${path.extname(source)}`);
        fs.copyFileSync(source, file_path);
        const record = {
            uid: `codec-file-${file_count}`,
            id: `file-${file_count}`,
            title: `File ${file_count}`,
            isAudio: false,
            path: file_path,
            url: '',
            registered: file_count,
            ...fields
        };
        // A copy, because the local database keeps the object it is handed and later
        // updates would otherwise rewrite this one under the test.
        await db_api.insertRecordIntoTable('files', {...record});
        return record;
    }

    async function record(uid) {
        return await db_api.getRecord('files', {uid});
    }

    function leftovers(dir) {
        return fs.readdirSync(dir).filter(name => name.endsWith(codec_discovery.PART_SUFFIX));
    }

    it('records the codecs of files that have none, and converts nothing without a preference', async function() {
        const unprobed = await addFile();
        const known = await addFile(SAMPLE, {vcodec: 'av1', acodec: 'opus'});
        const missing = await addFile();
        fs.removeSync(missing.path);

        const summary = await codec_discovery.run();

        assert.strictEqual(summary.discovered, 1);
        assert.strictEqual(summary.unreadable, 1);
        assert.strictEqual(summary.converted, 0);
        const probed = await record(unprobed.uid);
        assert.strictEqual(probed.vcodec, 'h264');
        assert.strictEqual(probed.acodec, null);
        assert.strictEqual((await record(known.uid)).vcodec, 'av1', 'a record that already has codecs is not probed again');
        assert.strictEqual(videoCodec(unprobed.path), 'h264');
    });

    it('transcodes to the preferred codec when there is no source to download it from', async function() {
        config_api.setConfigItem('ytdl_preferred_codec', 'hevc');
        const file = await addFile();

        const summary = await codec_discovery.run();

        assert.strictEqual(summary.transcoded, 1);
        const converted = await record(file.uid);
        assert.strictEqual(converted.vcodec, 'hevc');
        assert.strictEqual(converted.path, file.path);
        assert.strictEqual(converted.size, fs.statSync(file.path).size);
        assert.strictEqual(converted.codec_conversion_error, null);

        const stream = probe(file.path).streams[0];
        assert.strictEqual(stream.codec_name, 'hevc');
        assert.strictEqual(stream.codec_tag_string, 'hvc1', 'HEVC in MP4 is tagged so Apple players take it');
        assert.deepStrictEqual(leftovers(media.video), []);
        assert(!fs.existsSync(path.join(work_dir, 'job.json')), 'the journal is gone once the file is settled');

        const again = await codec_discovery.run();
        assert.strictEqual(again.converted, 0, 'a converted file is not converted again');
    });

    it('records codecs but converts nothing when conversions are turned off', async function() {
        config_api.setConfigItem('ytdl_preferred_codec', 'hevc');
        await setOptions({convert_to_preferred: false, max_conversions: 0});
        const file = await addFile();

        const summary = await codec_discovery.run();

        assert.strictEqual(summary.discovered, 1);
        assert.strictEqual(summary.converted, 0);
        assert.strictEqual((await record(file.uid)).vcodec, 'h264');
        assert.strictEqual(videoCodec(file.path), 'h264');
    });

    it('stops at the per-run limit and leaves the rest for the next run', async function() {
        config_api.setConfigItem('ytdl_preferred_codec', 'hevc');
        await setOptions({convert_to_preferred: true, max_conversions: 1});
        const first = await addFile();
        const second = await addFile();

        const summary = await codec_discovery.run();

        assert.strictEqual(summary.converted, 1);
        assert.strictEqual(summary.remaining, 1);
        assert.strictEqual((await record(first.uid)).vcodec, 'hevc', 'the oldest file goes first');
        assert.strictEqual((await record(second.uid)).vcodec, 'h264');

        const next = await codec_discovery.run();
        assert.strictEqual(next.converted, 1);
        assert.strictEqual((await record(second.uid)).vcodec, 'hevc');
    });

    it('downloads the file again when the source offers the codec at its resolution', async function() {
        config_api.setConfigItem('ytdl_preferred_codec', 'hevc');
        const file = await addFile(SAMPLE, {url: 'https://example.com/watch?v=1'});

        downloader_api.getVideoInfoByURL = async (url, args) => {
            assert.strictEqual(url, file.url);
            assert(!args.includes('-o'), 'looking the source up downloads nothing');
            return [{duration: 1, formats: [
                {format_id: 'h264-480', vcodec: 'avc1.64001e', acodec: 'none', height: 480},
                {format_id: 'hevc-360', vcodec: 'hvc1.1.6.L90.90', acodec: 'none', height: 360},
                {format_id: 'hevc-480', vcodec: 'hvc1.1.6.L93.90', acodec: 'none', height: 480}
            ]}];
        };
        let download_args = null;
        youtubedl_api.runYoutubeDL = async (url, args) => {
            download_args = args;
            const output_template = args[args.indexOf('-o') + 1];
            fs.copyFileSync(path.join(fixtures, 'hevc.mp4'), output_template.replace('%(ext)s', 'mp4'));
            return {callback: Promise.resolve({parsed_output: [], err: ''})};
        };

        const summary = await codec_discovery.run();

        assert.strictEqual(summary.reacquired, 1);
        assert.strictEqual(download_args[download_args.indexOf('-f') + 1], 'hevc-480', 'the sample has no audio, so none is asked for');
        assert.strictEqual(download_args[download_args.indexOf('--merge-output-format') + 1], 'mp4');
        assert(!download_args.includes('--sponsorblock-remove'), 'a new copy must match the file it replaces');
        assert.strictEqual((await record(file.uid)).vcodec, 'hevc');
        assert.strictEqual(videoCodec(file.path), 'hevc');
        assert.deepStrictEqual(fs.readdirSync(work_dir), [], 'the download directory is cleaned up');
    });

    it('transcodes instead of downloading a source that runs longer than the file', async function() {
        config_api.setConfigItem('ytdl_preferred_codec', 'hevc');
        const file = await addFile(SAMPLE, {url: 'https://example.com/watch?v=2'});

        downloader_api.getVideoInfoByURL = async () => [{duration: 600, formats: [
            {format_id: 'hevc-480', vcodec: 'hvc1.1.6.L93.90', acodec: 'none', height: 480}
        ]}];
        youtubedl_api.runYoutubeDL = async () => {
            throw new Error('a trimmed file must not be downloaded again');
        };

        const summary = await codec_discovery.run();

        assert.strictEqual(summary.transcoded, 1);
        assert.strictEqual((await record(file.uid)).vcodec, 'hevc');
    });

    it('moves a file whose container cannot hold the codec into MP4', async function() {
        config_api.setConfigItem('ytdl_preferred_codec', 'hevc');
        const file = await addFile(path.join(fixtures, 'vp9.webm'));

        const summary = await codec_discovery.run();

        assert.strictEqual(summary.transcoded, 1);
        const converted = await record(file.uid);
        const new_path = file.path.replace(/\.webm$/, '.mp4');
        assert.strictEqual(converted.path, new_path);
        assert.strictEqual(converted.vcodec, 'hevc');
        assert(!fs.existsSync(file.path), 'the original is deleted once the record points at the new file');
        assert.strictEqual(videoCodec(new_path), 'hevc');
    });

    it('leaves HDR video alone rather than flattening it', async function() {
        config_api.setConfigItem('ytdl_preferred_codec', 'hevc');
        const file = await addFile(path.join(fixtures, 'hdr.mp4'));

        const summary = await codec_discovery.run();

        assert.strictEqual(summary.skipped, 1);
        assert.strictEqual(summary.converted, 0);
        assert.strictEqual(videoCodec(file.path), 'h264');
        assert.match((await record(file.uid)).codec_conversion_error.reason, /HDR/);
    });

    it('keeps the original and says so when a conversion fails', async function() {
        config_api.setConfigItem('ytdl_preferred_codec', 'hevc');
        const file = await addFile();
        const original = fs.readFileSync(file.path);
        transcoding.runFfmpeg = async (args) => {
            fs.writeFileSync(args[args.length - 1], 'half a file');
            return {success: false, error: 'Conversion failed!'};
        };

        const summary = await codec_discovery.run();

        assert.strictEqual(summary.failed, 1);
        assert.deepStrictEqual(fs.readFileSync(file.path), original);
        assert.deepStrictEqual(leftovers(media.video), []);
        const failed = await record(file.uid);
        assert.strictEqual(failed.vcodec, 'h264');
        assert.match(failed.codec_conversion_error.reason, /Conversion failed!/);
        const task = await db_api.getRecord('tasks', {key: codec_discovery.TASK_KEY});
        assert.match(task.error, /1 file could not be converted/);
    });

    it('discards a conversion that was cut off before it was saved', async function() {
        const file = await addFile(path.join(fixtures, 'vp9.webm'), {vcodec: 'vp9'});
        const final_path = file.path.replace(/\.webm$/, '.mp4');
        fs.ensureDirSync(work_dir);
        fs.writeJSONSync(path.join(work_dir, 'job.json'), {
            uid: file.uid, codec: 'hevc', source_path: file.path, final_path,
            part_path: `${final_path}${codec_discovery.PART_SUFFIX}`, started_at: Date.now() - 5000
        });
        fs.writeFileSync(`${final_path}${codec_discovery.PART_SUFFIX}`, 'unfinished');
        fs.writeFileSync(final_path, 'renamed into place, record never updated');
        fs.ensureDirSync(path.join(work_dir, 'download'));
        fs.writeFileSync(path.join(work_dir, 'download', 'media.mp4.part'), 'partial download');

        await codec_discovery.recoverInterruptedWork();

        assert(fs.existsSync(file.path), 'the original stands');
        assert(!fs.existsSync(final_path));
        assert.deepStrictEqual(leftovers(media.video), []);
        assert(!fs.existsSync(path.join(work_dir, 'job.json')));
        assert(!fs.existsSync(path.join(work_dir, 'download')));
        const kept = await record(file.uid);
        assert.strictEqual(kept.path, file.path);
        assert.strictEqual(kept.vcodec, 'vp9');
    });

    it('finishes a conversion that was cut off after it was saved', async function() {
        const file = await addFile(path.join(fixtures, 'vp9.webm'), {vcodec: 'vp9'});
        const final_path = file.path.replace(/\.webm$/, '.mp4');
        fs.copyFileSync(path.join(fixtures, 'hevc.mp4'), final_path);
        await db_api.updateRecord('files', {uid: file.uid}, {path: final_path});
        fs.ensureDirSync(work_dir);
        fs.writeJSONSync(path.join(work_dir, 'job.json'), {
            uid: file.uid, codec: 'hevc', source_path: file.path, final_path,
            part_path: `${final_path}${codec_discovery.PART_SUFFIX}`, started_at: Date.now() - 5000
        });

        await codec_discovery.recoverInterruptedWork();

        assert(!fs.existsSync(file.path), 'the replaced original is deleted');
        assert(fs.existsSync(final_path));
        assert.strictEqual((await record(file.uid)).vcodec, 'hevc', 'the record is read again from the file');
    });

    it('never deletes a file that was already there when the conversion started', async function() {
        const file = await addFile(path.join(fixtures, 'vp9.webm'), {vcodec: 'vp9'});
        const final_path = file.path.replace(/\.webm$/, '.mp4');
        fs.writeFileSync(final_path, 'somebody else\'s file');
        const long_ago = new Date(Date.now() - 60 * 60 * 1000);
        fs.utimesSync(final_path, long_ago, long_ago);
        fs.ensureDirSync(work_dir);
        fs.writeJSONSync(path.join(work_dir, 'job.json'), {
            uid: file.uid, codec: 'hevc', source_path: file.path, final_path,
            part_path: `${final_path}${codec_discovery.PART_SUFFIX}`, started_at: Date.now() - 5000
        });

        await codec_discovery.recoverInterruptedWork();

        assert(fs.existsSync(final_path));
        assert(fs.existsSync(file.path));
    });

    it('builds conversion arguments that keep everything but the video codec', function() {
        const hevc = codec_discovery.buildConversionArgs('in.mp4', 'out.part', {
            codec: 'hevc', output_ext: '.mp4', same_container: true, audio_codecs: ['aac']
        });
        assert.strictEqual(hevc[hevc.indexOf('-c:v') + 1], 'libx265');
        assert.strictEqual(hevc[hevc.indexOf('-tag:v') + 1], 'hvc1');
        assert.strictEqual(hevc[hevc.indexOf('-c:a') + 1], 'copy');
        assert.strictEqual(hevc[hevc.indexOf('-c:s') + 1], 'copy');
        assert(hevc.includes('0:V:0'), 'cover art must not be picked as the video stream');
        assert(!hevc.includes('-vf'), 'HEVC keeps the source bit depth');
        assert.deepStrictEqual(hevc.slice(-5), ['-movflags', '+faststart+use_metadata_tags', '-f', 'mp4', 'out.part']);

        const from_webm = codec_discovery.buildConversionArgs('in.webm', 'out.part', {
            codec: 'h264', output_ext: '.mp4', same_container: false, audio_codecs: ['vorbis']
        });
        assert.strictEqual(from_webm[from_webm.indexOf('-vf') + 1], 'format=nv12', 'H.264 is forced to 8-bit');
        assert.strictEqual(from_webm[from_webm.indexOf('-c:a') + 1], 'aac', 'MP4 cannot hold Vorbis');
        assert(!from_webm.includes('0:s?'), 'subtitles only come along when the container stays');

        const vaapi = transcoding.TRANSCODING_MODES.vaapi;
        const hardware = codec_discovery.buildConversionArgs('in.mkv', 'out.part', {
            codec: 'av1', output_ext: '.mkv', same_container: true, audio_codecs: ['opus'],
            hardware_settings: {...vaapi, video_encoder: vaapi.encoders.av1}
        });
        assert.deepStrictEqual(hardware.slice(1, hardware.indexOf('-i')), vaapi.input_options);
        assert.strictEqual(hardware[hardware.indexOf('-c:v') + 1], 'av1_vaapi');
        assert.strictEqual(hardware[hardware.indexOf('-vf') + 1], 'format=nv12,hwupload');
        assert(!hardware.includes('-movflags'));
        assert.deepStrictEqual(hardware.slice(-2), ['matroska', 'out.part']);
    });
});
