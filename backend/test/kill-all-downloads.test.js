const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawn } = require('child_process');
const { execa } = require('execa');

describe('killAllDownloads', function() {
    this.timeout(15000);
    let api;
    let children;
    let launch;
    let impersonation;

    beforeEach(function() {
        children = [];
        impersonation = false;
        // Exercise both real launch paths with harmless Node children, without downloading
        // a binary or touching the developer's configuration. The OS command is not yt-dlp.
        launch = (runner, options) => {
            const child = runner(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
            children.push(child.nodeChildProcess || child);
            return child;
        };
        const filename = path.resolve(__dirname, '../youtube-dl.js');
        const instance = new Module(filename, module);
        instance.filename = filename;
        instance.paths = module.paths;
        const stubs = {
            'fs-extra': {...require('fs-extra'), existsSync: () => true},
            'child_process': {spawn: (_command, _args, options) => launch(spawn, options)},
            execa: {execa: (_command, _args, options) => launch(execa, options)},
            './logger': {debug() {}, warn() {}, error() {}},
            './utils': {redactCommandArgsForLogging: args => args, parseOutputJSON: () => []},
            './consts': {},
            './config.js': {
                isYtDlpImpersonationDependencyEnvEnabled: () => impersonation,
                getConfigItem: key => ({ytdl_default_downloader: 'yt-dlp', ytdl_use_ytdlp_impersonation: impersonation})[key]
            }
        };
        instance.require = name => Object.hasOwn(stubs, name) ? stubs[name] : require(name);
        instance._compile(fs.readFileSync(filename, 'utf8'), filename);
        api = instance.exports;
    });

    afterEach(async function() {
        await Promise.all(children.map(child => new Promise(resolve => {
            if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
            child.once('close', resolve);
            child.kill('SIGKILL');
        })));
    });

    for (const fork of ['yt-dlp', 'youtube-dl', 'youtube-dlc', 'python']) {
        it(`waits for buffered and streaming ${fork} children and leaves unrelated processes alone`, async function() {
            impersonation = fork === 'python';
            const selectedFork = impersonation ? 'yt-dlp' : fork;
            const buffered = await api.runYoutubeDL('test', [], null, selectedFork);
            const streaming = await api.runYoutubeDLLineStream('test', [], {}, selectedFork);
            const unrelated = launch(spawn, {stdio: 'ignore'});

            assert.deepStrictEqual(await api.killAllDownloads(), {success: true});
            for (const child of [buffered.child_process, streaming.child_process]) {
                assert(child.exitCode !== null || child.signalCode !== null, 'child must be reaped before returning');
            }
            assert.strictEqual(unrelated.exitCode, null);
            assert.strictEqual(unrelated.signalCode, null);
            await Promise.all([buffered.callback, streaming.callback]);

            api.killYoutubeDLProcess = () => { throw new Error('closed child was retained'); };
            assert.deepStrictEqual(await api.killAllDownloads(), {success: true});
        });
    }

    it('drops children that exit normally or fail to spawn', async function() {
        for (const missing of [false, true]) {
            launch = (runner, options) => runner(missing ? path.join(__dirname, 'missing-downloader') : process.execPath,
                ['-e', ''], options);
            const buffered = await api.runYoutubeDL('test', []);
            const streaming = await api.runYoutubeDLLineStream('test', []);
            await Promise.all([buffered.callback, streaming.callback]);
            await new Promise(resolve => setImmediate(resolve));
        }
        api.killYoutubeDLProcess = () => { throw new Error('finished child was retained'); };
        assert.deepStrictEqual(await api.killAllDownloads(), {success: true});
    });

    it('reports failure and still attempts every child when one kill fails', async function() {
        const buffered = await api.runYoutubeDL('test', []);
        const streaming = await api.runYoutubeDLLineStream('test', []);
        let calls = 0;
        api.killYoutubeDLProcess = async () => {
            calls++;
            if (calls === 1) throw new Error('kill failed');
            return false;
        };
        assert.deepStrictEqual(await api.killAllDownloads(), {success: false});
        assert.strictEqual(calls, 2);
        buffered.child_process.kill();
        streaming.child_process.kill();
        await Promise.all([buffered.callback, streaming.callback]);
    });
});
