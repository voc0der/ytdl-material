// Drives the toolbar's notification bell and the panel it opens, end to end.
//
// A notification is the only part of the app that appears without anybody asking for it, and
// the panel is where the actions attached to one live: play what finished, retry what failed,
// look at the task that ran. None of that is reachable from a page, so this seeds the
// notifications a real run would have produced and works them the way a person would -- opens
// the bell, filters, acts, removes one, clears the rest -- checking what the backend recorded
// each time. It also checks the shape of the library cards behind it, which are the other half
// of what the home page looks like.
//
// Nothing is mocked: the frontend is built from the working tree and the backend runs from a
// throwaway copy (see stage.mjs). It downloads nothing from the network. Screenshots at a
// desktop and a phone width, light and dark, are left in the shots folder it prints.
//
// Usage: node notifications.mjs [--skip-build] [--keep]
//   --keep leaves the backend running with everything in place.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CACHE, HERE, buildFrontend, copyBackend, hasFrontendBuild, isListening, releaseBackend, say,
    startBackend, writeMigrationFlags
} from './stage.mjs';

const FIXTURES = join(HERE, 'fixtures');
const RUN_DIR = join(CACHE, 'notifications');
const SHOTS_DIR = join(RUN_DIR, 'shots');
// Beside the README capture's 17449, subscriptions' 17450, downloads' 17451, dialogs' 17452
// and settings' 17453.
const PORT = 17454;
const BASE = `http://localhost:${PORT}`;

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
    const hex = createHash('sha1').update(`ytdl-material-notifications:${id}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function storedNotifications() {
    const response = await fetch(`${BASE}/api/getNotifications`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    if (!response.ok) throw new Error(`/api/getNotifications answered ${response.status}`);
    return (await response.json())['notifications'] ?? [];
}

// The library the README capture uses, plus the notifications a run over it would have left:
// one of each kind, so every action the panel offers is on screen at once.
async function seed() {
    const library = JSON.parse(await readFile(join(FIXTURES, 'library.json'), 'utf8'));
    const downloaded = Date.parse(library.downloaded);
    const videoDir = join(RUN_DIR, 'video');
    await mkdir(videoDir, { recursive: true });
    await mkdir(join(RUN_DIR, 'appdata'), { recursive: true });

    const files = [];
    for (const [index, video] of library.videos.entries()) {
        const uid = stableUid(video.id);
        await writeFile(join(videoDir, `${video.id}.mp4`), '');
        await cp(join(FIXTURES, 'thumbnails', `${video.id}.jpg`), join(videoDir, `${video.id}.jpg`));
        files.push({
            id: video.id, title: video.title, thumbnailURL: `/api/thumbnail/${uid}`, isAudio: false,
            duration: video.duration, url: '', uploader: video.uploader, size: 0,
            path: `video/${video.id}.mp4`,
            upload_date: `${video.upload_date.slice(0, 4)}-${video.upload_date.slice(4, 6)}-${video.upload_date.slice(6, 8)}`,
            description: video.description, view_count: video.view_count, height: video.height, abr: null,
            source_id: null, source_extractor: null, duplicate_key: null, favorite: false,
            source_metadata_checked: true, thumbnailPath: `video/${video.id}.jpg`, uid,
            registered: downloaded - index * 60_000
        });
    }

    const now = Date.now() / 1000;
    const notifications = [
        {
            type: 'download_complete', actions: ['play'], read: false, uid: stableUid('complete'),
            timestamp: now - 90, user_uid: null,
            data: { file_uid: files[0].uid, file_title: files[0].title, file_thumbnail: files[0].thumbnailURL, original_url: '' }
        },
        {
            // A long one, because the row has to keep the actions on it whatever the text is.
            type: 'download_error', actions: ['view_download_error', 'retry_download'], read: false,
            uid: stableUid('error'), timestamp: now - 3600, user_uid: null,
            data: {
                download_uid: stableUid('download'),
                download_url: 'https://example.com/a-url-long-enough-to-need-truncating/watch?v=abcdefghijk',
                download_error_message: 'Unsupported URL'
            }
        },
        {
            type: 'task_finished', actions: ['view_tasks'], read: true, uid: stableUid('task'),
            timestamp: now - 86_400, user_uid: null,
            data: { task_key: 'missing_files_check', task_title: 'Verify all files are present', confirmed: false }
        }
    ];

    await writeFile(join(RUN_DIR, 'appdata', 'local_db.json'), JSON.stringify({ files, notifications }, null, 2));
    await writeMigrationFlags(RUN_DIR);
    return { files, notifications };
}

async function newPage(browser, device, errors, theme = 'dark') {
    const context = await browser.newContext({
        ...DEVICES[device],
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: theme === 'dark' ? 'dark' : 'light',
        reducedMotion: 'reduce'
    });
    await context.addInitScript(stored_theme => localStorage.setItem('theme', stored_theme), theme);
    const page = await context.newPage();
    page.on('console', message => {
        // The fixture videos are empty files -- enough for the library, not enough for the
        // player, which asks for a byte range there is nothing to answer with. Following a
        // notification to the player is worth checking; the missing media is not a finding.
        if (message.type() === 'error' && !message.text().includes('416')) {
            errors.push(`${device}/${theme}: ${message.text()}`);
        }
    });
    page.on('pageerror', error => errors.push(`${device}/${theme}: ${error.message}`));
    return page;
}

async function shoot(page, name) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const path = join(SHOTS_DIR, `${name}.png`);
    await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
    return path;
}

const bell = page => page.locator('mat-toolbar button:has(mat-icon:text-matches("^notifications"))').first();
const panel = page => page.locator('.notifications-panel');

async function openBell(page) {
    if (await panel(page).isVisible()) return;
    await bell(page).click();
    await panel(page).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(400);
}

// Escape rather than clicking away, so the menu's close handler runs either way.
async function closeBell(page) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
}

// Routing does not close an open menu, and its backdrop then swallows every click on the page
// behind it, so anything that navigates puts the menu away first -- as a person would.
async function goHome(page) {
    if (await page.locator('.cdk-overlay-backdrop').count() > 0) await closeBell(page);
    await page.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.locator('app-unified-file-card').first().waitFor({ timeout: 30_000 });
}

async function theBell(page, seeded) {
    say('Checking what the bell says before it is opened');
    await goHome(page);

    const unread = seeded.notifications.filter(notification => !notification.read).length;
    const badge = await bell(page).locator('.mat-badge-content').first().innerText();
    check('the bell counts what has not been read', badge.trim() === `${unread}`, badge.trim());
    check('and says so where a badge cannot be seen',
        (await bell(page).getAttribute('aria-label')).includes(`${unread}`), await bell(page).getAttribute('aria-label'));
}

async function thePanel(page, seeded) {
    say('Opening the panel');
    await openBell(page);
    check('every notification is in the panel',
        await page.locator('.notification-row').count() === seeded.notifications.length);

    const rows = page.locator('.notification-row');
    const first = rows.first();
    check('the newest is first', (await first.innerText()).includes(seeded.files[0].title.slice(0, 20)));
    check('what has not been read is marked', await rows.locator('.notification-dot').count() === 2);

    // A row is one fixed-height line of information, which is what lets the list virtualize.
    const overflowing = await rows.evaluateAll(elements => elements
        .filter(element => element.scrollWidth > element.clientWidth + 1).length);
    check('no row is wider than the panel', overflowing === 0);

    const actionsVisible = await rows.evaluateAll(elements => elements.every(element => {
        const actions = element.querySelector('.notification-actions');
        const panel_right = element.getBoundingClientRect().right;
        return actions.getBoundingClientRect().right <= panel_right + 1;
    }));
    check('and every row keeps its actions on it', actionsVisible);

    await shoot(page, 'notifications-open-desktop');
}

async function filtering(page) {
    say('Filtering by kind');
    const errors_chip = page.locator('.notifications-filters .kit-chip', { hasText: 'Download error' });
    await errors_chip.click();
    await page.waitForTimeout(300);

    check('picking a kind shows only that kind', await page.locator('.notification-row').count() === 1);
    check('and the chip says it is picked', await errors_chip.getAttribute('aria-pressed') === 'true');

    await errors_chip.click();
    await page.waitForTimeout(300);
    check('picking it again puts the rest back', await page.locator('.notification-row').count() === 3);
}

async function actingOnOne(page, seeded) {
    say('Following a notification to what it is about');
    await goHome(page);
    await openBell(page);
    const error_row = page.locator('.notification-row', { hasText: 'Download failed' });
    await error_row.getByRole('button', { name: 'View error' }).click();
    await page.waitForTimeout(600);
    check('the failed download opens the downloads page', page.url().includes('/downloads'), page.url().split('#')[1] ?? '');

    // Acting on one navigates but leaves the menu open, and its backdrop swallows every click
    // after that -- so the panel is closed before going anywhere else, as a person would.
    await closeBell(page);
    await goHome(page);
    await openBell(page);
    const complete_row = page.locator('.notification-row', { hasText: 'Finished downloading' }).first();
    await complete_row.getByRole('button', { name: 'Play' }).click();
    await page.waitForTimeout(600);
    check('and a finished download opens the player',
        page.url().includes('/player') && page.url().includes(seeded.files[0].uid), page.url().split('#')[1] ?? '');
    await closeBell(page);
}

async function removing(page) {
    say('Removing notifications');
    await goHome(page);
    await openBell(page);

    const before = (await storedNotifications()).length;
    await page.locator('.notification-row', { hasText: 'Task finished' }).getByRole('button', { name: 'Remove' }).click();
    await page.waitForTimeout(600);
    check('removing one takes it out of the panel', await page.locator('.notification-row').count() === before - 1);
    const stored = await storedNotifications();
    check('and out of the backend', stored.length === before - 1, `${stored.length} left`);

    await page.getByRole('button', { name: 'Clear all' }).click();
    await page.waitForTimeout(800);
    check('clearing empties the panel', (await panel(page).innerText()).includes('No notifications available'));
    check('and the backend', (await storedNotifications()).length === 0);
    await shoot(page, 'notifications-empty-desktop');

    await closeBell(page);
    await page.waitForTimeout(400);
    check('with nothing waiting the bell stops counting',
        await bell(page).locator('.mat-badge-content:visible').count() === 0);
}

// Closing the panel is what marks what was in it as read, so the count only survives a reload
// if that is still wired up.
async function readingMarksThemRead(browser, errors) {
    say('Checking that closing the panel marks what was in it read');
    const page = await newPage(browser, 'desktop', errors);
    await fetch(`${BASE}/api/getNotifications`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    await goHome(page);
    await openBell(page);
    await closeBell(page);

    const stored = await storedNotifications();
    check('nothing is left unread', stored.every(notification => notification.read), `${stored.length} stored`);
    await page.context().close();
}

// The other half of the home page: a card is a rounded thumbnail in a rounded card on a
// desktop, the same as the row a phone gets, rather than the square one it used to be.
async function theLibraryCards(page) {
    say('Checking the shape of the library cards');
    await goHome(page);

    const card = page.locator('app-unified-file-card .file-mat-card').first();
    const shape = await card.evaluate(element => {
        const thumbnail = element.querySelector('.image');
        return {
            card: getComputedStyle(element).borderTopLeftRadius,
            clipped: getComputedStyle(element).overflowX,
            thumbnail: getComputedStyle(thumbnail).borderTopLeftRadius
        };
    });
    check('the card has rounded corners', parseFloat(shape.card) >= 12, shape.card);
    check('and clips what is in them', shape.clipped === 'hidden', shape.clipped);
    check('the thumbnail is rounded too', parseFloat(shape.thumbnail) >= 8, shape.thumbnail);

    await shoot(page, 'notifications-library-desktop');
}

async function phoneAndLight(browser, errors) {
    say('Checking a phone width, and the light theme');
    const phone = await newPage(browser, 'phone', errors);
    await goHome(phone);
    await openBell(phone);

    const fits = await panel(phone).evaluate(element =>
        element.getBoundingClientRect().right <= window.innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1);
    check('the panel fits on a phone', fits);
    await shoot(phone, 'notifications-open-phone');
    await phone.context().close();

    const light = await newPage(browser, 'desktop', errors, 'light');
    await goHome(light);
    await openBell(light);
    await shoot(light, 'notifications-open-light');
    await light.context().close();
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

    say(`Staging the backend and the notifications in ${RUN_DIR}`);
    await rm(RUN_DIR, { recursive: true, force: true });
    await mkdir(SHOTS_DIR, { recursive: true });
    await copyBackend(RUN_DIR);
    const seeded = await seed();

    say(`Booting the backend on ${BASE}...`);
    const backend = await startBackend(RUN_DIR, PORT);

    const browser = await chromium.launch();
    const errors = [];
    try {
        check('the seeded notifications are what the backend serves',
            (await storedNotifications()).length === seeded.notifications.length);

        const page = await newPage(browser, 'desktop', errors);
        await theBell(page, seeded);
        await thePanel(page, seeded);
        await filtering(page);
        // While nothing has been read yet: closing the panel is what changes that, and the
        // other widths are worth capturing with the unread markers still on.
        await phoneAndLight(browser, errors);
        await readingMarksThemRead(browser, errors);
        await actingOnOne(page, seeded);
        await theLibraryCards(page);
        await removing(page);
        await page.context().close();

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
