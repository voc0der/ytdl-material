// Regenerates the screenshots in docs/images/gallery, which the documentation's Gallery page
// shows.
//
// Like the README capture, these are the real app: the frontend is built from the working tree
// and served by the real backend running from a throwaway copy (see stage.mjs). Only the data is
// staged -- the README's NASA library, with subscriptions that claim some of it, a download
// queue in the middle of a subscription check, notifications and task history
// (fixtures/gallery.json). It downloads nothing: the queued downloads are held by a concurrent
// download limit of 0, and the one shown downloading is recorded mid-step, which is never
// resumed on its own.
//
// Every file is a clip of its own thumbnail, as long as the video it stands for, so the player
// shows a frame from that video rather than a test pattern. That needs ffmpeg.
//
// Usage: node gallery.mjs [--skip-build] [--keep]
//   --keep leaves the backend running with everything in place.

import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import {
    CACHE, HERE, REPO_ROOT, buildFrontend, copyBackend, hasFrontendBuild, isListening,
    releaseBackend, say, startBackend, writeMigrationFlags
} from './stage.mjs';

const FIXTURES = join(HERE, 'fixtures');
const OUTPUT_DIR = join(REPO_ROOT, 'docs', 'images', 'gallery');
const RUN_DIR = join(CACHE, 'gallery');
// Beside the README capture's 17449 and the other harnesses' 17450-17457.
const PORT = 17458;
const BASE = `http://localhost:${PORT}`;
const HOUR = 3_600_000;

const DEVICES = {
    desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
};

function stableUid(id) {
    const hex = createHash('sha1').update(`ytdl-material-gallery:${id}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function api(route, body = {}) {
    const response = await fetch(`${BASE}/api/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`/api/${route} answered ${response.status}`);
    return await response.json();
}

// A still of the thumbnail at its own aspect ratio, so the player letterboxes it the way it
// would the real video, and as long as the real video, so the player's controls agree with
// the length the library shows. One frame a second is what lands on every length exactly.
async function makeClip(thumbnail, path, seconds) {
    await promisify(execFile)('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-loop', '1', '-framerate', '1', '-i', thumbnail, '-t', String(seconds),
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-tune', 'stillimage',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path
    ]);
}

