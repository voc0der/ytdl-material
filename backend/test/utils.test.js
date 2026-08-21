/* eslint-disable no-undef */
const { assert, fs, path, exec, utils } = require('./test-shared');

describe('Utils', async function() {
    it('Strip properties', async function() {
        const test_obj = {test1: 'test1', test2: 'test2', test3: 'test3'};
        const stripped_obj = utils.stripPropertiesFromObject(test_obj, ['test1', 'test3']);
        assert(!stripped_obj['test1'] && stripped_obj['test2'] && !stripped_obj['test3'])
    });

    it('Convert flat object to nested object', async function() {
        // No modfication
        const flat_obj0 = {'test1': {'test_sub': true}, 'test2': {test_sub: true}};
        const nested_obj0 = utils.convertFlatObjectToNestedObject(flat_obj0);
        assert(nested_obj0['test1'] && nested_obj0['test1']['test_sub']);
        assert(nested_obj0['test2'] && nested_obj0['test2']['test_sub']);

        // Standard setup
        const flat_obj1 = {'test1.test_sub': true, 'test2.test_sub': true};
        const nested_obj1 = utils.convertFlatObjectToNestedObject(flat_obj1);
        assert(nested_obj1['test1'] && nested_obj1['test1']['test_sub']);
        assert(nested_obj1['test2'] && nested_obj1['test2']['test_sub']);

        // Nested branches
        const flat_obj2 = {'test1.test_sub': true, 'test1.test2.test_sub': true};
        const nested_obj2 = utils.convertFlatObjectToNestedObject(flat_obj2);
        assert(nested_obj2['test1'] && nested_obj2['test1']['test_sub']);
        assert(nested_obj2['test1'] && nested_obj2['test1']['test2'] && nested_obj2['test1']['test2']['test_sub']);
    });

    it('Redacts sensitive command args for logging', async function() {
        const redacted = utils.redactCommandArgsForLogging([
            '--username', 'user@example.com',
            '--password', 'super-secret',
            '--cookies=appdata/cookies.txt',
            '--proxy', 'http://user:pass@proxy:8080',
            '-o', '%(title)s.%(ext)s'
        ]);

        assert.deepStrictEqual(redacted, [
            '--username', '[REDACTED]',
            '--password', '[REDACTED]',
            '--cookies=[REDACTED]',
            '--proxy', '[REDACTED]',
            '-o', '%(title)s.%(ext)s'
        ]);
    });

    it('Builds public asset URLs from the configured base URL', function() {
        const baseURL = utils.getBaseURL();
        assert.strictEqual(
            utils.getPublicAssetURL('assets/images/logo_128px.png'),
            `${baseURL}/assets/images/logo_128px.png`
        );
        assert.strictEqual(
            utils.getPublicAssetURL('/favicon.ico'),
            `${baseURL}/favicon.ico`
        );
    });

    it('Parses expected file size from formats for selected format ids', function() {
        const info = {
            format_id: '137+251',
            formats: [
                {format_id: '137', filesize: 100},
                {format_id: '251', filesize_approx: 25},
                {format_id: '999', filesize: 999}
            ]
        };
        assert.strictEqual(utils.getExpectedFileSize(info), 125);
    });

    it('Falls back to requested_formats when formats sizes are unavailable', function() {
        const info = {
            format_id: '137+251',
            formats: [
                {format_id: '137'},
                {format_id: '251'}
            ],
            requested_formats: [
                {format_id: '137', filesize_approx: 1000},
                {format_id: '251', filesize: 500}
            ]
        };
        assert.strictEqual(utils.getExpectedFileSize(info), 1500);
    });

    it('Falls back to top-level filesize approximation when needed', function() {
        const info = {
            format_id: 'bestvideo+bestaudio',
            formats: [],
            filesize_approx: 4096
        };
        assert.strictEqual(utils.getExpectedFileSize(info), 4096);
    });

    it('Handles fallback format expressions without overcounting all variants', function() {
        const info = {
            format_id: '22/18',
            formats: [
                {format_id: '22', filesize: 2200},
                {format_id: '18', filesize: 1800}
            ]
        };
        assert.strictEqual(utils.getExpectedFileSize(info), 2200);
    });

    it('Estimates size from requested format bitrate and duration when filesize is unavailable', function() {
        const info = {
            format_id: '401+251',
            duration: 10,
            requested_formats: [
                {format_id: '401', tbr: 1000},
                {format_id: '251', abr: 128}
            ]
        };
        const expected = ((1000 + 128) * 1000 / 8) * 10;
        assert.strictEqual(utils.getExpectedFileSize(info), expected);
    });

    it('Estimates size from top-level bitrate and duration as final fallback', function() {
        const info = {
            format_id: 'bestvideo+bestaudio',
            duration: 12,
            tbr: 1500
        };
        const expected = (1500 * 1000 / 8) * 12;
        assert.strictEqual(utils.getExpectedFileSize(info), expected);
    });

    describe('snipFile', function() {
        const snip_dir = path.join(__dirname, 'tmp-snip-test');
        const source_path = path.join(snip_dir, 'snip-source.mp4');

        async function probeDuration(file_path) {
            const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file_path}"`);
            return parseFloat(stdout.trim());
        }

        beforeEach(async function() {
            this.timeout(60000);
            await fs.ensureDir(snip_dir);
            // The checked-in sample is only a second long, which is too short to trim.
            await exec(`ffmpeg -y -v error -f lavfi -i testsrc=duration=6:size=128x96:rate=10 -pix_fmt yuv420p "${source_path}"`);
        });

        afterEach(async function() {
            await fs.remove(snip_dir);
        });

        it('writes the trimmed range to a new file and leaves the source alone', async function() {
            this.timeout(60000);
            const output_path = path.join(snip_dir, 'snip-output.mp4');
            const source_duration_before = await probeDuration(source_path);

            const success = await utils.snipFile(source_path, output_path, 1, 3, '.mp4');

            assert.strictEqual(success, true);
            assert.strictEqual(fs.existsSync(output_path), true);
            assert.strictEqual(fs.existsSync(source_path), true, 'the source file must not be consumed');

            const output_duration = await probeDuration(output_path);
            assert.ok(Math.abs(output_duration - 2) < 0.5, `expected roughly 2s, got ${output_duration}s`);

            const source_duration_after = await probeDuration(source_path);
            assert.ok(Math.abs(source_duration_after - source_duration_before) < 0.01, 'the source duration must be unchanged');
        });

        it('reports failure and leaves no output behind when the source cannot be read', async function() {
            this.timeout(60000);
            const output_path = path.join(snip_dir, 'missing-output.mp4');

            const success = await utils.snipFile(path.join(snip_dir, 'does-not-exist.mp4'), output_path, 1, 3, '.mp4');

            assert.strictEqual(success, false);
            assert.strictEqual(fs.existsSync(output_path), false);
        });

        it('reports progress while snipping', async function() {
            this.timeout(60000);
            const output_path = path.join(snip_dir, 'progress-output.mp4');
            const reported = [];

            const success = await utils.snipFile(source_path, output_path, 0, 5, '.mp4', (percent) => reported.push(percent));

            assert.strictEqual(success, true);
            assert.ok(reported.every(percent => percent >= 0 && percent <= 100), 'progress must stay within 0-100');
        });

        it('measures progress against the snipped range, not the length of the source', async function() {
            this.timeout(60000);
            const output_path = path.join(snip_dir, 'scaled-progress-output.mp4');
            const reported = [];

            // A 1s range out of a 6s source: measuring against the source would cap this
            // near 17%, so anything approaching 100 proves it scales to the request.
            const success = await utils.snipFile(source_path, output_path, 4, 5, '.mp4', (percent) => reported.push(percent));

            assert.strictEqual(success, true);
            assert.ok(reported.length > 0, 'at least one progress event should be reported');
            assert.ok(Math.max(...reported) > 50, `progress should approach 100, peaked at ${Math.max(...reported)}`);
        });
    });

    describe('cropFile', function() {
        const crop_dir = path.join(__dirname, 'tmp-crop-test');
        const crop_path = path.join(crop_dir, 'crop-source.mp4');

        beforeEach(async function() {
            this.timeout(60000);
            await fs.ensureDir(crop_dir);
            await exec(`ffmpeg -y -v error -f lavfi -i testsrc=duration=6:size=128x96:rate=10 -pix_fmt yuv420p "${crop_path}"`);
        });

        afterEach(async function() {
            await fs.remove(crop_dir);
        });

        it('replaces the original file in place', async function() {
            this.timeout(60000);
            const success = await utils.cropFile(crop_path, 1, 3, '.mp4');

            assert.strictEqual(success, true);
            assert.strictEqual(fs.existsSync(crop_path), true);
            assert.strictEqual(fs.existsSync(`${crop_path}.cropped.mp4`), false, 'the temp file must be cleaned up');

            const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${crop_path}"`);
            const duration = parseFloat(stdout.trim());
            assert.ok(Math.abs(duration - 2) < 0.5, `expected roughly 2s, got ${duration}s`);
        });
    });

    /*************************************************
     * The handler at /api/stream answered a browser
     * correctly and everything else wrongly. Two
     * shapes hung the connection outright: the
     * Content-Length was computed from the range that
     * was asked for rather than the bytes that could
     * be sent, so the client waited forever for a
     * remainder that did not exist.
     *
     * Every case below was observed failing against
     * the previous implementation.
     ************************************************/
    describe('parseByteRange', function() {
        const SIZE = 1000;

        it('answers the range a browser actually sends', function() {
            assert.deepStrictEqual(utils.parseByteRange('bytes=0-', SIZE), {start: 0, end: 999, length: 1000});
            assert.deepStrictEqual(utils.parseByteRange('bytes=0-99', SIZE), {start: 0, end: 99, length: 100});
        });

        it('reads the tail of the file for a suffix range', function() {
            // 'bytes=-500' is the last 500 bytes, not bytes 0 through 500. This used to
            // parse as NaN and throw ERR_OUT_OF_RANGE out of createReadStream, which
            // express turned into a 500 -- on what is often a player's first request,
            // because the index of a container can live at the end of it.
            assert.deepStrictEqual(utils.parseByteRange('bytes=-500', SIZE), {start: 500, end: 999, length: 500});
            assert.deepStrictEqual(utils.parseByteRange('bytes=-1', SIZE), {start: 999, end: 999, length: 1});
        });

        it('treats a suffix longer than the file as the whole file', function() {
            assert.deepStrictEqual(utils.parseByteRange('bytes=-5000', SIZE), {start: 0, end: 999, length: 1000});
        });

        it('refuses a zero-length suffix', function() {
            assert.deepStrictEqual(utils.parseByteRange('bytes=-0', SIZE), {satisfiable: false});
        });

        it('clamps an end past the end of the file', function() {
            // The read stream stops at EOF regardless. Before clamping, the response
            // promised 4101 bytes and delivered 100, then never closed.
            assert.deepStrictEqual(utils.parseByteRange('bytes=900-5000', SIZE), {start: 900, end: 999, length: 100});
            assert.deepStrictEqual(utils.parseByteRange('bytes=999-2000', SIZE), {start: 999, end: 999, length: 1});
        });

        it('refuses a range that starts at or past the end of the file', function() {
            // Previously a 206 carrying 'Content-Range: bytes 5000-6000/1000' -- a range
            // outside the resource, which RFC 9110 does not allow -- and then no body.
            assert.deepStrictEqual(utils.parseByteRange('bytes=5000-6000', SIZE), {satisfiable: false});
            assert.deepStrictEqual(utils.parseByteRange('bytes=1000-', SIZE), {satisfiable: false});
        });

        it('refuses an inverted range', function() {
            assert.deepStrictEqual(utils.parseByteRange('bytes=500-100', SIZE), {satisfiable: false});
        });

        it('refuses any range against an empty file', function() {
            assert.deepStrictEqual(utils.parseByteRange('bytes=0-', 0), {satisfiable: false});
            assert.deepStrictEqual(utils.parseByteRange('bytes=-10', 0), {satisfiable: false});
        });

        it('ignores a header it cannot parse rather than failing the request', function() {
            // RFC 9110: a recipient that does not understand a Range header must act as
            // though it were not there. Each of these used to reach createReadStream as
            // NaN and produce a 500.
            for (const header of ['bytes=abc-def', 'bytes=-', 'bytes=', 'items=0-99', 'bytes=0-99, 200-299', '', '   ']) {
                assert.strictEqual(utils.parseByteRange(header, SIZE), null, `expected ${JSON.stringify(header)} to be ignored`);
            }
        });

        it('ignores a missing header, and a size it cannot use', function() {
            assert.strictEqual(utils.parseByteRange(undefined, SIZE), null);
            assert.strictEqual(utils.parseByteRange(null, SIZE), null);
            assert.strictEqual(utils.parseByteRange('bytes=0-', undefined), null);
            assert.strictEqual(utils.parseByteRange('bytes=0-', -1), null);
            assert.strictEqual(utils.parseByteRange('bytes=0-', 10.5), null);
        });

        it('tolerates surrounding whitespace', function() {
            assert.deepStrictEqual(utils.parseByteRange('  bytes=10-20  ', SIZE), {start: 10, end: 20, length: 11});
        });

        /*************************************************
         * The invariant the hang violated: whatever is
         * promised in Content-Length must be exactly what
         * a read of [start, end] can deliver.
         ************************************************/
        it('never describes more bytes than the file holds', function() {
            const headers = [
                'bytes=0-', 'bytes=0-0', 'bytes=0-99', 'bytes=-1', 'bytes=-500', 'bytes=-5000',
                'bytes=1-', 'bytes=999-', 'bytes=900-5000', 'bytes=999-2000', 'bytes=500-499999'
            ];
            for (const header of headers) {
                const parsed = utils.parseByteRange(header, SIZE);
                assert.ok(parsed && parsed.satisfiable !== false, `expected ${header} to be satisfiable`);
                assert.ok(parsed.start >= 0, `${header}: start below zero`);
                assert.ok(parsed.end < SIZE, `${header}: end past the last byte`);
                assert.ok(parsed.start <= parsed.end, `${header}: inverted`);
                assert.strictEqual(parsed.length, (parsed.end - parsed.start) + 1, `${header}: length disagrees with the range`);
            }
        });
    });


    /*************************************************
     * /api/stream used a bare .pipe(), which neither
     * listens for a read error nor closes the source
     * when the client goes away. The first took the
     * process down; the second leaked a descriptor
     * per abandoned seek, which is how a player
     * behaves normally.
     ************************************************/
    describe('pipeMediaFileToResponse', function() {
        const { Writable } = require('stream');
        const config_api = require('../config');
        const sample = path.join(__dirname, 'sample_mp4.mp4');

        function sink() {
            return new Writable({write(chunk, encoding, callback) { callback(); }});
        }

        function closed(stream) {
            return new Promise(resolve => stream.on('close', resolve));
        }

        afterEach(function() {
            for (const key of Object.keys(config_api.descriptors)) delete config_api.descriptors[key];
        });

        it('registers an open stream so a delete can release its lock', function() {
            const file = fs.createReadStream(sample);
            utils.pipeMediaFileToResponse(file, sink(), 'register_uid');

            assert.ok(config_api.descriptors['register_uid'].includes(file),
                'files.js destroys these on delete -- a stream missing from the registry is a lock nothing can find');
            file.destroy();
        });

        it('releases the registration when the response finishes', async function() {
            const file = fs.createReadStream(sample);
            utils.pipeMediaFileToResponse(file, sink(), 'finish_uid');
            await closed(file);

            assert.strictEqual('finish_uid' in config_api.descriptors, false,
                'the uid should not keep an empty array once nothing is open for it');
        });

        it('survives a read error rather than taking the process down', async function() {
            // fs.existsSync runs before the stream opens, so a file deleted in between --
            // which this application does to its own files -- used to emit 'error' with no
            // listener, which is an uncaught exception.
            const uncaught = [];
            const existing = process.listeners('uncaughtException');
            process.removeAllListeners('uncaughtException');
            process.on('uncaughtException', err => uncaught.push(err));

            try {
                const missing = fs.createReadStream(path.join(__dirname, 'no-such-media-file.mp4'));
                utils.pipeMediaFileToResponse(missing, sink(), 'missing_uid');
                await closed(missing);
                await new Promise(resolve => setTimeout(resolve, 50));
            } finally {
                process.removeAllListeners('uncaughtException');
                existing.forEach(listener => process.on('uncaughtException', listener));
            }

            assert.deepStrictEqual(uncaught.map(e => e.code), [], 'the read error must not escape as an uncaught exception');
            assert.strictEqual('missing_uid' in config_api.descriptors, false, 'a failed stream must still be released');
        });

        it('destroys the source when the client goes away mid-response', async function() {
            const file = fs.createReadStream(sample);
            const destination = sink();
            utils.pipeMediaFileToResponse(file, destination, 'abort_uid');

            destination.destroy();
            await closed(file);

            assert.strictEqual(file.destroyed, true,
                'a bare pipe leaves the source open, so every abandoned seek holds a descriptor open');
            assert.strictEqual('abort_uid' in config_api.descriptors, false);
        });

        it('survives the delete path destroying every stream for a uid', async function() {
            /*************************************************
             * files.js walks this registry by index and
             * destroys each entry to release the file locks
             * before deleting. If the release ran
             * synchronously inside destroy(), the array
             * would shrink underneath that loop and skip
             * every other stream.
             ************************************************/
            const streams = [fs.createReadStream(sample), fs.createReadStream(sample), fs.createReadStream(sample)];
            // A sink that never calls back holds the streams open, as a slow client would.
            streams.forEach(file => utils.pipeMediaFileToResponse(file, new Writable({write() {}}), 'delete_uid'));
            assert.strictEqual(config_api.descriptors['delete_uid'].length, 3);

            for (let i = 0; i < config_api.descriptors['delete_uid'].length; i++) {
                config_api.descriptors['delete_uid'][i].destroy();
            }
            await Promise.all(streams.map(closed));

            assert.deepStrictEqual(streams.map(file => file.destroyed), [true, true, true],
                'the loop must reach every stream, or a delete proceeds with locks still held');
            assert.strictEqual('delete_uid' in config_api.descriptors, false);
        });

        it('releases only the stream that closed', async function() {
            // The cleanup used to splice(indexOf(...)) unguarded, and splice(-1, 1) removes
            // the last element -- so releasing an entry twice took a live stream with it.
            const first = fs.createReadStream(sample);
            const second = fs.createReadStream(sample);
            utils.pipeMediaFileToResponse(first, sink(), 'shared_uid');
            // Held open by a sink that never calls back, so this test asserts on which
            // stream was released rather than on which one happened to finish first. With
            // a draining sink both complete, and under coverage instrumentation they both
            // completed before the assertion ran.
            utils.pipeMediaFileToResponse(second, new Writable({write() {}}), 'shared_uid');

            await closed(first);

            assert.deepStrictEqual(config_api.descriptors['shared_uid'], [second],
                'the other stream for this uid must still be reachable');
            second.destroy();
        });
    });

});
