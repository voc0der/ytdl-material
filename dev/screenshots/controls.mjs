// Drives the player's own controls in Chromium and Firefox: clicking and holding the picture,
// the scrubber and its chapters, the menus, keyboard shortcuts, full screen and theater mode.
//
// Firefox keeps every press on its native video controls to itself, which is why the player
// draws its own, so every check runs in both browsers. The library is two minute-long clips,
// the first cut into chapters, a playlist of both, and a short audio file. The browsers are
// started allowing playback without a click, as they would be after the click that opened the
// player.
//
// Nothing is mocked: the frontend is built from the working tree and the backend runs from a
// throwaway copy (see stage.mjs). It downloads nothing. Screenshots at a desktop and a phone
// width are left in the shots folder it prints.
//
// Usage: node controls.mjs [--skip-build] [--keep]
//   --keep leaves the backend running with the library in place.

import { chromium, firefox } from 'playwright';
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
const RUN_DIR = join(CACHE, 'controls');
const SHOTS_DIR = join(RUN_DIR, 'shots');
// Beside the other harnesses' 17449 to 17457.
const PORT = 17458;
const BASE = `http://localhost:${PORT}`;
const CLIP_SECONDS = 60;
const CHAPTERS = [
    { title: 'Intro', start_time: 0, end_time: 8 },
    { title: 'Getting set up', start_time: 8, end_time: 25 },
    { title: 'The long middle part, which has a title too long to fit', start_time: 25, end_time: 50 },
    { title: 'Wrap-up', start_time: 50, end_time: 60 }
];

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok });
    const mark = ok ? '\x1b[0;32m✓\x1b[0m' : '\x1b[0;31m✗\x1b[0m';
    console.log(`    ${mark} ${name}${detail ? ` (${detail})` : ''}`);
}

function stableUid(id) {
    const hex = createHash('sha1').update(`ytdl-material-controls:${id}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function ffmpeg(args) {
    await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

async function seed() {
    const library = JSON.parse(await readFile(join(FIXTURES, 'library.json'), 'utf8'));
    const downloaded = Date.parse(library.downloaded);
    for (const dir of ['video', 'audio', 'appdata']) await mkdir(join(RUN_DIR, dir), { recursive: true });
    const clip = join(RUN_DIR, 'clip.mp4');
    await ffmpeg([
        '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=15:duration=${CLIP_SECONDS}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip
    ]);
    const tone = join(RUN_DIR, 'tone.mp3');
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'libmp3lame', '-q:a', '6', tone]);

    const [first, second, third] = library.videos;
    const entry = (video, index, { audio = false } = {}) => {
        const uid = stableUid(video.id);
        const folder = audio ? 'audio' : 'video';
        return {
            id: video.id, title: video.title, thumbnailURL: `/api/thumbnail/${uid}`, isAudio: audio,
            duration: audio ? 5 : CLIP_SECONDS, url: '', uploader: video.uploader, size: 0,
            path: `${folder}/${video.id}.${audio ? 'mp3' : 'mp4'}`,
            upload_date: `${video.upload_date.slice(0, 4)}-${video.upload_date.slice(4, 6)}-${video.upload_date.slice(6, 8)}`,
            description: video.description, view_count: video.view_count, height: audio ? null : 360, abr: null,
            favorite: false, source_metadata_checked: true, thumbnailPath: `${folder}/${video.id}.jpg`, uid,
            registered: downloaded - index * 60_000
        };
    };
    const files = [entry(first, 0), entry(second, 1), entry(third, 2, { audio: true })];
    for (const [index, video] of [first, second, third].entries()) {
        const file = files[index];
        await cp(file.isAudio ? tone : clip, join(RUN_DIR, file.path));
        await cp(join(FIXTURES, 'thumbnails', `${video.id}.jpg`), join(RUN_DIR, file.thumbnailPath));
    }
    // The player reads a file's chapters from the .info.json beside it, as the downloader left it.
    await writeFile(join(RUN_DIR, 'video', `${first.id}.info.json`), JSON.stringify({ chapters: CHAPTERS }));
    const playlist = {
        name: 'Controls', uids: [files[0].uid, files[1].uid], id: stableUid('playlist:controls'),
        thumbnailURL: files[0].thumbnailURL, registered: downloaded, randomize_order: false,
        duration: CLIP_SECONDS * 2
    };

    await writeFile(join(RUN_DIR, 'appdata', 'local_db.json'), JSON.stringify({ files, playlists: [playlist] }, null, 2));
    await writeMigrationFlags(RUN_DIR);
    return { chaptered: files[0], plain: files[1], audio: files[2], playlist };
}

async function newPage(browser, name, errors, viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({
        viewport, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark',
        isMobile: name.includes('phone') && name.startsWith('chromium'), hasTouch: name.includes('phone')
    });
    await context.addInitScript(() => {
        localStorage.setItem('theme', 'dark');
        localStorage.setItem('player_autoplay_enabled', 'false');
        localStorage.setItem('player_repeat_enabled', 'false');
    });
    const page = await context.newPage();
    page.on('console', message => {
        if (message.type() === 'error') errors.push(`${name}: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    return page;
}

async function shoot(page, name) {
    await page.evaluate(() => document.fonts.ready);
    await page.locator('vg-player').screenshot({ path: join(SHOTS_DIR, `${name}.png`), caret: 'hide' });
}

const media = page => page.evaluate(() => {
    const video = document.querySelector('video');
    return {
        paused: video.paused, rate: video.playbackRate, time: video.currentTime, muted: video.muted,
        src: video.currentSrc, controls: video.controls
    };
});
const controlsShown = page => page.locator('app-media-controls .chrome').evaluate(el => getComputedStyle(el).visibility === 'visible');
const badge = page => page.locator('app-media-controls .speed-hold-badge').count();

async function openPlaying(page, route) {
    await page.goto(`${BASE}/#/${route}`, { waitUntil: 'domcontentloaded' });
    await page.locator('app-media-controls').waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return video && !video.paused && video.currentTime > 0.3;
    }, null, { timeout: 30_000 });
}

