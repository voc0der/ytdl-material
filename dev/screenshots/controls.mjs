// Drives the player's controls in Chromium and Firefox: the picture, the scrub bar and its
// chapters, subtitles, the menus, keyboard shortcuts, full screen and theater mode.
//
// Every check runs in both browsers. The library is two minute-long clips, the first cut into
// chapters and carrying two subtitle tracks, a playlist of both, and a short audio file. The
// browsers are started allowing playback without a click, as they would be after the click that
// opened the player.
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
// Past the other harnesses' 17449 to 17460.
const PORT = 17461;
const BASE = `http://localhost:${PORT}`;
const CLIP_SECONDS = 60;
const CHAPTERS = [
    { title: 'Intro', start_time: 0, end_time: 8 },
    { title: 'Getting set up', start_time: 8, end_time: 25 },
    { title: 'The long middle part, which has a title too long to fit', start_time: 25, end_time: 50 },
    { title: 'Wrap-up', start_time: 50, end_time: 60 }
];
// Each track has a line every two seconds, as real subtitles change often.
const SUBTITLES = { en: 'A line in English', es: 'Una línea en español' };
const SUBTITLE_SECONDS = 2;

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
    // The chaptered clip also carries two subtitle tracks, which the backend extracts for the player.
    const subtitled = join(RUN_DIR, 'subtitled.mp4');
    const srt = async (name, text) => {
        const path = join(RUN_DIR, `${name}.srt`);
        const at = seconds => `00:00:${String(seconds).padStart(2, '0')},000`;
        const cues = [];
        for (let start = 0; start < CLIP_SECONDS; start += SUBTITLE_SECONDS) {
            cues.push(`${cues.length + 1}\n${at(start)} --> ${at(Math.min(start + SUBTITLE_SECONDS, CLIP_SECONDS - 1))}\n${text} ${cues.length + 1}\n`);
        }
        await writeFile(path, cues.join('\n'));
        return path;
    };
    const [english, spanish] = [await srt('en', SUBTITLES.en), await srt('es', SUBTITLES.es)];
    await ffmpeg([
        '-i', clip, '-i', english, '-i', spanish, '-map', '0:v', '-map', '1', '-map', '2', '-c:v', 'copy', '-c:s', 'mov_text',
        '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English',
        '-metadata:s:s:1', 'language=spa', '-metadata:s:s:1', 'title=Spanish',
        '-disposition:s:0', 'default', '-movflags', '+faststart', subtitled
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
        await cp(file.isAudio ? tone : index === 0 ? subtitled : clip, join(RUN_DIR, file.path));
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
    await page.locator('eva-player').screenshot({ path: join(SHOTS_DIR, `${name}.png`), caret: 'hide' });
}

const media = page => page.evaluate(() => {
    const video = document.querySelector('video');
    return {
        paused: video.paused, rate: video.playbackRate, time: video.currentTime, muted: video.muted,
        volume: video.volume, src: video.currentSrc, controls: video.controls, loop: video.loop
    };
});
const controlsShown = async page => !(await page.locator('eva-controls-container').evaluate(el => el.classList.contains('hide')));
const subtitle = async page => {
    const shown = page.locator('eva-subtitle-display.eva-subtitle-display--visible');
    return await shown.count() ? (await shown.innerText()).trim() : null;
};
// The next line is at most SUBTITLE_SECONDS away.
const subtitleShown = (page, text) => page.waitForFunction(text => {
    const shown = document.querySelector('eva-subtitle-display.eva-subtitle-display--visible');
    return text === null ? !shown : shown?.textContent.trim().startsWith(text);
}, text, { timeout: (SUBTITLE_SECONDS + 1) * 1000 }).then(() => true, () => false);
// The controls slide away when left alone, and back in on the next move, and Firefox scrolls
// the page a little after the subtitles menu, so a click is aimed only once what it is meant for
// is under the pointer. Returns where that is.
async function pointAt(page, where, selector) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const point = await where();
        await page.mouse.move(point.x, point.y - 1);
        await page.mouse.move(point.x, point.y);
        await page.waitForTimeout(150);
        if (await page.evaluate(([point, selector]) => !!document.elementFromPoint(point.x, point.y)?.closest(selector), [point, selector])) {
            return point;
        }
    }
    throw new Error(`nothing matching ${selector} came under the pointer`);
}
const nativeSubtitles = page => page.evaluate(() =>
    Array.from(document.querySelector('video').textTracks).filter(track => track.mode === 'showing').length);

async function openPlaying(page, route) {
    await page.goto(`${BASE}/#/${route}`, { waitUntil: 'domcontentloaded' });
    await page.locator('eva-controls-container').waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return video && !video.paused && video.currentTime > 0.3;
    }, null, { timeout: 30_000 });
}

async function centre(page) {
    const box = await page.locator('eva-player').boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 3 };
}

