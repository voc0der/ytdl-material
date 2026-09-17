// Runs real downloads and real tasks through the Downloads and Tasks pages, end to end.
//
// Queues a small public playlist and a batch of downloads that cannot succeed, then works the
// Downloads page: its states, its progress, pause and resume, paging, the error a failed row
// shows, retrying and clearing. Then the Tasks page: what each task says about itself, running
// one, acting on what it found, and giving it a schedule from the panel on its card.
// Screenshots of each page, at a desktop and a phone width, are left in the shots folder it
// prints.
//
// Nothing is mocked: the frontend is built from the working tree, the backend runs from a
// throwaway copy (see stage.mjs), and yt-dlp downloads from the site. That is also why it is
// not part of CI -- it fails when the site does.
//
// Usage: node downloads.mjs [--skip-build] [--keep] [--url <playlist url>]
//   --keep leaves the backend running with everything in place.

import { chromium } from 'playwright';
import { mkdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CACHE, buildFrontend, copyBackend, hasFrontendBuild, isListening, releaseBackend, say, sleep, startBackend,
    writeMigrationFlags
} from './stage.mjs';

// The same four NASA videos the subscriptions harness uses: about 10 MB at 360p, and NASA
// publishes its material for free use. As one download it also gives the list a row with
// per-item progress behind it.
const DEFAULT_PLAYLIST = 'https://www.youtube.com/playlist?list=PL2aBZuCeDwlRBnr2rfhTkBHB-vRlWkiW9';

// Not a media page, so yt-dlp refuses it at once rather than retrying. Twelve of them fill
// more than one page without waiting for anything.
const DOOMED_URL = 'https://example.com/nothing-to-download';
const DOOMED_COUNT = 12;

const RUN_DIR = join(CACHE, 'downloads');
const SHOTS_DIR = join(RUN_DIR, 'shots');
// Beside the README capture's 17449 and the subscriptions harness's 17450.
const PORT = 17451;
const BASE = `http://localhost:${PORT}`;

const DEVICES = {
    desktop: { viewport: { width: 1280, height: 860 }, isMobile: false, hasTouch: false },
    phone: { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }
};

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok });
    const mark = ok ? '\x1b[0;32m✓\x1b[0m' : '\x1b[0;31m✗\x1b[0m';
    console.log(`    ${mark} ${name}${detail ? ` (${detail})` : ''}`);
}

async function api(route, body = {}) {
    const response = await fetch(`${BASE}/api/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`/api/${route} answered ${response.status}`);
    return response.json();
}

function argValue(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : process.argv[index + 1];
}

async function waitFor(description, predicate, timeout_ms = 60_000) {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(500);
    }
    throw new Error(`timed out after ${timeout_ms / 1000}s waiting for ${description} (backend log: ${join(RUN_DIR, 'backend.log')})`);
}

async function allDownloads() {
    const { downloads } = await api('downloads', { page: 0, page_size: 100 });
    return downloads ?? [];
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
        if (message.type() === 'error') errors.push(`${device}: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`${device}: ${error.message}`));
    return page;
}

