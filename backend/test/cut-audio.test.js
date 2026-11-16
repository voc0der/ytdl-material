const {assert, fs, os, path, db_api, youtubedl_api, useTemporaryMediaRoots} = require('./test-shared');
const { execFileSync } = require('child_process');
const cut_audio = require('../cut-audio');
const transcoding = require('../transcoding');
const downloader = require('../downloader');
const notifications = require('../notifications');
const hooks = require('../hooks');

function ffmpeg(args) {
    execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
}

function probe(file_path) {
    return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries',
        'format=duration:format_tags:stream=codec_type,codec_name:stream_disposition=attached_pic:chapter=start_time,end_time:chapter_tags=title',
        file_path]));
}

// How long the sound plays past the end of the video when it is played back to back, the way
// a browser plays it: asetpts times each sample by how many came before it. A cut that left
// its audio late leaves this much extra sound.
function extraAudioSeconds(file_path) {
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file_path, '-map', '0:a:0', '-af', 'asetpts=N/SR/TB',
        '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], {maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
    return pcm.length / 2 / 8000 - Number(probe(file_path).format.duration);
}

describe('Audio after a cut', function() {
    this.timeout(60000);

    let fixtures = null;
    let work = null;
    let file_count = 0;

    // What yt-dlp does to remove a SponsorBlock segment: ffmpeg's concat demuxer with an out
    // point and an in point, and -c copy. With a keyframe every 2 s, the part after 2.3-5.7
    // starts at 4 s, and its first 1.7 s of sound overlaps what is already there. Tags,
    // chapters and cover art are added after, as yt-dlp adds them.
    function makeCutFile(ext) {
        const source = path.join(fixtures, `source${ext}`);
        const video_codec = ext === '.webm' ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-c:a', 'libopus'] : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
        ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
            ...video_codec, '-g', '20', '-keyint_min', '20', '-sc_threshold', '0', source]);
        const spec = path.join(fixtures, 'cut.ffconcat');
        fs.writeFileSync(spec, `ffconcat version 1.0\nfile '${source}'\noutpoint 2.300000\nfile '${source}'\ninpoint 5.700000\n`);
        const cut = path.join(fixtures, `cut${ext}`);
        ffmpeg(['-f', 'concat', '-safe', '0', '-i', spec, '-map', '0', '-dn', '-ignore_unknown', '-c', 'copy', cut]);

        const metadata = path.join(fixtures, 'metadata.txt');
        fs.writeFileSync(metadata, [';FFMETADATA1', 'title=Cut clip', 'comment=https://example.com/watch?v=abc',
            '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=2000', 'title=Intro',
            '[CHAPTER]', 'TIMEBASE=1/1000', 'START=2000', 'END=4600', 'title=Main', ''].join('\n'));
        const cover = path.join(fixtures, 'cover.jpg');
        ffmpeg(['-f', 'lavfi', '-i', 'color=red:size=16x16', '-frames:v', '1', cover]);
        const finished = path.join(fixtures, `cut-tagged${ext}`);
        // WebM cannot hold cover art.
        const cover_input = ext === '.webm' ? [] : ['-i', cover];
        const cover_output = ext === '.webm' ? [] : ['-map', '2', '-disposition:v:1', 'attached_pic'];
        ffmpeg(['-i', cut, '-i', metadata, ...cover_input, '-map', '0', ...cover_output, '-dn', '-c', 'copy',
            '-map_metadata', '1', '-map_chapters', '1', finished]);
        return finished;
    }

    before(function() {
        fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-cut-audio-fixtures-'));
        for (const ext of ['.mp4', '.webm']) fs.moveSync(makeCutFile(ext), path.join(fixtures, `squeezed${ext}`));
        ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(fixtures, 'uncut.mp4')]);
    });

    after(function() {
        fs.removeSync(fixtures);
    });

    beforeEach(function() {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-cut-audio-'));
    });

    afterEach(function() {
        fs.removeSync(work);
    });

    function copyFixture(name, ext = path.extname(name)) {
        file_count++;
        const file_path = path.join(work, `file-${file_count}${ext}`);
        fs.copyFileSync(path.join(fixtures, name), file_path);
        return file_path;
    }

    describe('finding the squeezed packets', function() {
        it('finds the packets MP4 moved one tick on, and those Matroska left on the same tick', function() {
            assert.deepStrictEqual(cut_audio.findSqueezedRuns([0, 1024, 2048, 2049, 2050, 2051, 3072, 4096]), [[3, 5]]);
            assert.deepStrictEqual(cut_audio.findSqueezedRuns([0, 21, 42, 42, 42, 63]), [[3, 4]]);
        });

        it('finds a run for each cut, including one at the very end', function() {
            assert.deepStrictEqual(cut_audio.findSqueezedRuns([0, 1024, 1025, 2048, 3072, 3073, 3074, 4096, 4097]), [[2, 2], [5, 6], [8, 8]]);
        });

        it('finds nothing in audio that plays on, or that it cannot tell about', function() {
            assert.deepStrictEqual(cut_audio.findSqueezedRuns([0, 1024, 2048, 3072]), []);
            assert.deepStrictEqual(cut_audio.findSqueezedRuns([0, 1024, 500, 1524]), []);
            assert.deepStrictEqual(cut_audio.findSqueezedRuns([0, null, 1, 1024]), []);
            assert.deepStrictEqual(cut_audio.findSqueezedRuns([]), []);
        });
    });

    it('knows which yt-dlp options cut ranges out', function() {
        assert.strictEqual(cut_audio.cutsRanges(['-f', 'best', '--sponsorblock-remove', 'sponsor']), true);
        assert.strictEqual(cut_audio.cutsRanges(['--sponsorblock-remove=sponsor,selfpromo']), true);
        assert.strictEqual(cut_audio.cutsRanges(['--remove-chapters', 'Intro']), true);
        assert.strictEqual(cut_audio.cutsRanges(['--sponsorblock-mark', 'all']), false);
        assert.strictEqual(cut_audio.cutsRanges([]), false);
        assert.strictEqual(cut_audio.cutsRanges(undefined), false);
    });

    for (const ext of ['.mp4', '.webm']) {
        it(`puts the audio of a cut ${ext} back in step with its video`, async function() {
            const file_path = copyFixture(`squeezed${ext}`);
            assert(extraAudioSeconds(file_path) > 1.5, 'the fixture should have the lag a cut leaves');
            const [stream] = await cut_audio.probeAudio(file_path);
            assert.strictEqual(stream.runs.length, 1);
            const [first, last] = stream.runs[0];

            assert.strictEqual(await cut_audio.resync(file_path), last - first + 1);

            assert(Math.abs(extraAudioSeconds(file_path)) < 0.1, `the audio should end with the video, not ${extraAudioSeconds(file_path)}s after it`);
            const [after] = await cut_audio.probeAudio(file_path);
            assert.deepStrictEqual(after.runs, []);
            assert.strictEqual(after.packets, stream.packets - (last - first + 1));
            assert(!fs.existsSync(`${file_path}${cut_audio.PART_SUFFIX}`));
        });
    }

    it('leaves the streams, tags, chapters, cover art, permissions and modification time as they were', async function() {
        const file_path = copyFixture('squeezed.mp4');
        fs.chmodSync(file_path, 0o640);
        const modified = new Date('2024-05-06T07:08:09Z');
        fs.utimesSync(file_path, modified, modified);
        const before = probe(file_path);
        assert.strictEqual(before.chapters.length, 2);
        assert(before.streams.some(stream => stream.disposition.attached_pic === 1));

        assert(await cut_audio.resync(file_path) > 0);

        assert.deepStrictEqual(probe(file_path), before);
        const stats = fs.statSync(file_path);
        assert.strictEqual(stats.mode & 0o777, 0o640);
        assert.strictEqual(stats.mtime.getTime(), modified.getTime());
    });

    it('does not rewrite a file no cut squeezed', async function() {
        const file_path = copyFixture('uncut.mp4');
        const inode = fs.statSync(file_path).ino;
        assert.strictEqual(await cut_audio.resync(file_path), 0);
        assert.strictEqual(fs.statSync(file_path).ino, inode);
    });

    it('leaves Matroska alone, since ffmpeg would turn its cover art into a video track', async function() {
        const file_path = copyFixture('squeezed.mp4', '.mkv');
        assert.strictEqual(cut_audio.canRewrite(file_path), false);
        assert.strictEqual(cut_audio.canRewrite(copyFixture('squeezed.webm')), true);
        const inode = fs.statSync(file_path).ino;
        await assert.rejects(cut_audio.resync(file_path), /not a container it rewrites/);
        assert.strictEqual(fs.statSync(file_path).ino, inode);
    });

    describe('when the copy goes wrong', function() {
        const original_runFfmpeg = transcoding.runFfmpeg;

        afterEach(function() {
            transcoding.runFfmpeg = original_runFfmpeg;
        });

        it('keeps the file when ffmpeg fails', async function() {
            const file_path = copyFixture('squeezed.mp4');
            const contents = fs.readFileSync(file_path);
            transcoding.runFfmpeg = async (args) => {
                fs.writeFileSync(args[args.length - 1], 'half a file');
                return {success: false, error: 'No space left on device'};
            };
            await assert.rejects(cut_audio.resync(file_path), /ffmpeg failed: No space left on device/);
            assert(fs.readFileSync(file_path).equals(contents));
            assert(!fs.existsSync(`${file_path}${cut_audio.PART_SUFFIX}`));
        });

        it('keeps the file when the copy still has the squeezed packets', async function() {
            const file_path = copyFixture('squeezed.mp4');
            const contents = fs.readFileSync(file_path);
            transcoding.runFfmpeg = async (args) => {
                fs.copyFileSync(file_path, args[args.length - 1]);
                return {success: true, error: null};
            };
            await assert.rejects(cut_audio.resync(file_path), /did not come out/);
            assert(fs.readFileSync(file_path).equals(contents));
            assert(!fs.existsSync(`${file_path}${cut_audio.PART_SUFFIX}`));
        });
    });

    describe('the library task', function() {
        let roots = null;
        let record_count = 0;

        beforeEach(async function() {
            roots = useTemporaryMediaRoots();
            await db_api.removeAllRecords('files');
        });

        afterEach(async function() {
            await db_api.removeAllRecords('files');
            roots.restore();
        });

        // A library file, with an info.json that says whether SponsorBlock was asked about it.
        async function addFile(fixture, {ext = path.extname(fixture), sponsorblock = true, audio = false} = {}) {
            record_count++;
            const file_path = path.join(audio ? roots.audio : roots.video, `file-${record_count}${ext}`);
            if (fixture) fs.copyFileSync(path.join(fixtures, fixture), file_path);
            else fs.writeFileSync(file_path, 'not a video');
            const sponsorblock_chapters = sponsorblock ? [{start_time: 2.3, end_time: 5.7, category: 'sponsor', title: 'Sponsor', type: 'skip'}] : [];
            fs.writeJSONSync(file_path.replace(/\.[^.]+$/, '.info.json'), {id: `file-${record_count}`, title: 'Clip', sponsorblock_chapters});
            const record = {uid: `cut-audio-${record_count}`, path: file_path, isAudio: audio, size: fs.statSync(file_path).size};
            await db_api.insertRecordIntoTable('files', record);
            return record;
        }

        it('puts the audio back in step in the videos that had SponsorBlock segments, and nothing else', async function() {
            const cut = await addFile('squeezed.mp4');
            const size_before = cut.size;
            const no_segments = await addFile('squeezed.mp4', {sponsorblock: false});
            const matroska = await addFile('squeezed.mp4', {ext: '.mkv'});
            const audio = await addFile('squeezed.mp4', {audio: true});
            const untouched = [no_segments, matroska, audio].map(file => [file.path, fs.statSync(file.path).ino]);

            await cut_audio.run();

            assert(Math.abs(extraAudioSeconds(cut.path)) < 0.1);
            const size_after = fs.statSync(cut.path).size;
            assert(size_after < size_before, 'the dropped packets should no longer take up room');
            assert.strictEqual((await db_api.getRecord('files', {uid: cut.uid})).size, size_after);
            for (const [file_path, inode] of untouched) assert.strictEqual(fs.statSync(file_path).ino, inode, `${file_path} should not be rewritten`);
        });

        it('fixes the rest when one cannot be read, then says how many failed', async function() {
            await addFile(null, {ext: '.mp4'});
            const cut = await addFile('squeezed.mp4');
            await assert.rejects(cut_audio.run(), /1 file\(s\) could not be fixed/);
            assert(Math.abs(extraAudioSeconds(cut.path)) < 0.1);
        });

        it('is a task that runs in the background', function() {
            const tasks_api = require('../tasks');
            assert.strictEqual(tasks_api.TASKS[cut_audio.TASK_KEY].run, cut_audio.run);
            assert.strictEqual(tasks_api.TASKS[cut_audio.TASK_KEY].runInBackground, true);
        });
    });

    describe('in a download', function() {
        const url = 'https://example.com/watch?v=cut';
        const original = {};
        let roots = null;

        beforeEach(async function() {
            roots = useTemporaryMediaRoots({ytdl_default_downloader: 'yt-dlp', ytdl_use_sponsorblock_api: true,
                ytdl_multi_user_mode: false, ytdl_max_concurrent_downloads: 0, ytdl_warn_on_duplicate: false, ytdl_use_youtubedl_archive: false});
            for (const table of ['files', 'download_queue', 'archives']) await db_api.removeAllRecords(table);
            for (const [object, key] of [[downloader, 'getVideoInfoByURL'], [youtubedl_api, 'runYoutubeDL'],
                [notifications, 'sendDownloadNotification'], [hooks, 'queueDownloadFinishedHooks']]) {
                original[key] = object[key];
            }
            notifications.sendDownloadNotification = () => {};
            hooks.queueDownloadFinishedHooks = () => {};
            const info = {...fs.readJSONSync(path.join(__dirname, 'sample_mp4.info.json')), id: 'cut', extractor: 'generic', webpage_url: url};
            downloader.getVideoInfoByURL = async () => [{...info}];
            // yt-dlp, having cut the sponsor out the way it does.
            youtubedl_api.runYoutubeDL = async (_url, args) => {
                const output = args[args.lastIndexOf('-o') + 1].replace('%(ext)s', 'mp4');
                fs.ensureDirSync(path.dirname(output));
                fs.copyFileSync(path.join(fixtures, 'squeezed.mp4'), output);
                const output_info = {...info, _filename: output};
                fs.writeJSONSync(output.replace(/\.mp4$/, '.info.json'), output_info);
                return {callback: Promise.resolve({parsed_output: [output_info], err: null})};
            };
        });

        afterEach(async function() {
            downloader.getVideoInfoByURL = original.getVideoInfoByURL;
            youtubedl_api.runYoutubeDL = original.runYoutubeDL;
            notifications.sendDownloadNotification = original.sendDownloadNotification;
            hooks.queueDownloadFinishedHooks = original.queueDownloadFinishedHooks;
            for (const table of ['files', 'download_queue', 'archives']) await db_api.removeAllRecords(table);
            roots.restore();
        });

        async function download(options = {}) {
            const queued = await downloader.createDownload(url, 'video', options);
            await downloader.collectInfo(queued.uid);
            const collected = await db_api.getRecord('download_queue', {uid: queued.uid});
            const [file_uid] = await downloader.downloadQueuedFile(queued.uid);
            return {args: collected.args, file: await db_api.getRecord('files', {uid: file_uid})};
        }

        it('puts the audio back in step before the file is added to the library', async function() {
            const {args, file} = await download();
            assert(args.includes('--sponsorblock-remove'));
            assert(Math.abs(extraAudioSeconds(file.path)) < 0.1);
            assert.strictEqual(file.size, fs.statSync(file.path).size);
        });

        it('leaves a download nothing was cut from as it came', async function() {
            const {args, file} = await download({disableSponsorBlock: true});
            assert(!cut_audio.cutsRanges(args));
            assert(fs.readFileSync(file.path).equals(fs.readFileSync(path.join(fixtures, 'squeezed.mp4'))));
        });
    });
});
