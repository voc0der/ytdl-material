const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Readable } = require('stream');
const { createAppHarness } = require('./helpers/app-harness');

// Never run npm, replace application files, or restart the test process.
describe('Server updates', function() {
    let harness;
    let context;
    let calls;

    beforeEach(function() {
        calls = [];
        harness = createAppHarness({ dependencies: {
            './utils': { restartServer: update => calls.push(['restart', update]), wait: async () => {} },
            child_process: { exec: (command, options, callback) => {
                calls.push(['exec', command]);
                callback(null, '', '');
            } }
        }});
        context = harness.context;
    });
    afterEach(function() { harness.close(); });

    function stubStages() {
        context.isNewVersionAvailable = async () => true;
        context.backupServerLite = async () => { calls.push(['backup']); return true; };
        context.downloadReleaseFiles = async tag => { calls.push(['download', tag]); return true; };
        context.installDependencies = async () => { calls.push(['install']); return true; };
    }

    it('backs up, installs and restarts in order, reporting completion', async function() {
        stubStages();
        assert.strictEqual(await context.updateServer('v1.2.3'), true);
        assert.deepStrictEqual(calls, [['backup'], ['download', 'v1.2.3'], ['install'], ['restart', true]]);
        assert.match(harness.read('updaterStatus.details'), /Update complete/);
    });

    it('does not back up or install when no newer release exists', async function() {
        stubStages();
        context.isNewVersionAvailable = async () => false;
        assert.strictEqual(await context.updateServer(), false);
        assert.deepStrictEqual(calls, []);
    });

    it('stops when the backup fails', async function() {
        stubStages();
        context.backupServerLite = async () => false;
        assert.strictEqual(await context.updateServer('v1.2.3'), false);
        assert.deepStrictEqual(calls, []);
    });

    for (const stage of ['backupServerLite', 'downloadReleaseFiles', 'installDependencies']) {
        it(`reports failure without restarting when ${stage} rejects`, async function() {
            stubStages();
            const error = new Error('stage failed');
            context[stage] = async () => { throw error; };
            assert.strictEqual(await context.updateServer('v1.2.3'), false);
            assert.strictEqual(harness.read('updaterStatus.error'), true);
            assert.strictEqual(harness.read('updaterStatus.updating'), false);
            assert(!calls.some(([name]) => name === 'restart'));
            assert(harness.messages.some(([level, message]) => level === 'error' && message === error));
        });
    }

    it('does not install dependencies after a refused release', async function() {
        stubStages();
        context.downloadReleaseFiles = async () => false;
        assert.strictEqual(await context.updateServer('v1.2.3'), false);
        assert.deepStrictEqual(calls, [['backup']]);
        assert.strictEqual(harness.read('updaterStatus.error'), true);
    });

    it('awaits dependency installation and propagates a command failure', async function() {
        assert.strictEqual(await context.installDependencies(), true);
        assert.deepStrictEqual(calls, [['exec', 'npm install']]);
        const failure = new Error('install failed');
        harness.read("require('child_process')").exec = (cmd, options, callback) => callback(failure);
        await assert.rejects(context.installDependencies(), error => error === failure);
    });

    it('orders stable, release candidate and numeric version components', async function() {
        for (const [newer, older] of [
            ['v2.0.0', 'v1.99.99'], ['1.10.0', 'v1.9.99'], ['v1.2.10', 'v1.2.9'],
            ['v1.2.3', 'v1.2.3-rc9'], ['v1.2.3-rc10', 'v1.2.3-rc2']
        ]) {
            assert(context.compareReleaseVersions(newer, older) > 0);
            assert(context.compareReleaseVersions(older, newer) < 0);
        }
        assert.strictEqual(context.compareReleaseVersions('v1.2.3', '1.2.3'), 0);
        assert.strictEqual(context.compareReleaseVersions(null, undefined), 0);
        assert(context.compareReleaseVersions('nightly10', 'nightly2') > 0);
        for (const invalid of [null, 42, '', '1.2', 'v1.2.3-beta1']) assert.strictEqual(context.parseReleaseVersion(invalid), null);
        context.getLatestVersion = async () => 'v999.0.0';
        assert.strictEqual(await context.isNewVersionAvailable(), true);
        context.getLatestVersion = async () => 'v0.0.1';
        assert.strictEqual(await context.isNewVersionAvailable(), false);
    });

    it('returns the latest release and logs API rejections with their documentation', async function() {
        harness.close();
        let response = { tag_name: 'v2.0.0' };
        harness = createAppHarness({ globals: { fetch: async url => {
            assert.match(url, /\/releases\/latest$/);
            return { json: async () => response };
        } }});
        assert.strictEqual(await harness.context.getLatestVersion(), 'v2.0.0');
        response = { message: 'rate limited', documentation_url: 'https://example.test/rate-limit' };
        assert.strictEqual(await harness.context.getLatestVersion(), undefined);
        assert.deepStrictEqual(harness.messages.filter(([level]) => level === 'error').map(([, message]) => message), [
            'ERROR: Received the following message from GitHub\'s API:',
            'rate limited',
            'Associated URL: https://example.test/rate-limit'
        ]);
    });

    it('refuses unsafe tags before any request or filesystem change', async function() {
        const current = path.join(harness.root, 'public', 'keep.txt');
        fs.outputFileSync(current, 'original');
        for (const tag of ['../escape', 'v1/../../escape', 'v1?token=x', '', null, 1]) {
            assert.strictEqual(context.getValidatedReleaseTag(tag), null);
            assert.strictEqual(context.getSafeReleaseZipPath(tag), null);
            assert.strictEqual(await context.downloadReleaseZip(tag), false);
            context.getLatestVersion = async () => tag;
            assert.strictEqual(await context.downloadReleaseFiles(tag), false);
        }
        assert.strictEqual(fs.readFileSync(current, 'utf8'), 'original');
        assert.strictEqual(context.getSafeReleaseZipPath('v1.2.3-rc1'), path.join(harness.root, 'ytdl-material-release-v1.2.3-rc1.zip'));
    });

    it('downloads to the release path and preserves the frontend after HTTP failure', async function() {
        harness.close();
        let status = 200;
        const requests = [];
        harness = createAppHarness({ globals: { fetch: async url => {
            requests.push(url);
            return new Response('release bytes', {status});
        } }});
        const current = path.join(harness.root, 'public', 'keep.txt');
        fs.outputFileSync(current, 'original');
        assert.strictEqual(await harness.context.downloadReleaseZip('v2.3.4'), true);
        assert.strictEqual(fs.readFileSync(harness.context.getSafeReleaseZipPath('v2.3.4'), 'utf8'), 'release bytes');
        assert.match(requests[0], /\/v2\.3\.4\/ytdl-material-2\.3\.4\.zip$/);
        status = 404;
        assert.strictEqual(await harness.context.downloadReleaseFiles('v2.3.5'), false);
        assert.strictEqual(fs.readFileSync(current, 'utf8'), 'original');
    });

    it('extracts release files but drains saved databases, directories and escaping paths', async function() {
        harness.close();
        const entries = [];
        const writes = [];
        const parser = new PassThrough({objectMode: true});
        parser.on('finish', () => {
            for (const entry of entries) parser.emit('entry', entry);
            parser.emit('close');
        });
        harness = createAppHarness({ dependencies: {
            'fs-extra': {
                existsSync: () => false,
                removeSync: file => calls.push(['remove', file]),
                mkdirSync: file => calls.push(['mkdir', file]),
                ensureDirSync: file => calls.push(['ensureDir', file]),
                createReadStream: () => Readable.from([]),
                createWriteStream: file => { writes.push(file); return new PassThrough(); }
            },
            unzipper: { Parse: () => parser }
        }});
        harness.context.downloadReleaseZip = async tag => { assert.strictEqual(tag, 'v2.0.0'); return true; };
        harness.context.getLatestVersion = async () => 'v2.0.0';
        for (const name of ['public/nested/app.js', 'package.json', 'appdata/default.json', 'appdata/db.json',
            'appdata/users.json', 'public/', 'public/../../escape', '../../escape']) {
            const entry = Readable.from(['new content']);
            entry.path = 'ytdl-material/' + name;
            entry.drained = false;
            entry.autodrain = () => { entry.drained = true; };
            entries.push(entry);
        }
        assert.strictEqual(await harness.context.downloadReleaseFiles(), true);
        assert.deepStrictEqual(writes, [path.join(harness.root, 'public/nested/app.js'), path.join(harness.root, 'package.json')]);
        assert.deepStrictEqual(entries.map(entry => entry.drained), [false, false, true, true, true, true, true, true]);
        assert.strictEqual(harness.messages.filter(([level]) => level === 'warn').length, 2);
    });

    it('rejects an archive read failure', async function() {
        const error = new Error('archive read failed');
        harness.read('fs').createReadStream = () => new Readable({ read() { this.destroy(error); } });
        context.downloadReleaseZip = async () => true;
        await assert.rejects(context.downloadReleaseFiles('v2.0.0'), failure => failure === error);
    });

    it('backs up files while excluding media, previous backups and transient conversions', async function() {
        harness.close();
        let globOptions;
        let output;
        class Archive extends EventEmitter {
            pipe(stream) { output = stream; }
            glob(pattern, options) { assert.strictEqual(pattern, '**/*'); globOptions = options; }
            async finalize() { output.end('backup'); }
        }
        harness = createAppHarness({ config: {
            ytdl_subscriptions_base_path: 'subscriptions', ytdl_audio_folder_path: 'audio', ytdl_video_folder_path: 'video'
        }, dependencies: { archiver: { ZipArchive: Archive }, './utils': { wait: async () => {} } } });
        assert.strictEqual(await harness.context.backupServerLite(), true);
        assert.deepStrictEqual(Array.from(globOptions.ignore), [
            'subscriptions/**', 'audio/**', 'video/**', 'appdata/backups/backup-*.zip', 'appdata/transcodes/**', 'appdata/codec-work/**'
        ]);
        await new Promise(resolve => output.on('close', resolve));
        const backups = fs.readdirSync(path.join(harness.root, 'appdata/backups'));
        assert.strictEqual(backups.length, 1);
        assert.strictEqual(fs.readFileSync(path.join(harness.root, 'appdata/backups', backups[0]), 'utf8'), 'backup');
    });
});
