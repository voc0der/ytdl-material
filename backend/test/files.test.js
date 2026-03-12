/* eslint-disable no-undef */
const { assert, fs, path, files_api } = require('./test-shared');

describe('Files', function() {
    const fixture_dir = path.join(__dirname, 'tmp-files-test');
    const fixture_file_path = path.join(fixture_dir, 'chapter-video.mp4');
    const fixture_info_path = path.join(fixture_dir, 'chapter-video.info.json');

    beforeEach(async function() {
        await fs.ensureDir(fixture_dir);
    });

    afterEach(async function() {
        await fs.remove(fixture_dir);
    });

    it('attachFileChapters parses valid chapters from sidecar metadata', async function() {
        await fs.writeJSON(fixture_info_path, {
            chapters: [
                {title: 'Intro', start_time: 0, end_time: 45},
                {title: 'Main Part', start_time: 45, end_time: 120},
                {title: '', start_time: 120, end_time: 180},
                {title: 'Invalid Range', start_time: 180, end_time: 170}
            ]
        });

        const output = files_api.attachFileChapters({
            path: fixture_file_path,
            isAudio: false
        });

        assert.deepStrictEqual(output.chapters, [
            {title: 'Intro', start_time: 0, end_time: 45},
            {title: 'Main Part', start_time: 45, end_time: 120}
        ]);
    });

    it('attachFileChaptersCollection returns empty chapters when metadata is missing', function() {
        const output = files_api.attachFileChaptersCollection([{
            path: path.join(fixture_dir, 'missing-video.mp4'),
            isAudio: false
        }]);

        assert.deepStrictEqual(output[0].chapters, []);
    });
});
