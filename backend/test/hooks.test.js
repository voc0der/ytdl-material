const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hooks_api = require('../hooks');
const healthz = require('../healthz');
const logger = require('../logger');

function writeHook(dir, name, body, mode = 0o755) {
    fs.mkdirSync(dir, { recursive: true });
    const hook_path = path.join(dir, name);
    fs.writeFileSync(hook_path, `#!/bin/sh\n${body}\n`, { mode });
    return hook_path;
}

// Every line the backend logged while `fn` ran, as "level message".
async function captureLogs(fn) {
    const lines = [];
    const levels = ['error', 'warn', 'info', 'verbose', 'debug'];
    const originals = Object.fromEntries(levels.map(level => [level, logger[level]]));
    for (const level of levels) logger[level] = message => { lines.push(`${level} ${message}`); };
    try {
        await fn();
    } finally {
        Object.assign(logger, originals);
    }
    return lines;
}

describe('Hooks', function() {
    let hooks_dir;
    let original_dir;
    let output;

    beforeEach(function() {
        original_dir = hooks_api.getHooksDir();
        hooks_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-hooks-'));
        output = path.join(hooks_dir, 'output');
        hooks_api.setHooksDir(hooks_dir);
    });

    afterEach(function() {
        hooks_api.setHooksDir(original_dir);
        fs.rmSync(hooks_dir, { recursive: true, force: true });
    });

    const outputLines = () => (fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n') : []);

    it('does nothing when there is no hooks directory', async function() {
        hooks_api.setHooksDir(path.join(hooks_dir, 'missing'));
        assert.strictEqual(await hooks_api.runStage('started.d'), 0);
    });

    it('runs a stage\'s scripts one at a time, in name order', async function() {
        const stage = path.join(hooks_dir, 'started.d');
        // Code point order: 10 before 9, as `ls` sorts in the C locale.
        writeHook(stage, '9-last', `sleep 0.1; echo 9 >> "${output}"`);
        writeHook(stage, '10-first', `sleep 0.2; echo 10 >> "${output}"`);
        writeHook(stage, 'b-middle', `echo b >> "${output}"`);

        assert.strictEqual(await hooks_api.runStage('started.d'), 3);
        assert.deepStrictEqual(outputLines(), ['10', '9', 'b']);
    });

    it('skips a script that is not executable, and says so', async function() {
        const stage = path.join(hooks_dir, 'started.d');
        writeHook(stage, 'runs', `echo ran >> "${output}"`);
        writeHook(stage, 'forgot-chmod', `echo should-not-run >> "${output}"`, 0o644);
        writeHook(stage, '.hidden', `echo hidden >> "${output}"`);
        fs.mkdirSync(path.join(stage, 'a-directory'));

        const logs = await captureLogs(() => hooks_api.runStage('started.d'));
        assert.deepStrictEqual(outputLines(), ['ran']);
        assert(logs.some(line => line.startsWith('warn') && line.includes('started.d/forgot-chmod') && line.includes('not executable')), logs.join('\n'));
    });

    it('logs what a script prints, and keeps going after one fails', async function() {
        const stage = path.join(hooks_dir, 'started.d');
        writeHook(stage, '1-fails', 'echo about to fail; echo on stderr >&2; exit 3');
        writeHook(stage, '2-still-runs', `echo ran >> "${output}"`);

        const logs = await captureLogs(() => hooks_api.runStage('started.d'));
        assert.deepStrictEqual(outputLines(), ['ran']);
        assert(logs.includes('info [hook started.d/1-fails] about to fail'), logs.join('\n'));
        assert(logs.includes('warn [hook started.d/1-fails] on stderr'), logs.join('\n'));
        assert(logs.some(line => line.startsWith('error') && line.includes('started.d/1-fails') && line.includes('code 3')), logs.join('\n'));
    });

    it('runs a script with no #! line with sh, as the entrypoint does', async function() {
        const stage = path.join(hooks_dir, 'started.d');
        fs.mkdirSync(stage, { recursive: true });
        fs.writeFileSync(path.join(stage, 'no-shebang'), `echo ran >> "${output}"\n`, { mode: 0o755 });

        await hooks_api.runStage('started.d');
        assert.deepStrictEqual(outputLines(), ['ran']);
    });

    it('tells a started hook the port and URL', async function() {
        writeHook(path.join(hooks_dir, 'started.d'), 'env', `echo "$YTDL_EVENT $YTDL_PORT $YTDL_URL" >> "${output}"`);
        await hooks_api.runStartedHooks(17442, 'http://example.test:17442');
        assert.deepStrictEqual(outputLines(), ['started 17442 http://example.test:17442']);
    });

    it('tells a download hook about the file, and runs them one download at a time', async function() {
        writeHook(path.join(hooks_dir, 'download-finished.d'), 'env', [
            'sleep 0.1',
            `printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\\n' "$YTDL_EVENT" "$YTDL_FILE_PATH" "$YTDL_FILE_UID" "$YTDL_FILE_TITLE" "$YTDL_FILE_URL" "$YTDL_FILE_TYPE" "$YTDL_USER_UID" "$YTDL_SUBSCRIPTION_ID" "$YTDL_DOWNLOAD_UID" >> "${output}"`
        ].join('\n'));

        hooks_api.queueDownloadFinishedHooks(
            {path: 'video/first.mp4', uid: 'f1', title: 'A "quoted" $title; rm -rf /', url: 'https://example.test/1', isAudio: false, user_uid: 'u1'},
            {uid: 'd1', sub_id: 's1'}
        );
        await hooks_api.queueDownloadFinishedHooks(
            {path: 'audio/second.mp3', uid: 'f2', title: 'Second', url: 'https://example.test/2', isAudio: true},
            {uid: 'd2'}
        );

        assert.deepStrictEqual(outputLines(), [
            // A title is data to the script, never shell.
            `download-finished|${path.resolve('video/first.mp4')}|f1|A "quoted" $title; rm -rf /|https://example.test/1|video|u1|s1|d1`,
            `download-finished|${path.resolve('audio/second.mp3')}|f2|Second|https://example.test/2|audio|||d2`
        ]);
    });

    it('does no work for a finished download when there are no download hooks', async function() {
        const logs = await captureLogs(() => hooks_api.queueDownloadFinishedHooks({path: 'video/x.mp4', uid: 'x'}, {}));
        assert.deepStrictEqual(logs, []);
    });
});

describe('/healthz', function() {
    it('answers ok, uncached', function() {
        const headers = {};
        let sent = null;
        let type = null;
        const res = {
            set: (name, value) => { headers[name] = value; return res; },
            type: value => { type = value; return res; },
            send: body => { sent = body; return res; }
        };
        healthz.handler({}, res);
        assert.strictEqual(sent, 'ok');
        assert.strictEqual(type, 'text/plain');
        assert.strictEqual(headers['Cache-Control'], 'no-store');
    });

    it('is registered ahead of every middleware, so nothing else runs for it', function() {
        const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
        const route = source.indexOf("app.get('/healthz', healthz.handler)");
        assert.notStrictEqual(route, -1, 'app.js no longer registers /healthz');
        const first_middleware = source.search(/^app\.(use|all|get|post)\(/m);
        assert.strictEqual(first_middleware, route, 'something is registered on app before /healthz');
    });
});