async function onDesktop(browser, name, seeded, errors) {
    say(`${name}: the picture, the scrub bar, subtitles, the menus and the keyboard`);
    const page = await newPage(browser, name, errors);
    await openPlaying(page, `player;uid=${seeded.chaptered.uid};type=video`);
    const { x, y } = await centre(page);

    check('it plays by itself, without native controls', !(await media(page)).controls);
    check('the scrub bar marks each chapter', await page.locator('eva-scrub-bar .eva-chapter-marker').count() === CHAPTERS.length);
    check('the first subtitle track shows', await subtitleShown(page, SUBTITLES.en), `${await subtitle(page)}`);
    check('drawn once, not by the browser as well', await nativeSubtitles(page) === 0);

    await page.mouse.move(x, y);
    await page.mouse.move(x + 10, y + 10);
    // Parked off the player, so only the time since the last move counts.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(3500);
    check('the controls hide while it plays untouched', !(await controlsShown(page)));
    await shoot(page, `${name}-subtitles`);
    await page.mouse.move(x, y);
    await page.mouse.move(x + 10, y + 10);
    await page.waitForTimeout(200);
    check('and come back when the pointer moves over it', await controlsShown(page));
    const bar = await page.locator('eva-controls-container').boundingBox();
    for (let step = 0; step < 8; step++) {
        await page.mouse.move(bar.x + 200 + step * 40, bar.y + bar.height / 2);
        await page.waitForTimeout(500);
    }
    check('they stay up while the pointer moves along the bar', await controlsShown(page));

    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
    check('a click on the picture pauses', (await media(page)).paused);
    await shoot(page, `${name}-paused`);
    // Past the double-click interval, or the pair would go full screen.
    await page.waitForTimeout(600);
    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
    check('and another plays again', !(await media(page)).paused);
    await page.waitForTimeout(600);

    const badge = () => page.locator('.speed-hold-badge').count();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(700);
    const held = await media(page);
    const held_badge = await badge();
    await shoot(page, `${name}-holding`);
    await page.mouse.up();
    await page.waitForTimeout(250);
    const released = await media(page);
    check('holding the picture plays at 2x', held.rate === 2 && !held.paused, `rate ${held.rate}`);
    check('with the 2x badge showing', held_badge === 1);
    check('and letting go goes back to 1x, still playing', released.rate === 1 && !released.paused && await badge() === 0,
        `rate ${released.rate}, paused ${released.paused}`);

    await page.keyboard.press('Space');
    await page.waitForTimeout(600);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(700);
    const held_paused = await media(page);
    await page.mouse.up();
    await page.waitForTimeout(250);
    check('holding a paused video plays it at 2x, and it pauses again on release',
        !held_paused.paused && held_paused.rate === 2 && (await media(page)).paused);
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);

    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    check('space pauses', (await media(page)).paused);
    await page.keyboard.press('Space');
    const before = (await media(page)).time;
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    check('the right arrow skips 10 seconds', Math.abs((await media(page)).time - before - 10) < 0.8);
    await page.keyboard.press('m');
    check('m mutes', (await media(page)).muted);
    await page.keyboard.press('m');
    await page.keyboard.press('>');
    check('> speeds up a step', (await media(page)).rate === 1.25);
    await page.keyboard.press('<');
    check('< slows down again', (await media(page)).rate === 1);
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(SUBTITLE_SECONDS * 1000 + 500);
    check('ctrl+c leaves the subtitles alone', (await subtitle(page))?.startsWith(SUBTITLES.en), `${await subtitle(page)}`);
    await page.keyboard.press('c');
    check('c moves to the next subtitle track', await subtitleShown(page, SUBTITLES.es), `${await subtitle(page)}`);

    await page.locator('eva-track-selector button.eva-track-selector-button').click();
    await page.waitForTimeout(200);
    await shoot(page, `${name}-subtitles-menu`);
    await page.locator('eva-track-selector').getByRole('option', { name: 'Off' }).click();
    check('the subtitles menu turns them off', await subtitleShown(page, null));
    await page.locator('eva-track-selector button.eva-track-selector-button').click();
    await page.locator('eva-track-selector').getByRole('option', { name: 'English' }).click();
    check('and back on', await subtitleShown(page, SUBTITLES.en), `${await subtitle(page)}`);
    check('still only drawn once', await nativeSubtitles(page) === 0);

    // The scrub bar: a quarter of the way into the third chapter, which starts at 25 s.
    const scrubTarget = async () => {
        const scrub = await page.locator('eva-scrub-bar .eva-chapter-marker').nth(2).boundingBox();
        return { x: scrub.x + scrub.width / 4, y: scrub.y + scrub.height / 2 };
    };
    let target = await scrubTarget();
    await page.mouse.move(target.x, target.y - 30);
    await page.mouse.move(target.x, target.y, { steps: 3 });
    await page.waitForTimeout(250);
    const tooltip = await page.locator('eva-scrub-bar .eva-hover-tooltip').innerText();
    check('hovering the scrub bar names the chapter under it', tooltip.includes('The long middle part'), tooltip.replace(/\n/g, ' '));
    await shoot(page, `${name}-scrub-hover`);
    target = await pointAt(page, scrubTarget, 'eva-scrub-bar');
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(300);
    const scrubbed = (await media(page)).time;
    check('clicking it seeks there', scrubbed > 29 && scrubbed < 34, `${scrubbed.toFixed(1)} s`);
    await page.waitForTimeout(300);
    check('and the bar names the chapter playing', (await page.locator('eva-active-chapter').innerText()).startsWith('The long middle'));

    await page.locator('eva-playback-speed').click();
    await page.waitForTimeout(300);
    await shoot(page, `${name}-speed-menu`);
    await page.locator('eva-playback-speed').getByRole('option', { name: '1.5x' }).click();
    check('the speed menu sets the rate', (await media(page)).rate === 1.5);
    check('and the button says so', (await page.locator('eva-playback-speed .speed-label').innerText()).trim() === '1.5x');
    await page.locator('eva-playback-speed').click();
    await page.locator('eva-playback-speed').getByRole('option', { name: 'Normal' }).click();
    check('and back to normal', (await media(page)).rate === 1);

    await page.locator('eva-active-chapter').click();
    await page.waitForTimeout(300);
    await shoot(page, `${name}-chapters`);
    await page.locator('eva-chapter-list').getByRole('listitem').filter({ hasText: 'Wrap-up' }).click();
    await page.waitForTimeout(300);
    check('the chapter list jumps to a chapter', Math.abs((await media(page)).time - 50) < 0.8, `${(await media(page)).time.toFixed(1)} s`);
    await page.locator('eva-chapter-list').getByRole('button', { name: 'Close chapter list' }).click();

    await page.mouse.move(x, y);
    await page.mouse.dblclick(x, y);
    await page.waitForTimeout(500);
    const fullscreen = await page.evaluate(() => document.fullscreenElement?.tagName ?? null);
    check('a double-click takes the whole player full screen', fullscreen === 'EVA-PLAYER', `${fullscreen}`);
    if (fullscreen) {
        await shoot(page, `${name}-fullscreen`);
        await page.keyboard.press('f');
        await page.waitForTimeout(500);
        check('and f leaves it', await page.evaluate(() => !document.fullscreenElement));
    }
    await page.waitForTimeout(600);
    if ((await media(page)).paused) await page.keyboard.press('Space');

    await page.mouse.move(x, y);
    await page.getByRole('button', { name: 'Theater mode' }).click();
    check('the bar\'s theater button hides the list', await page.locator('.player-playlist-section').isHidden());
    await page.keyboard.press('t');
    check('and t brings it back', await page.locator('.player-playlist-section').isVisible());

    await page.evaluate(() => { document.querySelector('video').volume = 0.4; });
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('eva-controls-container').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1000);
    const volume = (await media(page)).volume;
    check('the volume is remembered', Math.abs(volume - 0.4) < 0.01, `${volume}`);
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
    const second = await media(listed);
    check('in a playlist, Next plays the next file', second.src !== first_src && !second.paused);
    check('and there is no Next on the last one', await listed.getByRole('button', { name: 'Next', exact: true }).count() === 0);
    await listed.keyboard.press('Shift+N');
    check('shift+n does nothing there either', (await media(listed)).src === second.src);
    await listed.context().close();

    const looped = await newPage(browser, name, errors);
    await looped.addInitScript(() => localStorage.setItem('player_repeat_enabled', 'true'));
    await openPlaying(looped, `player;uid=${seeded.plain.uid};type=video`);
    check('with repeat on, the video loops', (await media(looped)).loop);
    await looped.context().close();

    const audio = await newPage(browser, name, errors);
    await audio.goto(`${BASE}/#/player;uid=${seeded.audio.uid};type=audio`, { waitUntil: 'domcontentloaded' });
    await audio.locator('video').waitFor({ timeout: 30_000 });
    await audio.waitForTimeout(500);
    check('an audio file keeps the browser\'s own bar', (await media(audio)).controls && await audio.locator('eva-controls-container').count() === 0);
    await audio.context().close();
}