async function open(page, route) {
    await page.goto(`${BASE}/#/${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
}

async function shoot(page, name) {
    // The app scrolls inside the sidenav rather than the document, so a full-page shot would
    // otherwise start wherever the last click left it.
    await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.querySelector('mat-sidenav-content')?.scrollTo(0, 0);
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const path = join(SHOTS_DIR, `${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled', caret: 'hide' });
    return path;
}

async function emptyPage(page) {
    say('Opening the Downloads page with nothing on it');
    await open(page, 'downloads');
    await page.getByText('Nothing downloaded yet').waitFor();
    check('an empty list says so', true);
    check('there is nothing to act on in bulk', await page.locator('.bulk-actions').count() === 0);
    await shoot(page, 'downloads-empty-desktop');
}

async function queueDoomed() {
    say('Queueing a batch of downloads that cannot succeed');
    for (let i = 0; i < DOOMED_COUNT; i++) {
        await api('downloadFile', { url: `${DOOMED_URL}?n=${i + 1}`, type: 'video', maxHeight: '360' });
    }
    const downloads = await allDownloads();
    check(`queued ${DOOMED_COUNT} downloads`, downloads.length === DOOMED_COUNT, `${downloads.length}`);
}

// Queued after the pausing, not before: pausing a download that is already running kills it
// mid-fetch, and the playlist download is the one this run needs to survive intact.
async function queuePlaylist(playlist_url) {
    say('Queueing the playlist');
    const { download } = await api('downloadFile', { url: playlist_url, type: 'video', maxHeight: '360' });
    if (!download) throw new Error('the playlist download was not created');
    return download;
}

async function pauseAndResume(page) {
    say('Pausing everything and letting one go again');
    await open(page, 'downloads');
    await page.locator('.download-row').first().waitFor();

    await page.getByRole('button', { name: 'Pause all' }).click();
    const paused = await waitFor('a download to pause', async () => {
        const downloads = await allDownloads();
        const stopped = downloads.filter(download => download.paused && !download.finished);
        return stopped.length > 0 ? stopped : null;
    });
    check('Pause all pauses what is still to come', paused.length > 0, `${paused.length} paused`);

    const paused_row = page.locator('.download-row[data-state="paused"]').first();
    await paused_row.waitFor({ timeout: 15_000 });
    check('a paused row says so', (await paused_row.locator('.download-status').innerText()).trim() === 'Paused');
    await shoot(page, 'downloads-paused-desktop');

    await paused_row.getByRole('button', { name: 'Resume' }).click();
    const resumed = await waitFor('the download to resume', async () => {
        const downloads = await allDownloads();
        return downloads.filter(download => download.paused && !download.finished).length < paused.length;
    }, 30_000);
    check('a row resumes on its own button', !!resumed);

    await page.getByRole('button', { name: 'Resume all' }).click();
    await waitFor('everything to resume', async () => {
        const downloads = await allDownloads();
        return downloads.every(download => !download.paused || download.finished);
    }, 30_000);
    check('Resume all lets the rest go', true);
}

async function watchThePlaylistFinish(page, playlist_download) {
    say('Waiting for the playlist download');
    const finished = await waitFor('the playlist download to finish', async () => {
        const downloads = await allDownloads();
        const download = downloads.find(entry => entry.uid === playlist_download.uid);
        return download?.finished ? download : null;
    }, 300_000);
    check('the playlist downloaded', !finished.error, finished.error ?? 'no error');

    await open(page, 'downloads');
    const row = page.locator('.download-row[data-state="finished"]').first();
    await row.waitFor({ timeout: 30_000 });
    check('a finished row says Complete', (await row.locator('.download-status').innerText()).trim() === 'Complete');

    const items = row.locator('.download-items');
    if (await items.count() > 0) {
        check('a playlist row counts its items', /\d+ items/.test(await items.innerText()), (await items.innerText()).trim());
        await items.click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor({ timeout: 10_000 });
        check('the item count opens per-item progress', await dialog.isVisible());
        await shoot(page, 'downloads-playlist-progress-desktop');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' }).catch(() => {});
    } else {
        check('a playlist row counts its items', false, 'no item progress was recorded');
    }
    return finished;
}

async function failuresAndRetry(page) {
    say('Letting the doomed downloads fail');
    await waitFor('every download to settle', async () => {
        const downloads = await allDownloads();
        return downloads.every(download => download.finished);
    }, 240_000);

    await open(page, 'downloads');
    const failed_row = page.locator('.download-row[data-state="failed"]').first();
    await failed_row.waitFor({ timeout: 30_000 });
    const summary = (await failed_row.locator('.download-error').innerText()).trim();
    check('a failed row shows why, on one line', summary.length > 0 && !summary.includes('\n'), summary.slice(0, 60));
    await shoot(page, 'downloads-failed-desktop');

    await failed_row.locator('.download-error').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 10_000 });
    check('the failure opens in full', (await dialog.innerText()).includes(summary.slice(0, 20)));
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' }).catch(() => {});

    // A restart clears the old download and queues a new one, so the count stays put and the
    // uids are what change.
    const before = (await allDownloads()).filter(download => download.error).map(download => download.uid);
    await page.getByRole('button', { name: 'Retry failed' }).click();
    const restarted = await waitFor('the failures to be restarted', async () => {
        const uids = new Set((await allDownloads()).map(download => download.uid));
        return before.every(uid => !uids.has(uid));
    }, 60_000);
    check('Retry failed starts them again', !!restarted, `${before.length} restarted`);
}

