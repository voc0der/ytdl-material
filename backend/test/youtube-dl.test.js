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

    it('Reports the real error instead of masking it with stale info-lookup JSON when the download itself fails', async function() {
        this.timeout(300000);

        const original_fork = config_api.getConfigItem('ytdl_default_downloader');
        config_api.setConfigItem('ytdl_default_downloader', 'yt-dlp');
        await youtubedl_api.checkForYoutubeDLUpdate('yt-dlp');

        const binary_path = path.join('appdata', 'bin', 'yt-dlp');
        const backup_path = `${binary_path}.real-test-backup`;
        fs.renameSync(binary_path, backup_path);
        fs.writeFileSync(binary_path, [
            '#!/usr/bin/env node',
            'process.stdout.write(\'{"id":"fake","title":"fake"}\\n\');',
            'process.stderr.write(\'ERROR: unable to download video data: HTTP Error 403: Forbidden\\n\');',
            'process.exit(1);',
            ''
        ].join('\n'));
        fs.chmodSync(binary_path, 0o755);

        try {
            const {callback} = await youtubedl_api.runYoutubeDL('https://www.youtube.com/watch?v=fake', []);
            const {parsed_output, err} = await callback;
            assert.strictEqual(parsed_output, null);
            assert(err);
            assert(err.stderr.includes('HTTP Error 403: Forbidden'));
        } finally {
            fs.unlinkSync(binary_path);
            fs.renameSync(backup_path, binary_path);
            config_api.setConfigItem('ytdl_default_downloader', original_fork);
        }
    });

    describe('JavaScript runtime args', function() {
        let original_runtimes = null;
        let original_fork = null;

        beforeEach(function() {
            original_runtimes = config_api.getConfigItem('ytdl_js_runtimes');
            original_fork = config_api.getConfigItem('ytdl_default_downloader');
            config_api.setConfigItem('ytdl_default_downloader', 'yt-dlp');
        });

        afterEach(function() {
            config_api.setConfigItem('ytdl_js_runtimes', original_runtimes);
            config_api.setConfigItem('ytdl_default_downloader', original_fork);
        });

        it('Does not pin a runtime by default so yt-dlp auto-detects', function() {
            config_api.setConfigItem('ytdl_js_runtimes', '');
            const args = youtubedl_api.ensureJavascriptRuntimeArgs(['-f', 'best'], 'yt-dlp');
            assert(!args.includes('--js-runtimes'));
            assert.deepStrictEqual(args, ['-f', 'best']);
        });

        it('Pins the configured runtime when one is set', function() {
            config_api.setConfigItem('ytdl_js_runtimes', 'deno');
            const args = youtubedl_api.ensureJavascriptRuntimeArgs(['-f', 'best'], 'yt-dlp');
            assert.deepStrictEqual(args, ['--js-runtimes', 'deno', '-f', 'best']);
        });

        it('Trims whitespace and ignores a blank configured runtime', function() {
            config_api.setConfigItem('ytdl_js_runtimes', '  deno  ');
            assert.deepStrictEqual(
                youtubedl_api.ensureJavascriptRuntimeArgs([], 'yt-dlp'),
                ['--js-runtimes', 'deno']
            );

            config_api.setConfigItem('ytdl_js_runtimes', '   ');
            assert.deepStrictEqual(youtubedl_api.ensureJavascriptRuntimeArgs([], 'yt-dlp'), []);
        });

        it('Leaves an explicitly supplied --js-runtimes untouched', function() {
            config_api.setConfigItem('ytdl_js_runtimes', 'deno');
            const args = youtubedl_api.ensureJavascriptRuntimeArgs(['--js-runtimes', 'node'], 'yt-dlp');
            assert.deepStrictEqual(args, ['--js-runtimes', 'node']);
        });

        it('Does not add runtime args for non yt-dlp forks', function() {
            config_api.setConfigItem('ytdl_js_runtimes', 'deno');
            const args = youtubedl_api.ensureJavascriptRuntimeArgs(['-f', 'best'], 'youtube-dl');
            assert(!args.includes('--js-runtimes'));
        });
    });

});


