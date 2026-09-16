// Regenerates docs/images/readme-home.png.
//
// The screenshot is of the real app, not a mock: the frontend is built from the working
// tree and served by the real backend. Only the library is staged. The backend runs from
// a copy in a temp dir, so its working directory -- which is where it keeps appdata/ and
// the media folders -- is throwaway, and the copy is what lets it serve a build that did
// not overwrite backend/public.
//
// The library is written straight into the local database rather than imported, because
// importing stamps each file with the time it was imported and the card shows that date.
// Fixed dates are what make re-running produce the same PNG.

import { chromium } from 'playwright';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const FIXTURES = join(HERE, 'fixtures');
const OUTPUT = join(REPO_ROOT, 'docs', 'images', 'readme-home.png');

const CACHE = process.env.YTDL_SCREENSHOT_CACHE
    ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ytdl-material', 'screenshots');
const BUILD_DIR = join(CACHE, 'frontend');
// Not under CACHE: the backend serves thumbnails with res.sendFile, which answers 404 for
// any path with a dot-directory in it -- and ~/.cache is one. The page itself would still
// load, because express.static only checks the request path, so it fails as blank cards.
const RUN_DIR = join(tmpdir(), 'ytdl-material-screenshot');

// Not 17442, so a dev backend left running on the default port is neither reused nor
// in the way.
const PORT = 17449;
const BASE = `http://localhost:${PORT}`;

// Four cards to a row at 1.25x, which is the framing the README image has always had:
// 1330px wide, displayed at 1000.
const VIEWPORT = { width: 1064, height: 900 };
const SCALE = 1.25;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const say = message => console.log(`\x1b[0;36m==>\x1b[0m ${message}`);

async function buildFrontend() {
    say('Building the frontend (production)...');
    const log = join(CACHE, 'build.log');
    await mkdir(CACHE, { recursive: true });
    const output = await open(log, 'w');
    try {
        // npx rather than `npm run build`: the prebuild hook regenerates the i18n JSON in
        // src/assets, which the screenshot does not need and which would dirty the tree.
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

// Tracked and untracked-but-not-ignored files, so an uncommitted backend change shows up
// in the screenshot the same way it would in `npm run debug`. That includes the shipped
// appdata/default.json and nothing else from appdata/, which is ignored: the backend
// cannot boot without that file, because modules read config as they are required,
// before anything has had the chance to create it.
async function copyBackend() {
    const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'backend'], {
        cwd: REPO_ROOT,
        maxBuffer: 16 * 1024 * 1024
    });
    const files = stdout.split('\0')
        .filter(Boolean)
        .filter(file => !file.startsWith('backend/test/'))
        .filter(file => existsSync(join(REPO_ROOT, file)));

    for (const file of files) {
        await cp(join(REPO_ROOT, file), join(RUN_DIR, relative('backend', file)));
    }

    await cp(join(REPO_ROOT, 'Public API v1.yaml'), join(RUN_DIR, 'Public API v1.yaml'));
    await symlink(join(REPO_ROOT, 'backend', 'node_modules'), join(RUN_DIR, 'node_modules'), 'dir');
    await symlink(join(BUILD_DIR, 'browser'), join(RUN_DIR, 'public'), 'dir');
}

