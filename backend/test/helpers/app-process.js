const { fork } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const request = require('supertest');

const BACKEND = path.join(__dirname, '..', '..');
const SAMPLES = path.join(__dirname, '..');
const BOOT_TIMEOUT_MS = 30 * 1000;
const STOP_TIMEOUT_MS = 10 * 1000;

/*************************************************
 * Puts a copy of a sample file where the server
 * looks for media, beside the yt-dlp metadata that
 * the import task reads. `info` overrides fields in
 * that metadata. Copies of one sample keep its
 * source id, which makes them duplicates.
 ************************************************/
async function addSampleMedia(dir, {type = 'video', name = null, info = {}, thumbnail = null} = {}) {
    const sample = type === 'audio' ? 'sample_mp3' : 'sample_mp4';
    const extension = type === 'audio' ? '.mp3' : '.mp4';
    const base = path.join(dir, name || sample);

    await fs.ensureDir(dir);
    await fs.copy(path.join(SAMPLES, sample + extension), base + extension);
    const sample_info = await fs.readJSON(path.join(SAMPLES, sample + '.info.json'));
    await fs.writeJSON(base + '.info.json', {...sample_info, ...info});
    if (thumbnail) await fs.writeFile(base + '.jpg', thumbnail);
    return base + extension;
}

/*************************************************
 * Boots the real app.js, for tests that need the
 * server as it actually runs: every middleware,
 * every route, and the dependencies behind them.
 *
 * Most of the suite rebuilds a route on a small
 * express app, or reads app.js as text, because
 * requiring app.js starts the whole server. That
 * leaves nothing checking that the real routes
 * still work with whatever express, multer,
 * archiver or express-rate-limit Renovate merged
 * last, which is how container downloads failed
 * after the archiver 8 bump.
 *
 * It runs in a child process so the server's
 * module-level state stays out of the rest of the
 * suite. The child's working directory is a
 * throwaway one, and app.js resolves its databases,
 * logs and default media folders against it, so
 * nothing it writes outlives the test. c8 follows
 * the child through NODE_V8_COVERAGE, so app.js is
 * counted like any module a test requires.
 *
 * What that cannot run: playlist and subscription
 * zips are written relative to the working
 * directory and sent from app.js's own, so they
 * only meet when the two are the same, as they are
 * in the container. api-hardening.test.js builds
 * them directly.
 *
 * `env` takes config keys as environment
 * variables, which is how the container sets them.
 * `prepare` runs before boot with the directories,
 * for anything that has to exist at startup.
 ************************************************/
async function startApp({env = {}, prepare = null} = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ytdl-app-test-'));
    const media = {
        video: path.join(root, 'video'),
        audio: path.join(root, 'audio'),
        users: path.join(root, 'users'),
        subscriptions: path.join(root, 'subscriptions')
    };
    for (const dir of Object.values(media)) await fs.ensureDir(dir);

    const config_path = path.join(root, 'appdata', 'default.json');
    await fs.copy(path.join(BACKEND, 'appdata', 'default.json'), config_path);

    if (prepare) await prepare({root, media});

    let output = '';
    const child = fork(path.join(__dirname, 'boot-app.js'), [], {
        cwd: root,
        env: {
            ...process.env,
            YTDL_CONFIG_PATH: config_path,
            ytdl_port: '0',
            // Absolute, so the paths stored in records do not depend on which directory
            // they are later resolved against.
            ytdl_video_folder_path: media.video + path.sep,
            ytdl_audio_folder_path: media.audio + path.sep,
            ytdl_users_base_path: media.users + path.sep,
            ytdl_subscriptions_base_path: media.subscriptions + path.sep,
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));

    let port;
    try {
        port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`app.js did not start within ${BOOT_TIMEOUT_MS / 1000}s`)), BOOT_TIMEOUT_MS);
            child.once('message', message => {
                clearTimeout(timer);
                resolve(message.port);
            });
            exited.then(({code, signal}) => {
                clearTimeout(timer);
                reject(new Error(`app.js exited during startup (code ${code}, signal ${signal})`));
            });
        });
    } catch (err) {
        child.kill('SIGKILL');
        await fs.remove(root);
        err.message += `\n--- server output ---\n${output}`;
        throw err;
    }

    const url = `http://127.0.0.1:${port}`;
    return {
        root,
        media,
        url,
        config_path,
        api: request(url),
        exited,
        // Everything the server has logged so far.
        output: () => output,
        async stop() {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
            await exited;
            clearTimeout(timer);
            await fs.remove(root);
        }
    };
}

module.exports = { startApp, addSampleMedia, BACKEND };