async function paging(page) {
    say('Paging through the list');
    await waitFor('every download to settle again', async () => {
        const downloads = await allDownloads();
        return downloads.every(download => download.finished);
    }, 240_000);

    await open(page, 'downloads');
    await page.locator('.download-row').first().waitFor();
    await page.getByRole('button', { name: /^Per page/ }).click();
    await page.getByRole('menuitemradio', { name: '10' }).click();

    await waitFor('the first page of ten', async () => (await page.locator('.download-row').count()) === 10, 30_000);
    const total = (await allDownloads()).length;
    check('ten rows on a page of ten', true);
    check('the pager counts the whole list', (await page.locator('.pager-range').innerText()).includes(`of ${total}`), (await page.locator('.pager-range').innerText()).trim());
    check('there is no page before the first', await page.getByRole('button', { name: 'Previous page' }).isDisabled());
    await shoot(page, 'downloads-list-desktop');

    const next = page.getByRole('button', { name: 'Next page' });
    await next.click();
    await waitFor('the second page', async () => (await page.locator('.pager-range').innerText()).startsWith('11'), 30_000);
    check('the next page starts where the first left off', true, (await page.locator('.pager-range').innerText()).trim());
    check('there is a page to go back to', !(await page.getByRole('button', { name: 'Previous page' }).isDisabled()));

    // However many pages the retries left behind, the last one ends on the last download.
    for (let i = 0; i < 20 && !(await next.isDisabled()); i++) {
        const range = await page.locator('.pager-range').innerText();
        await next.click();
        await waitFor('the next page', async () => (await page.locator('.pager-range').innerText()) !== range, 30_000);
    }
    check('the last page ends on the last download', (await page.locator('.pager-range').innerText()).includes(`${total} of ${total}`), (await page.locator('.pager-range').innerText()).trim());

    await page.getByRole('button', { name: 'Previous page' }).click();
    check('and back again', !(await page.getByRole('button', { name: 'Next page' }).isDisabled()));
}