async function seed() {
    const library = JSON.parse(await readFile(join(FIXTURES, 'library.json'), 'utf8'));
    const gallery = JSON.parse(await readFile(join(FIXTURES, 'gallery.json'), 'utf8'));
    const now = Date.parse(library.downloaded);
    await mkdir(join(RUN_DIR, 'appdata'), { recursive: true });

    const subscriptions = gallery.subscriptions.map(sub => ({
        id: stableUid(`subscription:${sub.id}`),
        name: sub.name,
        url: `https://example.com/${sub.isPlaylist ? 'playlist' : 'channel'}/${sub.id}`,
        maxQuality: 'best',
        user_uid: null,
        type: 'video',
        isPlaylist: sub.isPlaylist,
        use_subfolder: true,
        auto_create_playlist: false,
        paused: false,
        downloading: false,
        refresh_status: { active: false, phase: 'idle', completed_at: now - sub.checked_hours_ago * HOUR },
        fixture_id: sub.id,
        videos: sub.videos
    }));
    const subscriptionOf = id => subscriptions.find(sub => sub.videos.includes(id)) ?? null;
    const subscriptionById = id => subscriptions.find(sub => sub.fixture_id === id);

    const files = [];
    for (const [index, video] of library.videos.entries()) {
        const uid = stableUid(video.id);
        const sub = subscriptionOf(video.id);
        // Where a download would have put it: a subscription's files in its own folder.
        const folder = sub ? join('subscriptions', sub.isPlaylist ? 'playlists' : 'channels', sub.name) : 'video';
        await mkdir(join(RUN_DIR, folder), { recursive: true });
        const thumbnail = join(FIXTURES, 'thumbnails', `${video.id}.jpg`);
        await makeClip(thumbnail, join(RUN_DIR, folder, `${video.id}.mp4`), video.duration);
        await cp(thumbnail, join(RUN_DIR, folder, `${video.id}.jpg`));

        files.push({
            id: video.id, title: video.title, thumbnailURL: `/api/thumbnail/${uid}`, isAudio: false,
            duration: video.duration, url: '', uploader: video.uploader, size: 0,
            path: join(folder, `${video.id}.mp4`),
            upload_date: `${video.upload_date.slice(0, 4)}-${video.upload_date.slice(4, 6)}-${video.upload_date.slice(6, 8)}`,
            description: video.description, view_count: video.view_count, height: video.height, abr: null,
            source_id: null, source_extractor: null, duplicate_key: null, favorite: false,
            source_metadata_checked: true, thumbnailPath: join(folder, `${video.id}.jpg`), uid,
            sub_id: sub?.id ?? null,
            registered: now - gallery.downloaded_hours_ago[index] * HOUR
        });
    }
    const fileById = id => {
        const file = files.find(candidate => candidate.id === id);
        if (!file) throw new Error(`gallery.json names unknown video "${id}"`);
        return file;
    };

    const playlists = library.playlists.map(playlist => {
        const members = playlist.videos.map(fileById);
        return {
            name: playlist.name, uids: members.map(file => file.uid), id: stableUid(`playlist:${playlist.id}`),
            thumbnailURL: members[0].thumbnailURL, registered: now, randomize_order: false,
            duration: members.reduce((total, file) => total + file.duration, 0)
        };
    });

    // The shapes createDownload and a finished download leave behind. A running download is
    // recorded mid-step (step 2, the step not finished) rather than `running`, which the backend
    // would pause at startup; nothing picks up a step that is not finished.
    const download_queue = gallery.downloads.map((download, index) => {
        const sub = download.subscription ? subscriptionById(download.subscription) : null;
        const file = download.video ? fileById(download.video) : null;
        const started = file ? file.registered - 2 * 60_000 : now - download.hours_ago * HOUR - index * 1000;
        const finished = download.state === 'finished';
        return {
            url: `https://example.com/watch/${download.video ?? index}`,
            type: 'video',
            title: file?.title ?? download.title,
            user_uid: null,
            sub_id: sub?.id ?? null,
            sub_name: sub?.name ?? null,
            prefetched_info: null,
            options: {},
            uid: stableUid(`download:${index}`),
            step_index: finished ? 3 : download.state === 'queued' ? 0 : 2,
            paused: download.state === 'paused',
            running: false,
            finished_step: download.state !== 'running',
            error: null,
            error_summary: null,
            percent_complete: finished ? 100 : download.percent ?? null,
            playlist_item_progress: null,
            finished,
            timestamp_start: started,
            ...(finished ? { timestamp_end: file.registered, file_uids: [file.uid], container: file } : {})
        };
    });

    const notifications = gallery.notifications.map((notification, index) => {
        const uid = stableUid(`notification:${index}`);
        if (notification.type === 'download_complete') {
            const file = fileById(notification.video);
            return {
                type: 'download_complete', actions: ['play'], read: notification.read, uid, user_uid: null,
                timestamp: file.registered / 1000,
                data: { file_uid: file.uid, file_title: file.title, file_thumbnail: file.thumbnailURL, original_url: '' }
            };
        }
        return {
            type: 'task_finished', actions: ['view_tasks'], read: notification.read, uid, user_uid: null,
            timestamp: (now - notification.hours_ago * HOUR) / 1000,
            data: { task_key: notification.task_key, task_title: notification.task_title, confirmed: false }
        };
    });

    // Last runs counted back from the real clock, because the Tasks page is captured on it (see
    // captureTasks). No schedules yet: a scheduled subscription check runs at startup, and
    // would try to reach the subscriptions.
    const real_now = Date.now() / 1000;
    const tasks = [
        ['subscriptions_check', 'Check subscriptions', 1],
        ['backup_local_db', 'Backup DB', 20],
        ['missing_files_check', 'Missing files check', 20],
        ['youtubedl_update_check', 'Update yt-dlp', 30]
    ].map(([key, title, hours_ago]) => ({
        key, title, last_ran: real_now - hours_ago * 3600, last_confirmed: null, running: false,
        confirming: false, data: null, error: null, schedule: null, options: {}
    }));

    await writeFile(join(RUN_DIR, 'appdata', 'local_db.json'), JSON.stringify({
        files, playlists,
        subscriptions: subscriptions.map(({ fixture_id, videos, ...sub }) => sub),
        download_queue, notifications, tasks
    }, null, 2));
    await writeMigrationFlags(RUN_DIR);

    return { library, files, playlists, subscriptions };
}

