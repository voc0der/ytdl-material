const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawn } = require('child_process');

// yt-dlp's output read a line at a time, with a short Node script standing in for yt-dlp
// so nothing is downloaded and the developer's configuration is left alone.
describe('Streaming yt-dlp output', function() {
    this.timeout(15000);
    let warnings;
    let binary_exists;
    let script;

    function load() {
        const filename = path.resolve(__dirname, '../youtube-dl.js');
        const instance = new Module(filename, module);
        instance.filename = filename;
        instance.paths = module.paths;
        const stubs = {
            'fs-extra': {...require('fs-extra'), existsSync: () => binary_exists},
            'child_process': {spawn: (_command, _args, options) => spawn(process.execPath, ['-e', script], options)},
            './logger': {debug() {}, warn: message => warnings.push(message), error() {}},
            './utils': {redactCommandArgsForLogging: args => args, parseOutputJSON: () => []},
            './consts': {},
            './config.js': {
                isYtDlpImpersonationDependencyEnvEnabled: () => false,
                getConfigItem: key => ({ytdl_default_downloader: 'yt-dlp'})[key]
            }
        };
        instance.require = name => Object.hasOwn(stubs, name) ? stubs[name] : require(name);
        instance._compile(fs.readFileSync(filename, 'utf8'), filename);
        return instance.exports;
    }

    beforeEach(function() {
        warnings = [];
        binary_exists = true;
    });

    it('hands every line to its handler, however it ends, and keeps going when a handler throws', async function() {
        script = "process.stdout.write('one\\r\\ntwo\\rthree\\nfour'); process.stderr.write('careful\\n')";
        const api = load();
        const stdout_lines = [];
        const stderr_lines = [];

        const run = await api.runYoutubeDLLineStream('test', [], {
            onStdoutLine: line => {
                if (line === 'two') throw new Error('handler failed');
                stdout_lines.push(line);
            },
            onStderrLine: line => stderr_lines.push(line)
        });
        const {err} = await run.callback;

        assert.strictEqual(err, null);
        assert.deepStrictEqual(stdout_lines, ['one', 'three', 'four']);
        assert.deepStrictEqual(stderr_lines, ['careful']);
        assert.deepStrictEqual(warnings, ['A yt-dlp line handler failed while processing streamed output.']);
    });

    it('keeps the end of a long output for the error it reports', async function() {
        script = "process.stderr.write('x'.repeat(25000) + 'the real reason'); process.exit(3)";
        const api = load();

        const run = await api.runYoutubeDLLineStream('test', [], {onLine: () => {}});
        const {err} = await run.callback;

        assert.strictEqual(err.code, 3);
        assert.strictEqual(err.stderr.length, 20000);
        assert(err.stderr.endsWith('the real reason'));
    });

    it('fetches yt-dlp before running it when it is not there yet', async function() {
        script = '';
        binary_exists = false;
        const api = load();
        const fetched = [];
        api.checkForYoutubeDLUpdate = async fork => { fetched.push(fork); };

        const run = await api.runYoutubeDLLineStream('test', [], {});
        await run.callback;

        assert.deepStrictEqual(fetched, ['yt-dlp']);
    });
});
