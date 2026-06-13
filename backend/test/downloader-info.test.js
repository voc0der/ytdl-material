/* eslint-disable no-undef */
const { assert, path, fs, youtubedl_api, config_api, CONSTS } = require('./test-shared');

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

    it('uses the system yt-dlp binary only when impersonation is enabled', function() {
        const system_binary_path = path.join('test', 'tmp-system-yt-dlp');
        const original_impersonation = config_api.getConfigItem('ytdl_use_ytdlp_impersonation');
        const original_lower_env = process.env.ytdl_ytdlp_impersonation_binary;
        const original_upper_env = process.env.YTDL_YTDLP_IMPERSONATION_BINARY;

        try {
            fs.ensureDirSync(path.dirname(system_binary_path));
            fs.writeFileSync(system_binary_path, '');
            process.env.ytdl_ytdlp_impersonation_binary = system_binary_path;
            delete process.env.YTDL_YTDLP_IMPERSONATION_BINARY;

            config_api.setConfigItem('ytdl_use_ytdlp_impersonation', false);
            assert.strictEqual(youtubedl_api.getYoutubeDLRuntimePath(fork), binary_path);

            config_api.setConfigItem('ytdl_use_ytdlp_impersonation', true);
            assert.strictEqual(youtubedl_api.getYoutubeDLRuntimePath(fork), system_binary_path);
            assert.strictEqual(
                youtubedl_api.getYoutubeDLRuntimePath('youtube-dl'),
                path.join('appdata', 'bin', 'youtube-dl' + (process.platform === 'win32' ? '.exe' : ''))
            );
        } finally {
            config_api.setConfigItem('ytdl_use_ytdlp_impersonation', original_impersonation);
            if (original_lower_env === undefined) {
                delete process.env.ytdl_ytdlp_impersonation_binary;
            } else {
                process.env.ytdl_ytdlp_impersonation_binary = original_lower_env;
            }
            if (original_upper_env === undefined) {
                delete process.env.YTDL_YTDLP_IMPERSONATION_BINARY;
            } else {
                process.env.YTDL_YTDLP_IMPERSONATION_BINARY = original_upper_env;
            }
            fs.removeSync(system_binary_path);
        }
    });
});