// Schedules as a person would set them from the Tasks page. The page says when each runs next,
// counted by the backend from its own clock, so each is set a whole number of hours or days
// from now: the card then reads the same whatever time the harness runs.
async function scheduleTasks() {
    const now = new Date();
    const at = (hours, days = 0) => {
        const time = new Date(now.getTime() + hours * HOUR);
        return { hour: time.getUTCHours(), minute: time.getUTCMinutes(), tz: 'UTC', dayOfWeek: days ? [(now.getUTCDay() + days) % 7] : null };
    };
    const schedules = {
        subscriptions_check: at(5),
        backup_local_db: at(0, 3),
        youtubedl_update_check: at(11)
    };
    for (const [task_key, data] of Object.entries(schedules)) {
        await api('updateTaskSchedule', { task_key, new_schedule: { type: 'recurring', data } });
    }
}

async function newContext(browser, device, { theme = 'dark', clock = null } = {}) {
    const context = await browser.newContext({
        ...DEVICES[device],
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: theme === 'dark' ? 'dark' : 'light',
        reducedMotion: 'reduce'
    });
    // Sorted by Upload Date, as the README's image is, which is the sort whose cards say how long
    // ago each video went up.
    await context.addInitScript(stored_theme => {
        localStorage.setItem('theme', stored_theme);
        localStorage.setItem('sort_property', 'upload_date');
        localStorage.setItem('media_library_sort_order', 'descending');
        localStorage.setItem('player_autoplay_enabled', 'false');
    }, theme);
    // Every relative date on the page ("3 hours ago") is counted from now. Held at the library's
    // download date, they, and the images, stay the same from one run to the next.
    if (clock) await context.clock.setFixedTime(clock);
    return context;
}

// Everything in view has loaded: images decoded and fonts in.
async function settle(page) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForFunction(() => [...document.images].every(image => {
        const box = image.getBoundingClientRect();
        const inView = box.width > 0 && box.bottom > 0 && box.top < window.innerHeight;
        return !inView || (image.complete && image.naturalWidth > 0);
    }), null, { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
}

async function shoot(page, device, name, shots) {
    await settle(page);
    // Over the empty middle of the toolbar, so whatever was clicked last is not left hovered.
    await page.mouse.move(DEVICES[device].viewport.width / 2, 4);
    await page.waitForTimeout(200);
    const path = join(OUTPUT_DIR, `${device}-${name}.png`);
    await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
    shots.push(path);
}

async function open(page, route, ready) {
    await page.goto(`${BASE}/#/${route}`, { waitUntil: 'domcontentloaded' });
    await page.locator(ready).first().waitFor({ timeout: 30_000 });
}

// Paused at the start, as it opens before anyone presses play, whatever the browser's autoplay
// policy made of it.
async function openPlayer(page, playlist) {
    await open(page, `player;playlist_id=${playlist.id}`, '.player-playlist-section .playlist-row');
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 30_000 });
    await page.locator('video').evaluate(async video => {
        video.pause();
        if (video.currentTime === 0) return;
        const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
        video.currentTime = 0;
        await seeked;
    });
}

