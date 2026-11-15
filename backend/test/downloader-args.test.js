const { assert, fs, path, useTemporaryMediaRoots } = require('./test-shared');
const logger = require('../logger');
const downloader_api = require('../downloader');

// The arguments a download is started with, for the settings that add to them.
describe('Download arguments', function() {
    const url = 'https://example.test/clip';
    const cookies_path = path.join(__dirname, '..', 'appdata', 'cookies.txt');
    let media;
    let warnings;
    let original_warn;
    let cookies_existed;

    const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

    beforeEach(function() {
        warnings = [];
        original_warn = logger.warn;
        logger.warn = message => warnings.push(message);
        cookies_existed = fs.existsSync(cookies_path);
    });

    afterEach(function() {
        logger.warn = original_warn;
        if (media) media.restore();
        media = null;
        if (!cookies_existed) fs.removeSync(cookies_path);
    });

    function settings(overrides = {}) {
        media = useTemporaryMediaRoots({
            ytdl_default_downloader: 'yt-dlp',
            ytdl_custom_args: '',
            ytdl_use_cookies: false,
            ytdl_use_default_downloading_agent: true,
            ytdl_custom_downloading_agent: '',
            ytdl_include_thumbnail: false,
            ytdl_download_rate_limit: '',
            ytdl_replace_invalid_filename_chars: false,
            ytdl_use_sponsorblock_api: false,
            ytdl_use_ytdlp_impersonation: false,
            ...overrides
        });
    }

    it('signs in with the account given for the download', async function() {
        settings();
        const args = await downloader_api.generateArgs(url, 'video', { youtubeUsername: 'name', youtubePassword: 'secret' }, null, true);
        assert.strictEqual(valueAfter(args, '--username'), 'name');
        assert.strictEqual(valueAfter(args, '--password'), 'secret');

        // A name alone is not an account.
        const without_password = await downloader_api.generateArgs(url, 'video', { youtubeUsername: 'name' }, null, true);
        assert(!without_password.includes('--username'));
    });

    it('sends the uploaded cookies, and says so when there are none to send', async function() {
        settings({ ytdl_use_cookies: true });
        if (!cookies_existed) {
            fs.removeSync(cookies_path);
            const args = await downloader_api.generateArgs(url, 'video', {}, null, true);
            assert(!args.includes('--cookies'));
            assert(warnings.some(warning => warning.startsWith('Cookies file could not be found.')));
            fs.outputFileSync(cookies_path, '# Netscape HTTP Cookie File\n');
        }

        const args = await downloader_api.generateArgs(url, 'video', {}, null, true);
        assert.strictEqual(valueAfter(args, '--cookies'), path.join('appdata', 'cookies.txt'));
    });

    it('hands the transfer to the configured download agent', async function() {
        settings({ ytdl_use_default_downloading_agent: false, ytdl_custom_downloading_agent: 'aria2c' });
        const args = await downloader_api.generateArgs(url, 'video', {}, null, true);
        assert.deepStrictEqual(args.slice(0, 2), ['--external-downloader', 'aria2c']);
    });

    it('lets the global arguments name the output instead, and keeps one rate limit', async function() {
        settings({ ytdl_custom_args: '-o,,%(id)s.%(ext)s,,--no-mtime', ytdl_download_rate_limit: '2M' });
        const args = await downloader_api.generateArgs(url, 'video', {}, null, true);
        assert.deepStrictEqual(args.filter(arg => arg === '-o'), ['-o']);
        assert.strictEqual(valueAfter(args, '-o'), '%(id)s.%(ext)s');
        assert(args.includes('--no-mtime'));
        assert.strictEqual(valueAfter(args, '-r'), '2M');

        media.restore();
        settings({ ytdl_custom_args: '--limit-rate,,500K', ytdl_download_rate_limit: '2M' });
        const limited = await downloader_api.generateArgs(url, 'video', {}, null, true);
        assert(!limited.includes('-r'));
    });

    it('downloads into the account\'s own folder', async function() {
        settings();
        const args = await downloader_api.generateArgs(url, 'audio', {}, 'alice', true);
        assert(valueAfter(args, '-o').startsWith(path.join(media.users, 'alice', media.audio)));
    });

    it('falls back to safe Windows names under youtube-dl, and recommends yt-dlp once asked to download', async function() {
        settings({ ytdl_default_downloader: 'youtube-dl', ytdl_replace_invalid_filename_chars: true });
        const args = await downloader_api.generateArgs(url, 'video', {}, null, false);
        assert(args.includes('--windows-filenames'));
        assert(!args.includes('--replace-in-metadata'));
        assert(warnings.some(warning => warning.startsWith('It is recommended you use yt-dlp!')));

        // Arguments that already decide the names are left to do so.
        const kept = downloader_api.appendFilenameSanitizationArgs(['--restrict-filenames'], 'yt-dlp');
        assert.deepStrictEqual(kept, ['--restrict-filenames']);
    });
});
