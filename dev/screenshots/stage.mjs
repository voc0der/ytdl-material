// Stages the real app for a browser harness: builds the frontend from the working tree and
// runs the backend from a throwaway copy of itself, so its working directory -- which is
// where it keeps appdata/ and the media folders -- is disposable, and the copy is what lets
// it serve a build that did not overwrite backend/public.
//
// Shared by capture.mjs (the README screenshot) and subscriptions.mjs.

import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, open, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

export const CACHE = process.env.YTDL_SCREENSHOT_CACHE
    ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ytdl-material', 'screenshots');
export const BUILD_DIR = join(CACHE, 'frontend');

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const say = message => console.log(`\x1b[0;36m==>\x1b[0m ${message}`);

export async function buildFrontend() {
    say('Building the frontend (production)...');
    const log = join(CACHE, 'build.log');
    await mkdir(CACHE, { recursive: true });
    const output = await open(log, 'w');
    try {
        // npx rather than `npm run build`: the prebuild hook regenerates the i18n JSON in
        // src/assets, which the harnesses do not need and which would dirty the tree.
        const child = spawn('npx', ['ng', 'build', '--configuration', 'production', `--output-path=${BUILD_DIR}`], {
            cwd: REPO_ROOT,
            stdio: ['ignore', output.fd, output.fd]
        });
        const code = await new Promise(resolve => child.on('close', resolve));
        if (code !== 0) {
            const tail = (await readFile(log, 'utf8')).split('\n').slice(-30).join('\n');
            throw new Error(`frontend build failed (full log: ${log})\n${tail}`);
        }
    } finally {
        await output.close();
    }
}

export function hasFrontendBuild() {
    return existsSync(join(BUILD_DIR, 'browser', 'index.html'));
}

// Tracked and untracked-but-not-ignored files, so an uncommitted backend change shows up
// the same way it would in `npm run debug`. That includes the shipped appdata/default.json
// and nothing else from appdata/, which is ignored: the backend cannot boot without that
// file, because modules read config as they are required, before anything has had the
// chance to create it.
export async function copyBackend(runDir) {
    const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'backend'], {
        cwd: REPO_ROOT,
        maxBuffer: 16 * 1024 * 1024
    });
    const files = stdout.split('\0')
        .filter(Boolean)
        .filter(file => !file.startsWith('backend/test/'))
        .filter(file => existsSync(join(REPO_ROOT, file)));

    for (const file of files) {
        await cp(join(REPO_ROOT, file), join(runDir, relative('backend', file)));
    }

    await cp(join(REPO_ROOT, 'Public API v1.yaml'), join(runDir, 'Public API v1.yaml'));
    await symlink(join(REPO_ROOT, 'backend', 'node_modules'), join(runDir, 'node_modules'), 'dir');
    await symlink(join(BUILD_DIR, 'browser'), join(runDir, 'public'), 'dir');
}

// Without these the first boot runs the pre-4.3 migrations, and the second of them
// rebuilds the local database from db.json -- emptying any table seeded before the boot.
export async function writeMigrationFlags(runDir) {
    await mkdir(join(runDir, 'appdata'), { recursive: true });
    await writeFile(join(runDir, 'appdata', 'db.json'), JSON.stringify({
        simplified_db_migration_complete: true,
        new_db_system_migration_complete: true,
        tasks_manager_role_migration_complete: true,
        archives_migration_complete: true
    }, null, 2));
}

export async function isListening(base) {
    try {
        await fetch(`${base}/api/config`);
        return true;
    } catch {
        return false;
    }
}

export async function startBackend(runDir, port, settings = {}) {
    const base = `http://localhost:${port}`;
    // Settings from the caller's shell would otherwise leak into the run.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ytdl_/i.test(key)));
    Object.assign(env, {
        ytdl_port: String(port),
        ytdl_url: base,
        ytdl_multi_user_mode: 'false',
        ytdl_use_local_db: 'true',
        ytdl_default_theme: 'dark'
    }, settings);

    const logPath = join(runDir, 'backend.log');
    const log = await open(logPath, 'w');
    // Detached into its own process group, writing to a file rather than a pipe, so that
    // --keep can leave it running after the harness exits.
    const child = spawn(process.execPath, ['app.js'], {
        cwd: runDir,
        env,
        detached: true,
        stdio: ['ignore', log.fd, log.fd]
    });
    await log.close();
    await writeFile(join(runDir, 'backend.pid'), String(child.pid));

    let exited = null;
    child.on('exit', code => { exited = code; });

    // Startup waits on the downloader update check, which fetches a release over the
    // network before the server starts listening.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        if (exited !== null) {
            const tail = (await readFile(logPath, 'utf8')).split('\n').slice(-30).join('\n');
            throw new Error(`backend exited with code ${exited} (full log: ${logPath})\n${tail}`);
        }
        try {
            const response = await fetch(`${base}/api/config`);
            if (response.ok && (response.headers.get('content-type') ?? '').includes('json')) {
                return child;
            }
        } catch {
            // not listening yet
        }
        await sleep(500);
    }

    await stopBackend(child);
    throw new Error(`backend did not answer on ${base} within 180s (log: ${logPath})`);
}

// Waits for the exit, so the port is free again by the time the harness returns.
export async function stopBackend(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
        process.kill(-child.pid, 'SIGTERM');
    } catch {
        return; // already gone
    }
    const stopped = await Promise.race([
        exited.then(() => true),
        new Promise(resolve => setTimeout(resolve, 10_000, false).unref())
    ]);
    if (!stopped) {
        process.kill(-child.pid, 'SIGKILL');
        await exited;
    }
}

// Leaves a --keep backend running, or stops it.
export async function releaseBackend(child, keep, base) {
    if (keep) {
        child.unref();
        say(`Backend left running at ${base} (--keep). Stop it with: kill -- -${child.pid}`);
    } else {
        await stopBackend(child);
    }
}
