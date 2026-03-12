/* eslint-disable no-undef */
const { assert, path, fs, logger, youtubedl_api, config_api, CONSTS } = require('./test-shared');

describe('youtube-dl', function() {
    beforeEach(async function () {
        if (fs.existsSync(CONSTS.DETAILS_BIN_PATH)) fs.unlinkSync(CONSTS.DETAILS_BIN_PATH);
        await youtubedl_api.checkForYoutubeDLUpdate();
    });
    it('Check latest version', async function() {
        this.timeout(300000);
        const original_fork = config_api.getConfigItem('ytdl_default_downloader');
        const latest_version = await youtubedl_api.getLatestUpdateVersion(original_fork);
        if (!latest_version) {
            logger.warn('Skipping latest version check: upstream tag API returned no version.');
            this.skip();
        }
        assert(latest_version > CONSTS.OUTDATED_YOUTUBEDL_VERSION);
    });

    it('Update youtube-dl', async function() {
        this.timeout(300000);
        const original_fork = config_api.getConfigItem('ytdl_default_downloader');
        const binary_path = path.join('test', 'test_binary');
        for (const youtubedl_fork in youtubedl_api.youtubedl_forks) {
            config_api.setConfigItem('ytdl_default_downloader', youtubedl_fork);
            const latest_version = await youtubedl_api.checkForYoutubeDLUpdate();
            await youtubedl_api.updateYoutubeDL(latest_version, binary_path);
            assert(fs.existsSync(binary_path));
            if (fs.existsSync(binary_path)) fs.unlinkSync(binary_path);
        }
        config_api.setConfigItem('ytdl_default_downloader', original_fork);
    });

    it('Does not redownload when details already exist for selected fork', async function() {
        this.timeout(300000);

        const selected_fork = config_api.getConfigItem('ytdl_default_downloader');
        const current_details = fs.readJSONSync(CONSTS.DETAILS_BIN_PATH);
        const current_version = current_details[selected_fork].version;
        const selected_binary_path = current_details[selected_fork].path;
        const binary_existed_before = fs.existsSync(selected_binary_path);
        if (!binary_existed_before) {
            fs.ensureDirSync(path.dirname(selected_binary_path));
            fs.writeFileSync(selected_binary_path, '');
        }

        let update_called = false;
        const original_get_latest = youtubedl_api.getLatestUpdateVersion;
        const original_update = youtubedl_api.updateYoutubeDL;

        try {
            youtubedl_api.getLatestUpdateVersion = async () => current_version;
            youtubedl_api.updateYoutubeDL = async () => { update_called = true; };

            await youtubedl_api.checkForYoutubeDLUpdate();

            const details_after = fs.readJSONSync(CONSTS.DETAILS_BIN_PATH);
            assert(details_after[selected_fork]);
            assert(details_after[selected_fork].version === current_version);
            assert(!update_called);
        } finally {
            if (!binary_existed_before && fs.existsSync(selected_binary_path)) {
                fs.unlinkSync(selected_binary_path);
            }
            youtubedl_api.getLatestUpdateVersion = original_get_latest;
            youtubedl_api.updateYoutubeDL = original_update;
        }
    });

    it('Run process', async function() {
        this.timeout(300000);
        const downloader_api = require('../downloader');
        const url = 'https://www.youtube.com/watch?v=hpigjnKl7nI';
        const args = await downloader_api.generateArgs(url, 'video', {}, null, true);
        const {child_process} = await youtubedl_api.runYoutubeDL(url, args);
        assert(child_process);
    });
});

