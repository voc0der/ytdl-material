// Drives the list under the player, end to end: a playlist played through with Autoplay and
// Repeat, reordered by dragging, and a file played on its own that Autoplay turns into the
// library.
//
// Autoplay is only seen working when a video ends, so every file here is a real two-second
// clip, made once with ffmpeg and copied under each name. The library is the README's NASA
// videos, their thumbnails and their playlists. The browser is started allowing playback
// without a click, as it would be after the click that opened the player.
//
// Nothing is mocked: the frontend is built from the working tree and the backend runs from a
// throwaway copy (see stage.mjs). It downloads nothing. Screenshots at a desktop and a phone
// width, light and dark, are left in the shots folder it prints.
//
// Usage: node player.mjs [--skip-build] [--keep]
//   --keep leaves the backend running with the library in place.

import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
    CACHE, HERE, buildFrontend, copyBackend, hasFrontendBuild, isListening, releaseBackend, say,
    startBackend, writeMigrationFlags
} from './stage.mjs';

const FIXTURES = join(HERE, 'fixtures');
const RUN_DIR = join(CACHE, 'player');
const SHOTS_DIR = join(RUN_DIR, 'shots');
// Beside the README capture's 17449, subscriptions' 17450, downloads' 17451, dialogs' 17452,
// settings' 17453, notifications' 17454, library's 17455 and login's 17456.
const PORT = 17457;
const BASE = `http://localhost:${PORT}`;
const CLIP_SECONDS = 2;

const DEVICES = {
    desktop: { viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false },
    phone: { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }
};

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok });
    const mark = ok ? '\x1b[0;32m✓\x1b[0m' : '\x1b[0;31m✗\x1b[0m';
    console.log(`    ${mark} ${name}${detail ? ` (${detail})` : ''}`);
}

