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
});