// A uuid-shaped value derived from the fixture id, so a --keep session has the same
// /player URLs from one run to the next.
function stableUid(id) {
    const hex = createHash('sha1').update(`ytdl-material-screenshot:${id}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function seedLibrary() {
    const library = JSON.parse(await readFile(join(FIXTURES, 'library.json'), 'utf8'));
    const downloaded = Date.parse(library.downloaded);
    const videoDir = join(RUN_DIR, 'video');
    await mkdir(videoDir, { recursive: true });
    await mkdir(join(RUN_DIR, 'appdata'), { recursive: true });

    const files = [];
    for (const [index, video] of library.videos.entries()) {
        const uid = stableUid(video.id);
        // The media file only has to exist; the home page never opens it.
        await writeFile(join(videoDir, `${video.id}.mp4`), '');
        await cp(join(FIXTURES, 'thumbnails', `${video.id}.jpg`), join(videoDir, `${video.id}.jpg`));

        // The shape registerFileDB gives a downloaded video, with paths relative to the
        // working directory as the backend records them.
        files.push({
            id: video.id,
            title: video.title,
            // A download records the source's thumbnail URL here, and the card renders no
            // image at all without one -- though it then loads thumbnailPath through the
            // API instead. Pointing it at that same endpoint keeps everything local.
            thumbnailURL: `/api/thumbnail/${uid}`,
            isAudio: false,
            duration: video.duration,
            url: '',
            uploader: video.uploader,
            size: 0,
            path: `video/${video.id}.mp4`,
            upload_date: `${video.upload_date.slice(0, 4)}-${video.upload_date.slice(4, 6)}-${video.upload_date.slice(6, 8)}`,
            description: video.description,
            view_count: video.view_count,
            height: video.height,
            abr: null,
            source_id: null,
            source_extractor: null,
            duplicate_key: null,
            favorite: false,
            source_metadata_checked: true,
            thumbnailPath: `video/${video.id}.jpg`,
            uid,
            registered: downloaded - index * 60_000
        });
    }

    const byId = new Map(files.map(file => [file.id, file]));
    const playlists = library.playlists.map(playlist => {
        const members = playlist.videos.map(id => {
            if (!byId.has(id)) throw new Error(`playlist "${playlist.id}" names unknown video "${id}"`);
            return byId.get(id);
        });
        // The shape createPlaylist gives one, including the duration it adds afterwards.
        return {
            name: playlist.name,
            uids: members.map(file => file.uid),
            id: stableUid(`playlist:${playlist.id}`),
            thumbnailURL: members[0].thumbnailURL,
            registered: downloaded,
            randomize_order: false,
            duration: members.reduce((total, file) => total + file.duration, 0)
        };
    });

    await writeFile(join(RUN_DIR, 'appdata', 'local_db.json'), JSON.stringify({ files, playlists }, null, 2));

    // Without these the first boot runs the pre-4.3 migrations, and the second of them
    // rebuilds the local database from db.json -- emptying the files table seeded above.
    await writeFile(join(RUN_DIR, 'appdata', 'db.json'), JSON.stringify({
        simplified_db_migration_complete: true,
        new_db_system_migration_complete: true,
        tasks_manager_role_migration_complete: true,
        archives_migration_complete: true
    }, null, 2));

    return library.videos.length;
}

async function isListening() {
    try {
        await fetch(`${BASE}/api/config`);
        return true;
    } catch {
        return false;
    }
}

async function startBackend() {
    // Settings from the caller's shell would otherwise leak into the capture.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ytdl_/i.test(key)));
    Object.assign(env, {
        ytdl_port: String(PORT),
        ytdl_url: BASE,
        ytdl_multi_user_mode: 'false',
        ytdl_use_local_db: 'true',
        ytdl_default_theme: 'dark'
    });

    const logPath = join(RUN_DIR, 'backend.log');
    const log = await open(logPath, 'w');
    // Detached into its own process group, writing to a file rather than a pipe, so that
    // --keep can leave it running after this script exits.
    const child = spawn(process.execPath, ['app.js'], {
        cwd: RUN_DIR,
        env,
        detached: true,
        stdio: ['ignore', log.fd, log.fd]
    });
    await log.close();
    await writeFile(join(RUN_DIR, 'backend.pid'), String(child.pid));

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
            const response = await fetch(`${BASE}/api/config`);
            if (response.ok && (response.headers.get('content-type') ?? '').includes('json')) {
                return child;
            }
        } catch {
            // not listening yet
        }
        await sleep(500);
    }

    await stopBackend(child);
    throw new Error(`backend did not answer on ${BASE} within 180s (log: ${logPath})`);
}

// Waits for the exit, so the port is free again by the time this script returns.
async function stopBackend(child) {
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

async function capture(videoCount) {
    const browser = await chromium.launch();
    const errors = [];

    try {
        const context = await browser.newContext({
            viewport: VIEWPORT,
            deviceScaleFactor: SCALE,
            locale: 'en-US',
            timezoneId: 'UTC',
            colorScheme: 'dark',
            reducedMotion: 'reduce'
        });
        // The chip the README image has always shown selected.
        await context.addInitScript(() => {
            localStorage.setItem('file_filter', JSON.stringify(['video_only']));
        });

        const page = await context.newPage();
        page.on('console', message => {
            if (message.type() === 'error') errors.push(message.text());
        });
        page.on('pageerror', error => errors.push(error.message));

        await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

        // Cards render as loading placeholders first; wait for every real one and for its
        // thumbnail to have decoded, or the capture catches a grey box.
        await page.waitForFunction(count => {
            const images = [...document.querySelectorAll('app-unified-file-card img')];
            return images.length === count && images.every(image => image.complete && image.naturalWidth > 0);
        }, videoCount, { timeout: 30_000 }).catch(async error => {
            const failure = join(RUN_DIR, 'failure.png');
            await page.screenshot({ path: failure, fullPage: true });
            throw new Error(`${error.message}\n    what the page showed instead: ${failure}\n    backend log: ${join(RUN_DIR, 'backend.log')}`);
        });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);

        // From the top of the page to just under the last card, so the image ends on a
        // whole row however the grid wraps.
        const bottom = await page.evaluate(() => Math.max(
            ...[...document.querySelectorAll('app-unified-file-card')].map(card => card.getBoundingClientRect().bottom + window.scrollY)
        ));
        const clip = { x: 0, y: 0, width: VIEWPORT.width, height: Math.ceil(bottom) + 12 };

        await mkdir(dirname(OUTPUT), { recursive: true });
        await page.screenshot({ path: OUTPUT, clip, fullPage: true, animations: 'disabled', caret: 'hide' });
        return { clip, errors };
    } finally {
        await browser.close();
    }
}

async function main() {
    const keep = process.argv.includes('--keep');
    const skipBuild = process.argv.includes('--skip-build');

    if (RUN_DIR.split(sep).some(segment => segment.startsWith('.'))) {
        throw new Error(`${RUN_DIR} has a dot-directory in it, so the backend would refuse to serve the thumbnails. Point TMPDIR somewhere else.`);
    }

    if (await isListening()) {
        throw new Error(`something is already listening on ${BASE}. If it is a --keep run, stop it with: kill -- -$(cat ${join(RUN_DIR, 'backend.pid')})`);
    }

    if (!skipBuild || !existsSync(join(BUILD_DIR, 'browser', 'index.html'))) {
        await buildFrontend();
    }

    say(`Staging the backend and library in ${RUN_DIR}`);
    await rm(RUN_DIR, { recursive: true, force: true });
    await mkdir(RUN_DIR, { recursive: true });
    await copyBackend();
    const videoCount = await seedLibrary();

    say(`Booting the backend on ${BASE}...`);
    const backend = await startBackend();

    try {
        say('Capturing the home page...');
        const { clip, errors } = await capture(videoCount);
        console.log(`    ${relative(REPO_ROOT, OUTPUT)} (${Math.round(clip.width * SCALE)}x${Math.round(clip.height * SCALE)})`);
        for (const error of errors) {
            console.log(`    page console error: ${error.slice(0, 200)}`);
        }
    } finally {
        if (keep) {
            backend.unref();
            say(`Backend left running at ${BASE} (--keep). Stop it with: kill -- -${backend.pid}`);
        } else {
            await stopBackend(backend);
        }
    }
}

try {
    await main();
} catch (error) {
    console.error(`\x1b[0;31m==>\x1b[0m ${error.message}`);
    process.exitCode = 1;
}
