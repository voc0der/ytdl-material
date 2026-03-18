/* eslint-disable no-undef */
const { assert, path, fs, youtubedl_api, CONSTS } = require('./test-shared');

describe('downloader info', function() {
    const fork = 'yt-dlp';
    const binary_path = path.join('appdata', 'bin', fork + (process.platform === 'win32' ? '.exe' : ''));
    const details_backup_path = `${CONSTS.DETAILS_BIN_PATH}.codex-backup`;
    const binary_backup_path = `${binary_path}.codex-backup`;
    let had_details = false;
    let had_binary = false;

    beforeEach(function() {
        had_details = fs.existsSync(CONSTS.DETAILS_BIN_PATH);
        had_binary = fs.existsSync(binary_path);

        if (had_details) {
            fs.moveSync(CONSTS.DETAILS_BIN_PATH, details_backup_path, { overwrite: true });
        }

        if (had_binary) {
            fs.moveSync(binary_path, binary_backup_path, { overwrite: true });
        }
    });

    afterEach(function() {
        if (fs.existsSync(CONSTS.DETAILS_BIN_PATH)) {
            fs.removeSync(CONSTS.DETAILS_BIN_PATH);
        }

        if (fs.existsSync(binary_path)) {
            fs.removeSync(binary_path);
        }

        if (had_details && fs.existsSync(details_backup_path)) {
            fs.moveSync(details_backup_path, CONSTS.DETAILS_BIN_PATH, { overwrite: true });
        }

        if (had_binary && fs.existsSync(binary_backup_path)) {
            fs.moveSync(binary_backup_path, binary_path, { overwrite: true });
        }

        if (!had_details && fs.existsSync(details_backup_path)) {
            fs.removeSync(details_backup_path);
        }

        if (!had_binary && fs.existsSync(binary_backup_path)) {
            fs.removeSync(binary_backup_path);
        }
    });

    it('returns the installed downloader version when the binary exists', function() {
        fs.ensureDirSync(path.dirname(CONSTS.DETAILS_BIN_PATH));
        fs.ensureDirSync(path.dirname(binary_path));
        fs.writeJSONSync(CONSTS.DETAILS_BIN_PATH, {
            [fork]: {
                downloader: fork,
                version: '4.3.3'
            }
        });
        fs.writeFileSync(binary_path, '');

        const details = youtubedl_api.getYoutubeDLDetails(fork);

        assert.strictEqual(details.downloader, fork);
        assert.strictEqual(details.version, '4.3.3');
        assert.strictEqual(details.binary_exists, true);
        assert.strictEqual(details.loaded, true);
    });

    it('hides the stored version when the binary is missing', function() {
        fs.ensureDirSync(path.dirname(CONSTS.DETAILS_BIN_PATH));
        fs.writeJSONSync(CONSTS.DETAILS_BIN_PATH, {
            [fork]: {
                downloader: fork,
                version: '4.3.3'
            }
        });

        const details = youtubedl_api.getYoutubeDLDetails(fork);

        assert.strictEqual(details.downloader, fork);
        assert.strictEqual(details.version, null);
        assert.strictEqual(details.binary_exists, false);
        assert.strictEqual(details.loaded, false);
    });
});
