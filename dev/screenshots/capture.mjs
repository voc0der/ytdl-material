// Regenerates docs/images/readme-home.png.
//
// The screenshot is of the real app, not a mock: the frontend is built from the working
// tree and served by the real backend. Only the library is staged. The backend runs from
// a copy under the cache dir, so its working directory -- which is where it keeps
// appdata/ and the media folders -- is throwaway, and the copy is what lets it serve a
// build that did not overwrite backend/public.
//
// The library is written straight into the local database rather than imported, because
// importing stamps each file with the time it was imported and the card shows that date.
// Fixed dates are what make re-running produce the same PNG.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
    CACHE, HERE, REPO_ROOT, buildFrontend, copyBackend, hasFrontendBuild, isListening,
    releaseBackend, say, startBackend, writeMigrationFlags
} from './stage.mjs';

const FIXTURES = join(HERE, 'fixtures');
const OUTPUT = join(REPO_ROOT, 'docs', 'images', 'readme-home.png');
const RUN_DIR = join(CACHE, 'run');

// Not 17442, so a dev backend left running on the default port is neither reused nor
// in the way.
const PORT = 17449;
const BASE = `http://localhost:${PORT}`;

// Four cards to a row at 1.25x, which is the framing the README image has always had:
// 1330px wide, displayed at 1000.
const VIEWPORT = { width: 1064, height: 900 };
const SCALE = 1.25;

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

    await writeMigrationFlags(RUN_DIR);

    return library;
}

async function capture(library) {
    const videoCount = library.videos.length;
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
        // The chip the README image has always shown selected, and the library sorted by
        // Upload Date, newest first.
        await context.addInitScript(() => {
            localStorage.setItem('file_filter', JSON.stringify(['video_only']));
            localStorage.setItem('sort_property', 'upload_date');
            localStorage.setItem('media_library_sort_order', 'descending');
        });
        // Sorted by upload date, each card says how long ago its video went up, counted from
        // now. Holding now at the day the library was downloaded keeps that text, and the
        // PNG, the same from one run to the next.
        await context.clock.setFixedTime(library.downloaded);

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

    if (await isListening(BASE)) {
        throw new Error(`something is already listening on ${BASE}. If it is a --keep run, stop it with: kill -- -$(cat ${join(RUN_DIR, 'backend.pid')})`);
    }

    if (!skipBuild || !hasFrontendBuild()) {
        await buildFrontend();
    }

    say(`Staging the backend and library in ${RUN_DIR}`);
    await rm(RUN_DIR, { recursive: true, force: true });
    await mkdir(RUN_DIR, { recursive: true });
    await copyBackend(RUN_DIR);
    const library = await seedLibrary();

    say(`Booting the backend on ${BASE}...`);
    const backend = await startBackend(RUN_DIR, PORT);

    try {
        say('Capturing the home page...');
        const { clip, errors } = await capture(library);
        console.log(`    ${relative(REPO_ROOT, OUTPUT)} (${Math.round(clip.width * SCALE)}x${Math.round(clip.height * SCALE)})`);
        for (const error of errors) {
            console.log(`    page console error: ${error.slice(0, 200)}`);
        }
    } finally {
        await releaseBackend(backend, keep, BASE);
    }
}

try {
    await main();
} catch (error) {
    console.error(`\x1b[0;31m==>\x1b[0m ${error.message}`);
    process.exitCode = 1;
}