async function centre(page) {
    const box = await page.locator('vg-player').boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 3 };
}

async function onDesktop(browser, name, seeded, errors) {
    say(`${name}: the picture, the scrubber, the menus and the keyboard`);
    const page = await newPage(browser, name, errors);
    await openPlaying(page, `player;uid=${seeded.chaptered.uid};type=video`);
    const { x, y } = await centre(page);

    check('the video has no native controls', !(await media(page)).controls);
    check('the scrubber has a segment per chapter', await page.locator('app-media-controls .segment').count() === CHAPTERS.length);

    // Parked off the player, so only the time since it started counts.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(3200);
    check('the controls hide while it plays untouched', !(await controlsShown(page)));
    await page.mouse.move(x, y);
    await page.mouse.move(x + 10, y + 10);
    await page.waitForTimeout(200);
    check('and come back when the pointer moves over it', await controlsShown(page));

    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
    check('a click on the picture pauses', (await media(page)).paused);
    // Past the double-click interval, or the pair would go full screen.
    await page.waitForTimeout(600);
    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
    check('and another plays again', !(await media(page)).paused);
    await page.waitForTimeout(600);

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(700);
    const held = await media(page);
    const held_badge = await badge(page);
    await shoot(page, `${name}-holding`);
    await page.mouse.up();
    await page.waitForTimeout(250);
    const released = await media(page);
    check('holding the picture plays at 2x', held.rate === 2 && !held.paused, `rate ${held.rate}`);
    check('with the 2x badge showing', held_badge === 1);
    check('and letting go goes back to 1x, still playing', released.rate === 1 && !released.paused && await badge(page) === 0,
        `rate ${released.rate}, paused ${released.paused}`);

    await page.keyboard.press('k');
    await page.waitForTimeout(100);
    check('k pauses', (await media(page)).paused);
    await page.waitForTimeout(600);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(700);
    const held_paused = await media(page);
    await page.mouse.up();
    await page.waitForTimeout(250);
    check('holding a paused video plays it at 2x, and it pauses again on release',
        !held_paused.paused && held_paused.rate === 2 && (await media(page)).paused);

    const before = (await media(page)).time;
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    check('the right arrow skips 5 seconds', Math.abs((await media(page)).time - before - 5) < 0.6);
    await page.keyboard.press('m');
    check('m mutes', (await media(page)).muted);
    await page.keyboard.press('m');
    await page.keyboard.press('>');
    check('> speeds up a step', (await media(page)).rate === 1.25);
    await page.keyboard.press('<');
    check('< slows down again', (await media(page)).rate === 1);

    // The scrubber: a quarter of the way into the third chapter, which starts at 25 s.
    const segment = await page.locator('app-media-controls .segment').nth(2).boundingBox();
    const target = { x: segment.x + segment.width / 4, y: segment.y + segment.height / 2 };
    await page.mouse.move(target.x, target.y - 30);
    await page.mouse.move(target.x, target.y, { steps: 3 });
    await page.waitForTimeout(250);
    const tooltip = await page.locator('app-media-controls .scrub-tooltip').innerText();
    check('hovering the scrubber names the chapter under it', tooltip.includes('The long middle part'), tooltip.replace(/\n/g, ' '));
    await shoot(page, `${name}-scrubber-hover`);
    const thumb_at = await page.locator('app-media-controls .scrub-thumb').evaluate(el => {
        const box = el.getBoundingClientRect();
        return box.left + box.width / 2;
    });
    const played_to = await page.locator('app-media-controls .segment-played').evaluateAll(fills =>
        Math.max(...fills.map(fill => fill.getBoundingClientRect()).filter(box => box.width > 0).map(box => box.right)));
    check('the marker sits at the end of the played part while hovered', Math.abs(thumb_at - played_to) < 3,
        `marker ${Math.round(thumb_at)}, played to ${Math.round(played_to)}`);
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(300);
    const scrubbed = (await media(page)).time;
    check('clicking it seeks there', scrubbed > 29 && scrubbed < 34, `${scrubbed.toFixed(1)} s`);
    check('and the bar names the chapter playing', (await page.locator('app-media-controls .chapter-title').innerText()).startsWith('The long middle'));

    await page.getByRole('button', { name: 'Playback speed' }).click();
    await page.waitForTimeout(200);
    await shoot(page, `${name}-speed-menu`);
    const menu_box = await page.locator('app-media-controls .controls-menu').boundingBox();
    const scrubber_box = await page.locator('app-media-controls .scrubber').boundingBox();
    check('the menu opens above the scrubber, clear of it', menu_box.y + menu_box.height <= scrubber_box.y,
        `menu ends at ${Math.round(menu_box.y + menu_box.height)}, scrubber starts at ${Math.round(scrubber_box.y)}`);
    await page.getByRole('menuitemradio', { name: '1.5x' }).click();
    check('the speed menu sets the rate', (await media(page)).rate === 1.5);
    check('and the button says so', (await page.locator('app-media-controls .rate-badge').innerText()) === '1.5x');
    // Normal sits about halfway up the right of the picture, where Firefox puts its own
    // picture-in-picture button, above the page.
    await page.getByRole('button', { name: 'Playback speed' }).click();
    await page.getByRole('menuitemradio', { name: 'Normal' }).click();
    check('an option over the middle of the picture takes its own click', (await media(page)).rate === 1);

    await page.getByRole('button', { name: 'Chapters' }).click();
    await page.waitForTimeout(200);
    await shoot(page, `${name}-chapters-menu`);
    await page.getByRole('menuitemradio', { name: /Wrap-up/ }).click();
    await page.waitForTimeout(200);
    check('the chapters menu jumps to a chapter', Math.abs((await media(page)).time - 50) < 0.6);

    await page.mouse.move(x, y);
    await page.mouse.dblclick(x, y);
    await page.waitForTimeout(500);
    const fullscreen = await page.evaluate(() => document.fullscreenElement?.tagName ?? null);
    check('a double-click takes the whole player full screen', fullscreen === 'VG-PLAYER', `${fullscreen}`);
    if (fullscreen) {
        await shoot(page, `${name}-fullscreen`);
        await page.keyboard.press('f');
        await page.waitForTimeout(500);
        check('and f leaves it', await page.evaluate(() => !document.fullscreenElement));
    }
    await page.waitForTimeout(600);

    await page.mouse.move(x, y);
    await page.getByRole('button', { name: 'Theater mode' }).click();
    check('the bar\'s theater button hides the list', await page.locator('.player-playlist-section').isHidden());
    await page.keyboard.press('t');
    check('and t brings it back', await page.locator('.player-playlist-section').isVisible());

    await page.context().close();

    const listed = await newPage(browser, name, errors);
    await openPlaying(listed, `player;playlist_id=${seeded.playlist.id}`);
    const first_src = (await media(listed)).src;
    await listed.mouse.move(...Object.values(await centre(listed)));
    await listed.getByRole('button', { name: 'Next', exact: true }).click();
    await listed.waitForFunction(src => {
        const video = document.querySelector('video');
        return video.currentSrc !== src && !video.paused;
    }, first_src, { timeout: 15_000 }).catch(() => {});
    check('in a playlist, Next plays the next file', (await media(listed)).src !== first_src);
    await listed.context().close();

    const audio = await newPage(browser, name, errors);
    await audio.goto(`${BASE}/#/player;uid=${seeded.audio.uid};type=audio`, { waitUntil: 'domcontentloaded' });
    await audio.locator('video').waitFor({ timeout: 30_000 });
    check('an audio file keeps the browser\'s own bar', (await media(audio)).controls && await audio.locator('app-media-controls').count() === 0);
    await audio.context().close();
}