async function clearing(page) {
    say('Clearing the failures');
    await open(page, 'downloads');
    await page.getByRole('button', { name: 'Clear…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByText('Errored downloads').click();
    await shoot(page, 'downloads-clear-desktop');
    await dialog.getByRole('button', { name: 'Clear' }).click();

    const cleared = await waitFor('the failures to go', async () => {
        const downloads = await allDownloads();
        return downloads.every(download => !download.error) ? downloads : null;
    }, 60_000);
    check('clearing removes only what was asked for', cleared.length > 0, `${cleared.length} left`);
}

async function tasksPage(page) {
    say('Opening the Tasks page');
    await open(page, 'tasks');
    const cards = page.locator('.task-card');
    await cards.first().waitFor({ timeout: 30_000 });

    const { tasks } = await api('getTasks');
    check('every task has a card', await cards.count() === tasks.length, `${await cards.count()} of ${tasks.length}`);

    const described = await page.locator('.task-description').evaluateAll(nodes => nodes.filter(node => node.textContent.trim().length > 0).length);
    check('every card says what its task is for', described === tasks.length, `${described} of ${tasks.length}`);
    await shoot(page, 'tasks-desktop');

    return tasks;
}

async function runATaskThatFindsSomething(page) {
    say('Making a file go missing, then finding it from the page');
    const { files } = await api('getAllFiles');
    const file = files?.[0];
    if (!file) throw new Error('no downloaded file to work with');
    await unlink(join(RUN_DIR, file.path));

    const card = page.locator('.task-card', { hasText: 'Missing files check' });
    await card.getByRole('button', { name: 'Run now' }).click();

    await waitFor('the check to find the missing file', async () => {
        const { tasks } = await api('getTasks');
        const task = tasks.find(entry => entry.key === 'missing_files_check');
        return task?.data?.uids?.length > 0;
    }, 60_000);

    const confirm = card.getByRole('button', { name: /^Remove \d+ from the database$/ });
    await confirm.waitFor({ timeout: 15_000 });
    check('the card offers to act on what the run found', true, (await confirm.innerText()).trim());
    check('the card says when it last ran', (await card.locator('.task-status').innerText()).trim().startsWith('Ran'));
    await shoot(page, 'tasks-pending-desktop');

    const before = (await api('getAllFiles')).files.length;
    await confirm.click();
    const removed = await waitFor('the missing file to be dropped', async () => (await api('getAllFiles')).files.length < before, 60_000);
    check('acting on it removes the record', !!removed);
    await confirm.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    check('and the offer goes away once there is nothing left to do', await confirm.count() === 0);
}

async function scheduleATask(page) {
    say('Giving a task a schedule from its own card');
    const card = page.locator('.task-card', { hasText: 'Backup DB' });
    check('an unscheduled task says so', (await card.innerText()).includes('Runs only when you run it'));

    await card.getByRole('button', { name: 'Schedule & options' }).click();
    const panel = card.locator('.task-settings-panel');
    await panel.waitFor();
    check('Save waits for a change', await panel.getByRole('button', { name: 'Save' }).isDisabled());

    await panel.getByRole('button', { name: /^Repeat/ }).click();
    await page.getByRole('menuitemradio', { name: 'Weekly' }).click();
    await shoot(page, 'tasks-schedule-desktop');
    await panel.getByRole('button', { name: 'Save' }).click();

    await panel.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    check('saving closes the panel', await panel.count() === 0);

    const saved = await waitFor('the schedule to be saved', async () => {
        const { tasks } = await api('getTasks');
        return tasks.find(entry => entry.key === 'backup_local_db')?.schedule ?? null;
    }, 30_000);
    check('the schedule reached the backend', saved.type === 'recurring' && Array.isArray(saved.data.dayOfWeek), JSON.stringify(saved.data));

    await waitFor('the card to show the next run', async () => (await card.innerText()).includes('Next'), 30_000);
    check('the card says when it runs next', true);

    await card.getByRole('button', { name: 'Schedule & options' }).click();
    await panel.waitFor();
    check('reopening reads back what was saved', (await panel.getByRole('button', { name: /^Repeat/ }).innerText()).includes('Weekly'));

    await panel.getByRole('button', { name: /^Repeat/ }).click();
    await page.getByRole('menuitemradio', { name: 'Off' }).click();
    await panel.getByRole('button', { name: 'Save' }).click();
    await waitFor('the schedule to be removed', async () => {
        const { tasks } = await api('getTasks');
        return tasks.find(entry => entry.key === 'backup_local_db')?.schedule === null;
    }, 30_000);
    check('and turning it off removes it again', true);
}

async function capturePhoneAndLight(browser, errors) {
    say('Capturing the phone and light layouts');
    const phone = await newPage(browser, 'phone', errors);
    await open(phone, 'downloads');
    await phone.locator('.download-row').first().waitFor({ timeout: 30_000 });
    check('a phone row hides the button rail behind a menu', await phone.locator('.download-actions').first().isHidden());
    await shoot(phone, 'downloads-list-phone');
    await phone.locator('.download-row').first().getByRole('button', { name: 'More actions' }).click();
    await shoot(phone, 'downloads-row-menu-phone');
    await phone.keyboard.press('Escape');

    await open(phone, 'tasks');
    await phone.locator('.task-card').first().waitFor({ timeout: 30_000 });
    await shoot(phone, 'tasks-phone');
    await phone.locator('.task-card').first().getByRole('button', { name: 'Schedule & options' }).click();
    await phone.locator('.task-settings-panel').waitFor();
    await shoot(phone, 'tasks-schedule-phone');
    await phone.context().close();

    const light = await newPage(browser, 'desktop', errors, 'default');
    await open(light, 'downloads');
    await light.locator('.download-row').first().waitFor({ timeout: 30_000 });
    await shoot(light, 'downloads-list-light');
    await open(light, 'tasks');
    await light.locator('.task-card').first().waitFor({ timeout: 30_000 });
    await shoot(light, 'tasks-light');
    await light.context().close();
}

async function main() {
    const keep = process.argv.includes('--keep');
    const skipBuild = process.argv.includes('--skip-build');
    const playlist_url = argValue('--url') ?? DEFAULT_PLAYLIST;

    if (await isListening(BASE)) {
        throw new Error(`something is already listening on ${BASE}. If it is a --keep run, stop it with: kill -- -$(cat ${join(RUN_DIR, 'backend.pid')})`);
    }

    if (!skipBuild || !hasFrontendBuild()) {
        await buildFrontend();
    }

    say(`Staging the backend in ${RUN_DIR}`);
    await rm(RUN_DIR, { recursive: true, force: true });
    await mkdir(SHOTS_DIR, { recursive: true });
    await copyBackend(RUN_DIR);
    await writeMigrationFlags(RUN_DIR);

    say(`Booting the backend on ${BASE}...`);
    const backend = await startBackend(RUN_DIR, PORT, {
        // No Deno is assumed; yt-dlp can use the Node running this script instead.
        ytdl_js_runtimes: 'node',
        // One at a time, so the rest of the batch is reliably still queued to pause.
        // The shipped appdata/default.json says 0, which starts no downloads at all.
        ytdl_max_concurrent_downloads: '1'
    });

    const browser = await chromium.launch();
    const errors = [];
    try {
        const page = await newPage(browser, 'desktop', errors);
        await emptyPage(page);
        await queueDoomed();
        await pauseAndResume(page);
        const playlist_download = await queuePlaylist(playlist_url);
        await watchThePlaylistFinish(page, playlist_download);
        await failuresAndRetry(page);
        await paging(page);
        await clearing(page);
        await tasksPage(page);
        await runATaskThatFindsSomething(page);
        await scheduleATask(page);
        await capturePhoneAndLight(browser, errors);

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
