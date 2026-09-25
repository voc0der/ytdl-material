const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const logger = require('./logger');

/*************************************************
 * Scripts an administrator puts in hooks/, run at
 * fixed points:
 *
 *   hooks/init.d/               entrypoint.sh, before
 *                               the privilege drop
 *   hooks/started.d/            once the server listens
 *   hooks/download-finished.d/  once per new file
 *
 * Nothing in the UI or the API can add, change or
 * point at one. Whoever can write this directory
 * can already run code in the container, so running
 * what is there gives nobody anything new.
 *
 * In the image hooks/ is /app/hooks, beside
 * appdata/, and meant to be mounted read-only.
 ************************************************/

let hooks_dir = path.join(__dirname, 'hooks');

exports.STAGES = ['init.d', 'started.d', 'download-finished.d'];

exports.getHooksDir = () => hooks_dir;

// For the tests, which point it at a directory of their own.
exports.setHooksDir = dir => { hooks_dir = dir; };

// The scripts in one stage, in name order. A file that cannot be run is skipped with a
// warning rather than silently, since a missing chmod +x is the usual reason a hook "does
// nothing".
exports.listHooks = (stage) => {
    const stage_dir = path.join(hooks_dir, stage);
    let names;
    try {
        names = fs.readdirSync(stage_dir);
    } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
            logger.warn(`Could not read the hooks in ${stage_dir}: ${err.message}`);
        }
        return [];
    }

    const hooks = [];
    // Plain code point order, so 10-x runs before 9-x the same way `ls` sorts in the C locale
    // and the entrypoint sorts init.d.
    for (const name of names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (name.startsWith('.')) continue;
        const hook_path = path.join(stage_dir, name);
        let stats;
        try {
            stats = fs.statSync(hook_path);
        } catch {
            continue;
        }
        if (!stats.isFile()) continue;
        try {
            fs.accessSync(hook_path, fs.constants.X_OK);
        } catch {
            logger.warn(`Skipping hook ${stage}/${name}: it is not executable (chmod +x it).`);
            continue;
        }
        hooks.push(hook_path);
    }
    return hooks;
};

function logLines(prefix, chunk, level, carry) {
    const text = carry.value + chunk.toString();
    const lines = text.split(/\r?\n/);
    carry.value = lines.pop();
    for (const line of lines) {
        if (line) logger[level](`${prefix} ${line}`);
    }
}

// Runs one hook to completion. Resolves with its exit code, or null if it could not start.
// It never rejects: one broken hook is reported and the next still runs.
exports.runHook = (stage, hook_path, env) => new Promise(resolve => {
    const prefix = `[hook ${stage}/${path.basename(hook_path)}]`;
    let child;
    try {
        child = spawn(hook_path, [], {
            cwd: process.cwd(),
            env: {...process.env, ...env},
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (err) {
        logger.error(`${prefix} could not start: ${err.message}`);
        resolve(null);
        return;
    }

    const out = {value: ''};
    const err_out = {value: ''};
    child.stdout.on('data', chunk => logLines(prefix, chunk, 'info', out));
    child.stderr.on('data', chunk => logLines(prefix, chunk, 'warn', err_out));
    child.on('error', err => {
        logger.error(`${prefix} could not start: ${err.message}`);
        resolve(null);
    });
    child.on('close', code => {
        if (out.value) logger.info(`${prefix} ${out.value}`);
        if (err_out.value) logger.warn(`${prefix} ${err_out.value}`);
        if (code !== 0 && code !== null) logger.error(`${prefix} exited with code ${code}.`);
        resolve(code);
    });
});

// Runs every hook in a stage, one after another.
exports.runStage = async (stage, env = {}) => {
    const hooks = exports.listHooks(stage);
    for (const hook_path of hooks) {
        await exports.runHook(stage, hook_path, {YTDL_EVENT: stage.replace(/\.d$/, ''), ...env});
    }
    return hooks.length;
};

exports.runStartedHooks = (port, url) => exports.runStage('started.d', {
    YTDL_PORT: port === undefined || port === null ? '' : String(port),
    YTDL_URL: url || ''
});

// Download hooks run one at a time across every download, in the order files finish, so a
// playlist of hundreds does not start hundreds of scripts at once. A hook that never exits
// holds up the ones after it.
let download_queue = Promise.resolve();

exports.fileEnv = (file_obj, download = {}) => ({
    YTDL_FILE_PATH: file_obj.path ? path.resolve(file_obj.path) : '',
    YTDL_FILE_UID: file_obj.uid || '',
    YTDL_FILE_TITLE: file_obj.title || '',
    YTDL_FILE_URL: file_obj.url || '',
    YTDL_FILE_TYPE: file_obj.isAudio ? 'audio' : 'video',
    YTDL_USER_UID: file_obj.user_uid || download.user_uid || '',
    YTDL_SUBSCRIPTION_ID: file_obj.sub_id || download.sub_id || '',
    YTDL_DOWNLOAD_UID: download.uid || ''
});

exports.queueDownloadFinishedHooks = (file_obj, download = {}) => {
    // Checked before queueing, so a server with no hooks does no work per file.
    if (!fs.existsSync(path.join(hooks_dir, 'download-finished.d'))) return download_queue;
    const env = exports.fileEnv(file_obj, download);
    download_queue = download_queue
        .then(() => exports.runStage('download-finished.d', env))
        .catch(err => logger.error(`Download hooks failed: ${err.message}`));
    return download_queue;
};