async function onAPhone(browser, name, seeded, errors) {
    say(`${name}: a phone`);
    const page = await newPage(browser, `${name}-phone`, errors, { width: 412, height: 915 });
    await openPlaying(page, `player;uid=${seeded.chaptered.uid};type=video`);
    await page.waitForTimeout(3200);
    const { x, y } = await centre(page);
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(300);
    check('a tap shows the controls without pausing', await controlsShown(page) && !(await media(page)).paused);
    await shoot(page, `${name}-phone`);
    const bar = await page.locator('app-media-controls .bar').boundingBox();
    const player = await page.locator('vg-player').boundingBox();
    check('the bar fits the phone\'s width', bar.x >= player.x - 0.5 && bar.x + bar.width <= player.x + player.width + 0.5);
    await page.locator('app-media-controls .center-play').tap();
    await page.waitForTimeout(200);
    check('and its play button in the middle pauses', (await media(page)).paused);
    await page.context().close();
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

    const errors = [];
    try {
        for (const [name, type, options] of [
            ['chromium', chromium, { args: ['--autoplay-policy=no-user-gesture-required'] }],
            ['firefox', firefox, { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } }]
        ]) {
            const browser = await type.launch(options);
            try {
                await onDesktop(browser, name, seeded, errors);
                await onAPhone(browser, name, seeded, errors);
            } finally {
                await browser.close();
            }
        }
        for (const error of errors) console.log(`    page console error: ${error.slice(0, 200)}`);
        check('no page errors', errors.length === 0);
        console.log(`    screenshots: ${SHOTS_DIR}`);
    } finally {
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