function stableUid(id) {
    const hex = createHash('sha1').update(`ytdl-material-player:${id}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// The same "4:03" the library's cards and the list's rows print.
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = `${seconds % 60}`.padStart(2, '0');
    return hours > 0 ? `${hours}:${`${minutes}`.padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

async function makeClip(path) {
    await promisify(execFile)('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=15:duration=${CLIP_SECONDS}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path
    ]);
}

// The README library and its playlists, each file a clip that plays and ends. Downloaded a
// minute apart, newest first, so the library's order is the fixture's.
async function seed() {
    const library = JSON.parse(await readFile(join(FIXTURES, 'library.json'), 'utf8'));
    const downloaded = Date.parse(library.downloaded);
    const videoDir = join(RUN_DIR, 'video');
    await mkdir(videoDir, { recursive: true });
    await mkdir(join(RUN_DIR, 'appdata'), { recursive: true });
    const clip = join(RUN_DIR, 'clip.mp4');
    await makeClip(clip);

    const files = [];
    for (const [index, video] of library.videos.entries()) {
        const uid = stableUid(video.id);
        await cp(clip, join(videoDir, `${video.id}.mp4`));
        await cp(join(FIXTURES, 'thumbnails', `${video.id}.jpg`), join(videoDir, `${video.id}.jpg`));
        files.push({
            id: video.id, title: video.title, thumbnailURL: `/api/thumbnail/${uid}`, isAudio: false,
            duration: video.duration, url: '', uploader: video.uploader, size: 0,
            path: `video/${video.id}.mp4`,
            upload_date: `${video.upload_date.slice(0, 4)}-${video.upload_date.slice(4, 6)}-${video.upload_date.slice(6, 8)}`,
            description: video.description, view_count: video.view_count, height: video.height, abr: null,
            favorite: false, source_metadata_checked: true, thumbnailPath: `video/${video.id}.jpg`, uid,
            registered: downloaded - index * 60_000
        });
    }

    const byId = new Map(files.map(file => [file.id, file]));
    const playlists = library.playlists.map(playlist => {
        const members = playlist.videos.map(id => byId.get(id));
        return {
            name: playlist.name, uids: members.map(file => file.uid), id: stableUid(`playlist:${playlist.id}`),
            thumbnailURL: members[0].thumbnailURL, registered: downloaded, randomize_order: false,
            duration: members.reduce((total, file) => total + file.duration, 0)
        };
    });

    await writeFile(join(RUN_DIR, 'appdata', 'local_db.json'), JSON.stringify({ files, playlists }, null, 2));
    await writeMigrationFlags(RUN_DIR);
    return { files, playlists };
}

async function newPage(browser, device, errors, { theme = 'dark', autoplay = false } = {}) {
    const context = await browser.newContext({
        ...DEVICES[device],
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: theme === 'dark' ? 'dark' : 'light',
        reducedMotion: 'reduce'
    });
    await context.addInitScript(([stored_theme, stored_autoplay]) => {
        localStorage.setItem('theme', stored_theme);
        localStorage.setItem('player_autoplay_enabled', stored_autoplay);
        localStorage.setItem('player_repeat_enabled', 'false');
    }, [theme, `${autoplay}`]);
    const page = await context.newPage();
    page.on('console', message => {
        if (message.type() === 'error') errors.push(`${device}/${theme}: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`${device}/${theme}: ${error.message}`));
    return page;
}

// The list sits under the video, below the fold on most screens.
async function shoot(page, name) {
    await page.locator('.player-playlist-section').scrollIntoViewIfNeeded().catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

const queue = page => page.locator('.player-playlist-section');
const rows = page => queue(page).locator('.playlist-row');
const rowTitles = page => rows(page).locator('.queue-item-title').allInnerTexts();
const queueTitle = async page => (await queue(page).locator('.queue-title').innerText()).trim();
const queueMeta = async page => {
    const meta = queue(page).locator('.queue-meta');
    return await meta.count() ? (await meta.innerText()).trim() : '';
};
const playingIndex = page => rows(page).evaluateAll(all => all.findIndex(row => row.querySelector('.queue-item[aria-current="true"]')));
const autoplayButton = page => queue(page).locator('.playlist-autoplay-button');
const repeatButton = page => queue(page).locator('.playlist-repeat-button');

async function waitForPlaying(page, index, timeout = 15_000) {
    await page.waitForFunction(expected => {
        const all = [...document.querySelectorAll('.player-playlist-section .playlist-row')];
        return all.findIndex(row => row.querySelector('.queue-item[aria-current="true"]')) === expected;
    }, index, { timeout }).catch(() => {});
    return await playingIndex(page) === index;
}

// The CDK starts a drag only once the pointer has moved a few pixels with the button held, so
// this moves in steps the way a hand would rather than jumping to the target.
async function drag(page, from, to) {
    const start = await from.boundingBox();
    const end = await to.boundingBox();
    await page.mouse.move(start.x + start.width / 3, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 3, start.y + start.height / 2 + 8, { steps: 4 });
    await page.mouse.move(end.x + end.width / 3, end.y + end.height / 2 + 6, { steps: 16 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(400);
}

async function openPlaylist(page, playlist) {
    await page.goto(`${BASE}/#/player;playlist_id=${playlist.id}`, { waitUntil: 'domcontentloaded' });
    await rows(page).first().waitFor({ timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
}

async function playingAPlaylist(page, seeded) {
    say('Playing a playlist');
    const playlist = seeded.playlists.find(candidate => candidate.name === 'Space Station');
    const members = playlist.uids.map(uid => seeded.files.find(file => file.uid === uid));
    await openPlaylist(page, playlist);

    check('the list is headed by the playlist', await queueTitle(page) === 'Space Station');
    check('and says where in it the player is', await queueMeta(page) === '1 of 4', await queueMeta(page));
    const titles = await rowTitles(page);
    check('one row per file, in the playlist\'s order', titles.join('|') === members.map(file => file.title).join('|'), titles.length);

    const thumbnails = await rows(page).locator('.queue-thumb img').evaluateAll(images => images.map(image => image.complete && image.naturalWidth > 0));
    check('every row shows its thumbnail', thumbnails.length === 4 && thumbnails.every(Boolean), thumbnails.join(','));
    const durations = await rows(page).locator('.queue-duration').allInnerTexts();
    check('and how long it runs', durations.join('|') === members.map(file => formatDuration(file.duration)).join('|'), durations.join(', '));
    const uploaders = await rows(page).locator('.queue-item-meta').allInnerTexts();
    check('and who uploaded it', uploaders.length === 4 && uploaders.every(uploader => uploader === 'NASA'));

    const layout = await rows(page).first().evaluate(row => {
        const thumb = row.querySelector('.queue-thumb').getBoundingClientRect();
        const title = row.querySelector('.queue-item-title');
        return { gap: title.getBoundingClientRect().left - thumb.right, align: getComputedStyle(title).textAlign };
    });
    check('titles read from the left, beside the thumbnail', layout.gap > 0 && layout.gap < 24 && ['left', 'start'].includes(layout.align), `${Math.round(layout.gap)}px, ${layout.align}`);

    check('the first row is the one playing, and only it is marked', await playingIndex(page) === 0
        && await queue(page).locator('.queue-item[aria-current="true"]').count() === 1);
    const onPlayingRow = await rows(page).first().evaluate(row =>
        ['.playlist-repeat-button', '.playlist-autoplay-button'].every(selector => row.querySelector(selector)));
    check('Repeat and Autoplay sit on the playing row, and only there', onPlayingRow
        && await autoplayButton(page).count() === 1 && await repeatButton(page).count() === 1);
    await shoot(page, 'player-playlist-desktop');

    await rows(page).nth(2).locator('.queue-item').click();
    check('clicking a row plays it', await waitForPlaying(page, 2, 5_000)
        && (await page.locator('#singleVideo').getAttribute('src')).includes(members[2].uid));
    check('the controls move with it', await rows(page).nth(2).locator('.playlist-autoplay-button').count() === 1);
    check('and the heading keeps count', await queueMeta(page) === '3 of 4', await queueMeta(page));

    if (await autoplayButton(page).getAttribute('aria-pressed') !== 'true') await autoplayButton(page).click();
    check('Autoplay turns on', await autoplayButton(page).getAttribute('aria-pressed') === 'true');
    check('and plays the next file when this one ends', await waitForPlaying(page, 3), `playing row ${await playingIndex(page) + 1}`);
    check('with the heading following it', await queueMeta(page) === '4 of 4', await queueMeta(page));

    await repeatButton(page).click();
    check('Repeat turns Autoplay off', await repeatButton(page).getAttribute('aria-pressed') === 'true'
        && await autoplayButton(page).getAttribute('aria-pressed') === 'false');
    const plays = await page.evaluate(async seconds => {
        const video = document.querySelector('#singleVideo');
        let count = 0;
        video.addEventListener('play', () => count++);
        await video.play();
        await new Promise(resolve => setTimeout(resolve, (seconds * 2 + 1) * 1000));
        return count;
    }, CLIP_SECONDS);
    check('and plays the same file again when it ends', plays >= 2 && await playingIndex(page) === 3, `${plays} plays`);
    await repeatButton(page).click();

    await drag(page, rows(page).nth(0), rows(page).nth(2));
    const reordered = await rowTitles(page);
    const expected = [members[1], members[2], members[0], members[3]].map(file => file.title);
    check('a row can be dragged to another place in the list', reordered.join('|') === expected.join('|'), reordered.map(title => title.slice(0, 12)).join(', '));
    check('and the playing row stays the one playing', await playingIndex(page) === 3 && await queueMeta(page) === '4 of 4');

    await page.getByRole('button', { name: 'Theater mode' }).click();
    check('theater mode hides the list', await queue(page).isHidden());
    await page.keyboard.press('Escape');
    check('and leaving it brings the list back', await queue(page).isVisible());
}

async function playingOneFile(browser, seeded, errors) {
    say('Playing a file on its own');
    // The oldest download, so it is the last row once the library is queued.
    const oldest = [...seeded.files].sort((a, b) => a.registered - b.registered)[0];

    const page = await newPage(browser, 'desktop', errors, { autoplay: false });
    await page.goto(`${BASE}/#/player;uid=${oldest.uid};type=video`, { waitUntil: 'domcontentloaded' });
    await rows(page).first().waitFor({ timeout: 30_000 });
    check('a file played on its own is headed as what is playing', await queueTitle(page) === 'Now playing', await queueTitle(page));
    check('with a hint at what Autoplay would do', await queueMeta(page) === 'Turn on Autoplay to keep playing from your library.', await queueMeta(page));
    // Watching together is offered for a file played on its own, once the player is ready.
    await rows(page).first().locator('.watch-together-button').waitFor({ timeout: 10_000 }).catch(() => {});
    check('its row carries Watch together beside Repeat and Autoplay', await rows(page).first().evaluate(row =>
        ['.watch-together-button', '.playlist-repeat-button', '.playlist-autoplay-button'].every(selector => row.querySelector(selector))));
    await shoot(page, 'player-single-desktop');

    await autoplayButton(page).click();
    await page.waitForFunction(() => document.querySelector('.player-playlist-section .queue-title')?.textContent.trim() === 'Library', null, { timeout: 15_000 }).catch(() => {});
    check('turning Autoplay on queues the library', await queueTitle(page) === 'Library' && await rows(page).count() === seeded.files.length, `${await rows(page).count()} rows`);
    check('with the file still playing, now last of all', await playingIndex(page) === seeded.files.length - 1
        && await queueMeta(page) === `${seeded.files.length} of ${seeded.files.length}`, await queueMeta(page));

    // The download is held open so the ring stays up long enough to be measured. It was once
    // placed by offsets meant for a bigger button, and sat below and to the right of the icon.
    await page.route(/downloadFileFromServer/, () => {});
    await page.getByRole('button', { name: 'Download this file' }).click();
    await page.locator('.action-buttons-row mat-spinner').waitFor({ timeout: 5_000 }).catch(() => {});
    const ring = await page.evaluate(() => {
        const spinner = document.querySelector('.action-buttons-row mat-spinner');
        const icon = spinner?.closest('.buttons').querySelector('mat-icon');
        if (!spinner || !icon) return null;
        const centre = element => {
            const box = element.getBoundingClientRect();
            return [box.left + box.width / 2, box.top + box.height / 2];
        };
        const [[sx, sy], [ix, iy]] = [centre(spinner), centre(icon)];
        return { x: Math.abs(sx - ix), y: Math.abs(sy - iy) };
    });
    check('downloading the file rings its icon, centred on it', ring && ring.x < 0.5 && ring.y < 0.5,
        ring ? `off by ${ring.x}px, ${ring.y}px` : 'no ring');
    await page.context().close();

    // Autoplay already on: the library is queued as the page opens, with the page at the top.
    const opened = await newPage(browser, 'desktop', errors, { autoplay: true });
    await opened.goto(`${BASE}/#/player;uid=${oldest.uid};type=video`, { waitUntil: 'domcontentloaded' });
    await opened.waitForFunction(() => document.querySelectorAll('.player-playlist-section .playlist-row').length > 1, null, { timeout: 15_000 }).catch(() => {});
    await opened.waitForTimeout(300);
    const scroll = await opened.evaluate(() => {
        const list = document.querySelector('.queue-list');
        const row = list.querySelector('.playlist-row.current').getBoundingClientRect();
        const box = list.getBoundingClientRect();
        return {
            scrolls: list.scrollHeight > list.clientHeight, listTop: list.scrollTop,
            inView: row.top >= box.top - 1 && row.bottom <= box.bottom + 1, pageTop: window.scrollY
        };
    });
    check('a long list scrolls inside its own box', scroll.scrolls);
    check('and has scrolled to the playing row at the bottom of it', scroll.inView && scroll.listTop > 0, `scrollTop ${scroll.listTop}`);
    check('without moving the page away from the video', scroll.pageTop === 0, `page at ${scroll.pageTop}`);
    await opened.locator('.queue-list').evaluate(list => { list.scrollTop = 0; });
    await shoot(opened, 'player-library-desktop');
    await opened.context().close();
}

async function onAPhone(browser, seeded, errors, theme) {
    const page = await newPage(browser, 'phone', errors, { theme });
    await openPlaylist(page, seeded.playlists.find(candidate => candidate.name === 'Space Station'));
    await queue(page).scrollIntoViewIfNeeded();
    const fit = await page.evaluate(() => {
        const row = document.querySelector('.player-playlist-section .playlist-row.current');
        const item = row.querySelector('.queue-item').getBoundingClientRect();
        const actions = row.querySelector('.playlist-row-actions').getBoundingClientRect();
        return {
            fits: document.documentElement.scrollWidth <= window.innerWidth + 1,
            below: actions.top >= item.bottom - 1,
            share: Math.round(item.width / row.getBoundingClientRect().width * 100)
        };
    });
    await shoot(page, `player-playlist-phone-${theme}`);
    await page.context().close();
    return fit;
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

    say(`Staging the backend and the library in ${RUN_DIR}`);
    await rm(RUN_DIR, { recursive: true, force: true });
    await mkdir(SHOTS_DIR, { recursive: true });
    await copyBackend(RUN_DIR);
    const seeded = await seed();

    say(`Booting the backend on ${BASE}...`);
    const backend = await startBackend(RUN_DIR, PORT);

    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const errors = [];
    try {
        const page = await newPage(browser, 'desktop', errors);
        await playingAPlaylist(page, seeded);
        await page.context().close();

        await playingOneFile(browser, seeded, errors);

        say('Checking a phone width, and the light theme');
        for (const theme of ['dark', 'light']) {
            const fit = await onAPhone(browser, seeded, errors, theme);
            check(`the list fits on a phone, ${theme}`, fit.fits);
            check(`with the playing row's controls under its title, which keeps the width, ${theme}`, fit.below && fit.share >= 98, `${fit.share}% of the row`);
        }
        const light = await newPage(browser, 'desktop', errors, { theme: 'light' });
        await openPlaylist(light, seeded.playlists.find(candidate => candidate.name === 'Space Station'));
        await shoot(light, 'player-playlist-desktop-light');
        await light.context().close();

        for (const error of errors) console.log(`    page console error: ${error.slice(0, 200)}`);
        check('no page errors', errors.length === 0);
        console.log(`    screenshots: ${SHOTS_DIR}`);
    } finally {
        await browser.close();
        await releaseBackend(backend, keep, BASE);
    }

    const failed = results.filter(result => !result.ok);
    if (failed.length) {
        throw new Error(`${failed.length} of ${results.length} checks failed`);
    }
    say(`All ${results.length} checks passed.`);
}

try {
    await main();
} catch (error) {
    console.error(`\x1b[0;31m==>\x1b[0m ${error.message}`);
    process.exitCode = 1;
}