// Deliberately a sibling of the 'youtube-dl' suite rather than a child: that suite's
// beforeEach runs a real checkForYoutubeDLUpdate, which downloads a binary and burns
// GitHub's unauthenticated rate limit. These are pure URL/channel resolution checks and
// must not touch the network.
describe('yt-dlp update channel', function() {
    let original_channel = null;

    beforeEach(function() {
        original_channel = config_api.getConfigItem('ytdl_ytdlp_update_channel');
    });

    afterEach(function() {
        config_api.setConfigItem('ytdl_ytdlp_update_channel', original_channel);
    });

    it('Defaults to stable when unset or blank', function() {
        for (const blank_value of ['', '   ', null, undefined]) {
            config_api.setConfigItem('ytdl_ytdlp_update_channel', blank_value);
            assert.strictEqual(youtubedl_api.getYtDlpUpdateChannel(), 'stable');
            assert.strictEqual(
                youtubedl_api.getYoutubeDLSourceUrls('yt-dlp')['download_url'],
                'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
            );
        }
    });

    it('Points both URLs at the matching repo for each channel', function() {
        for (const [channel, repo] of Object.entries(youtubedl_api.YTDLP_UPDATE_CHANNELS)) {
            config_api.setConfigItem('ytdl_ytdlp_update_channel', channel);
            const urls = youtubedl_api.getYoutubeDLSourceUrls('yt-dlp');
            assert.strictEqual(urls['download_url'], `https://github.com/${repo}/releases/latest/download/yt-dlp`);
            assert.strictEqual(urls['releases_url'], `https://api.github.com/repos/${repo}/releases/latest`);
        }
    });

    it('Resolves the version and the binary from the same release', function() {
        // A tag exists before the release that publishes its binary. Reading versions from
        // /tags while downloading from /releases/latest records a version the binary does
        // not have, and the next check sees recorded == latest and never corrects it.
        for (const channel of Object.keys(youtubedl_api.YTDLP_UPDATE_CHANNELS)) {
            config_api.setConfigItem('ytdl_ytdlp_update_channel', channel);
            const urls = youtubedl_api.getYoutubeDLSourceUrls('yt-dlp');
            assert(urls['releases_url'].endsWith('/releases/latest'), `${channel} version source must be a release`);
            assert(!urls['releases_url'].includes('/tags'), `${channel} version source must not be the tags API`);
        }
    });

    it('Normalizes case and surrounding whitespace', function() {
        for (const channel_value of ['NIGHTLY', '  nightly  ', 'Nightly']) {
            config_api.setConfigItem('ytdl_ytdlp_update_channel', channel_value);
            assert.strictEqual(youtubedl_api.getYtDlpUpdateChannel(), 'nightly');
        }
    });

    it('Rejects an unrecognized channel instead of downgrading to stable', function() {
        config_api.setConfigItem('ytdl_ytdlp_update_channel', 'nightlyy');
        assert.strictEqual(youtubedl_api.getYtDlpUpdateChannel(), null);
        assert.throws(() => youtubedl_api.getYoutubeDLSourceUrls('yt-dlp'), /Unknown yt-dlp update channel/);
    });

    it('Skips the update entirely when the channel is unrecognized', async function() {
        config_api.setConfigItem('ytdl_ytdlp_update_channel', 'nightlyy');

        let update_called = false;
        const original_update = youtubedl_api.updateYoutubeDL;
        const original_get_latest = youtubedl_api.getLatestUpdateVersion;
        try {
            youtubedl_api.updateYoutubeDL = async () => { update_called = true; };
            youtubedl_api.getLatestUpdateVersion = async () => { throw new Error('must not reach the network'); };
            await youtubedl_api.checkForYoutubeDLUpdate('yt-dlp');
            assert(!update_called, 'a misspelled channel must leave the existing binary alone');
        } finally {
            youtubedl_api.updateYoutubeDL = original_update;
            youtubedl_api.getLatestUpdateVersion = original_get_latest;
        }
    });

    it('Leaves non yt-dlp forks on their own upstreams', function() {
        config_api.setConfigItem('ytdl_ytdlp_update_channel', 'nightly');
        for (const fork of ['youtube-dl', 'youtube-dlc']) {
            const urls = youtubedl_api.getYoutubeDLSourceUrls(fork);
            assert.strictEqual(urls['download_url'], youtubedl_api.youtubedl_forks[fork]['download_url']);
            assert.strictEqual(urls['releases_url'], youtubedl_api.youtubedl_forks[fork]['releases_url']);
        }
    });

    it('Throws for an unsupported fork', function() {
        assert.throws(() => youtubedl_api.getYoutubeDLSourceUrls('not-a-fork'), /Unsupported downloader fork/);
    });
});