async function onAPhone(browser, name, seeded, errors) {
    say(`${name}: a phone`);
    const page = await newPage(browser, `${name}-phone`, errors, { width: 412, height: 915 });
    await openPlaying(page, `player;uid=${seeded.chaptered.uid};type=video`);
    const { x, y } = await pointAt(page, () => centre(page), 'eva-overlay-play');
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(300);
    const tapped = await media(page);
    check('a tap on the picture pauses', tapped.paused, `at ${tapped.time.toFixed(1)} s`);
    check('with the controls up', await controlsShown(page));
    await shoot(page, `${name}-phone`);
    const bar = await page.locator('eva-controls-container').boundingBox();
    const player = await page.locator('eva-player').boundingBox();
    const last = await page.locator('eva-controls-container > :last-child').boundingBox();
    check('the bar fits the phone\'s width', bar.x >= player.x - 0.5 && last.x + last.width <= player.x + player.width + 0.5,
        `ends at ${Math.round(last.x + last.width)} of ${Math.round(player.x + player.width)}`);
    await page.locator('eva-play-pause').tap();
    await page.waitForTimeout(300);
    check('and its play button plays again', !(await media(page)).paused);
    await page.waitForTimeout(3500);
    check('the controls hide after a while', !(await controlsShown(page)));
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