async function capturePages(browser, seeded, device, shots, errors) {
    const clock = seeded.library.downloaded;
    const context = await newContext(browser, device, { clock });
    const page = await context.newPage();
    watch(page, `${device}`, errors);
    const nasa = seeded.subscriptions.find(sub => sub.fixture_id === 'nasa');
    const station = seeded.playlists.find(playlist => playlist.name === 'Space Station');

    await open(page, 'home', 'app-unified-file-card img');
    await shoot(page, device, 'library', shots);

    if (device === 'desktop') {
        await page.locator('.library-switch', { hasText: 'Playlists' }).click();
        await page.locator('app-unified-file-card img').first().waitFor();
        await shoot(page, device, 'playlists', shots);
        // The tab outlives the page, and the notifications are shown over the videos.
        await page.locator('.library-switch', { hasText: 'Videos' }).click();
    } else {
        await page.getByRole('button', { name: 'Toggle side navigation' }).click();
        await page.locator('.navigation-drawer').waitFor({ state: 'visible' });
        await shoot(page, device, 'navigation', shots);
        await page.keyboard.press('Escape');
    }

    // Scrolled down to the playlist under the video. Not on a phone, where the video takes its
    // full 75vh however narrow the screen, and the frame is a band across a black box.
    if (device === 'desktop') {
        await openPlayer(page, station);
        await page.locator('.player-playlist-section').evaluate(section => section.scrollIntoView({ block: 'end' }));
        await shoot(page, device, 'player', shots);
    }

    await open(page, 'subscriptions', '.subscription-card img');
    await shoot(page, device, 'subscriptions', shots);

    if (device === 'desktop') {
        await open(page, `subscription;id=${nasa.id}`, 'app-unified-file-card img');
        await shoot(page, device, 'subscription', shots);
    }

    await open(page, 'downloads', '.download-row');
    await shoot(page, device, 'downloads', shots);

    if (device === 'desktop') {
        // The integrations, rather than the Main tab's URL and port, which are the harness's own.
        await open(page, 'settings;tab=notifications', '.settings-panel .settings-section');
        await shoot(page, device, 'settings', shots);
    }

    await open(page, 'home', 'app-unified-file-card img');
    await page.locator('mat-toolbar button:has(mat-icon:text-matches("^notifications"))').first().click();
    await page.locator('.notifications-panel').waitFor();
    await shoot(page, device, 'notifications', shots);

    await context.close();
}

// On the real clock rather than the held one: when a task runs next is the backend's to say,
// counted from its own now.
async function captureTasks(browser, device, shots, errors) {
    const context = await newContext(browser, device);
    const page = await context.newPage();
    watch(page, `${device}/tasks`, errors);
    await open(page, 'tasks', '.task-card');
    await shoot(page, device, 'tasks', shots);
    await context.close();
}

async function captureLight(browser, seeded, device, shots, errors) {
    const context = await newContext(browser, device, { theme: 'light', clock: seeded.library.downloaded });
    const page = await context.newPage();
    watch(page, `${device}/light`, errors);
    await open(page, 'home', 'app-unified-file-card img');
    await shoot(page, device, 'light', shots);
    await context.close();
}

function watch(page, label, errors) {
    page.on('console', message => {
        if (message.type() === 'error') errors.push(`${label}: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
}

async function main() {
    const keep = process.argv.includes('--keep');
    const skipBuild = process.argv.includes('--skip-build');

    if (await isListening(BASE)) {
        throw new Error(`something is already listening on ${BASE}. If it is a --keep run, stop it with: kill -- -$(cat ${join(RUN_DIR, 'backend.pid')})`);
    }

    if (!skipBuild || !hasFrontendBuild()) {
        await buildFrontend();
    }

    say(`Staging the backend and the gallery library in ${RUN_DIR}`);
    await rm(RUN_DIR, { recursive: true, force: true });
    await mkdir(RUN_DIR, { recursive: true });
    await copyBackend(RUN_DIR);
    const seeded = await seed();

    say(`Booting the backend on ${BASE}...`);
    const backend = await startBackend(RUN_DIR, PORT, { ytdl_max_concurrent_downloads: '0' });

    const browser = await chromium.launch();
    const shots = [];
    const errors = [];
    try {
        await scheduleTasks();

        // Only what this run writes is left, so a shot that is no longer taken does not linger.
        await mkdir(OUTPUT_DIR, { recursive: true });
        for (const name of await readdir(OUTPUT_DIR)) {
            if (name.endsWith('.png')) await rm(join(OUTPUT_DIR, name));
        }

        for (const device of Object.keys(DEVICES)) {
            say(`Capturing the ${device} pages...`);
            await capturePages(browser, seeded, device, shots, errors);
            await captureTasks(browser, device, shots, errors);
            if (device === 'desktop') await captureLight(browser, seeded, device, shots, errors);
        }

        for (const shot of shots) console.log(`    ${relative(REPO_ROOT, shot)}`);
        for (const error of errors) console.log(`    page console error: ${error.slice(0, 200)}`);
    } finally {
        await browser.close();
        await releaseBackend(backend, keep, BASE);
    }
}

try {
    await main();
} catch (error) {
    console.error(`\x1b[0;31m==>\x1b[0m ${error.message}`);
    process.exitCode = 1;
}
