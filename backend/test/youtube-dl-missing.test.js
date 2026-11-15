const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// yt-dlp is fetched on first use, so it can be missing: offline at the first start, or when
// the fetch failed.
describe('Running yt-dlp when it is missing', function() {
    it('fails the run with the reason, rather than with what the reason left undefined', async function() {
        const errors = [];
        const filename = path.resolve(__dirname, '../youtube-dl.js');
        const instance = new Module(filename, module);
        instance.filename = filename;
        instance.paths = module.paths;
        const stubs = {
            'fs-extra': {...require('fs-extra'), existsSync: () => false},
            'child_process': {spawn: () => { throw new Error('nothing should be started'); }},
            execa: {execa: () => { throw new Error('nothing should be started'); }},
            './logger': {debug() {}, warn() {}, error: message => errors.push(message)},
            './utils': {redactCommandArgsForLogging: args => args, parseOutputJSON: () => []},
            './consts': {},
            './config.js': {
                isYtDlpImpersonationDependencyEnvEnabled: () => false,
                getConfigItem: key => ({ytdl_default_downloader: 'yt-dlp'})[key]
            }
        };
        instance.require = name => Object.hasOwn(stubs, name) ? stubs[name] : require(name);
        instance._compile(fs.readFileSync(filename, 'utf8'), filename);
        const api = instance.exports;
        api.checkForYoutubeDLUpdate = async () => null;

        const {child_process, callback} = await api.runYoutubeDL('https://example.test/clip', []);
        const {parsed_output, err} = await callback;

        assert.strictEqual(child_process, null);
        assert.strictEqual(parsed_output, null);
        assert.match(err.message, /^Could not find path for yt-dlp at /);
        assert.deepStrictEqual(errors, [err.message]);
    });
});
