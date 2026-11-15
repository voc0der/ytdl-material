const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { createRequire } = require('module');

// Looking for, and fetching, a newer yt-dlp, with the network replaced and nothing written
// over the real binary.
describe('Updating yt-dlp', function() {
    let errors;
    let answer;
    let api;

    beforeEach(function() {
        errors = [];
        answer = async () => { throw new Error('no network in tests'); };
        const filename = path.resolve(__dirname, '../youtube-dl.js');
        const instance = new Module(filename, module);
        instance.filename = filename;
        instance.paths = module.paths;
        const stubs = {
            './logger': {debug() {}, warn() {}, info() {}, error: message => errors.push(message instanceof Error ? message.message : message)},
            './config.js': {
                isYtDlpImpersonationDependencyEnvEnabled: () => false,
                getConfigItem: key => ({ytdl_default_downloader: 'yt-dlp'})[key]
            }
        };
        const moduleRequire = createRequire(filename);
        instance.require = name => Object.hasOwn(stubs, name) ? stubs[name] : moduleRequire(name);
        // The module keeps the fetch it finds when it loads, so it gets one that asks the test.
        const original_fetch = global.fetch;
        global.fetch = (...args) => answer(...args);
        try {
            instance._compile(fs.readFileSync(filename, 'utf8'), filename);
        } finally {
            global.fetch = original_fetch;
        }
        api = instance.exports;
    });

    it('finds no newer version when the release lookup has no tag or fails', async function() {
        answer = async () => ({json: async () => ({message: 'API rate limit exceeded'})});
        assert.strictEqual(await api.getLatestUpdateVersion('yt-dlp'), null);

        answer = async () => { throw new Error('offline'); };
        assert.strictEqual(await api.getLatestUpdateVersion('yt-dlp'), null);

        assert.deepStrictEqual(errors, [
            'Failed to check yt-dlp version for an update.',
            'Failed to check yt-dlp version for an update.',
            'offline'
        ]);
    });

    it('keeps the binary it has when the download is refused', async function() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-update-'));
        const output_path = path.join(dir, 'yt-dlp');
        try {
            answer = async () => ({ok: false, status: 404});
            await api.updateYoutubeDL('2026.01.01', output_path, 'yt-dlp');

            assert(!fs.existsSync(output_path));
            assert.deepStrictEqual(errors, ['Failed to download new yt-dlp version: 2026.01.01', 'HTTP 404']);
        } finally {
            fs.rmSync(dir, {recursive: true, force: true});
        }
    });
});
