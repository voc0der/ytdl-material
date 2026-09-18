// Drives the Download history dialog and the confirmation it opens, end to end.
//
// The history is the one screen that is only reachable as a dialog, and the only way to see
// whether removing, importing and exporting still work is to do them: they are three
// different endpoints and the dialog is what ties them together. So this seeds a history,
// opens the dialog the way a person would, filters and sorts it, removes everything through
// the confirmation, imports an archive file and exports one back out, checking what the
// backend recorded at each step. Screenshots at a desktop and a phone width, light and dark,
// are left in the shots folder it prints.
//
// Nothing is mocked: the frontend is built from the working tree and the backend runs from a
// throwaway copy (see stage.mjs). Unlike the other harnesses here it downloads nothing from
// the network, but it is still not part of CI -- it needs Playwright and a built frontend.
//
// Usage: node dialogs.mjs [--skip-build] [--keep]
//   --keep leaves the backend running with everything in place.

import { chromium } from 'playwright';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CACHE, buildFrontend, copyBackend, hasFrontendBuild, isListening, releaseBackend, say, sleep, startBackend,
    writeMigrationFlags
} from './stage.mjs';

const RUN_DIR = join(CACHE, 'dialogs');
const SHOTS_DIR = join(RUN_DIR, 'shots');
// Beside the README capture's 17449, the subscriptions harness's 17450 and downloads' 17451.
const PORT = 17452;
const BASE = `http://localhost:${PORT}`;

// More than the 25 the dialog puts on a page, so paging is reachable.
const HISTORY_COUNT = 28;
const AUDIO_COUNT = 6;

// What the import takes in: the "<extractor> <id>" lines an archive file is made of. An
// extractor name never has a space in it, because the space is what separates the two.
const IMPORT_LINES = ['a-site aaaaaaaaaaa', 'a-site bbbbbbbbbbb', 'another-site ccccccccccc'];

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

async function api(route, body = {}) {
    const response = await fetch(`${BASE}/api/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`/api/${route} answered ${response.status}`);
    return response.json();
}

async function storedHistory() {
    const { archives } = await api('getArchives', { type: null, sub_id: null });
    return archives ?? [];
}

async function waitFor(description, predicate, timeout_ms = 30_000) {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(300);
    }
    throw new Error(`timed out after ${timeout_ms / 1000}s waiting for ${description} (backend log: ${join(RUN_DIR, 'backend.log')})`);
}

// One history item per title, as addToArchive writes them, at fixed timestamps a day apart
// so the newest-first order and the dates on the rows are the same from run to run.
async function seedHistory() {
    const titles = [
        'Apollo 11 Moonwalk', 'Bennu Sample Return', 'Crew Dragon Tour', 'Deep Space Network',
        'Europa Clipper Assembly', 'First Light From Webb', 'Great Red Spot Flyby', 'Hubble Servicing Mission',
        'Ingenuity Takes Off', 'Juno Over Jupiter', 'Kennedy Launch Pad Tour', 'Lucy Meets Dinkinesh',
        'Mars Helicopter Flight 50', 'New Horizons At Pluto', 'Orion Splashdown', 'Perseverance Touchdown',
        'Quiet Supersonic Flight', 'Return To The Moon', 'Station Commander Tour', 'Total Eclipse Path',
        'Uranus In Infrared', 'Voyager Turns Forty', 'Webb Unfolds Its Mirror', 'X-59 Rolls Out',
        'Yearlong Mission Ends', 'Zero-G Daily Life', 'Artemis I Liftoff', 'Blue Marble Revisited'
    ].slice(0, HISTORY_COUNT);

    const start = Date.parse('2026-01-01T12:00:00Z') / 1000;
    const archives = titles.map((title, index) => ({
        extractor: index % 3 === 0 ? 'another-site' : 'a-site',
        id: `id-${String(index).padStart(3, '0')}`,
        type: index < AUDIO_COUNT ? 'audio' : 'video',
        title,
        user_uid: null,
        sub_id: null,
        timestamp: start + index * 86_400,
        uid: `seeded-${String(index).padStart(3, '0')}`
    }));

    await mkdir(join(RUN_DIR, 'appdata'), { recursive: true });
    await writeFile(join(RUN_DIR, 'appdata', 'local_db.json'), JSON.stringify({ archives }, null, 2));
    await writeMigrationFlags(RUN_DIR);
    return archives;
}

async function newPage(browser, device, errors, theme = 'dark') {
    const context = await browser.newContext({
        ...DEVICES[device],
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: theme === 'dark' ? 'dark' : 'light',
        reducedMotion: 'reduce',
        acceptDownloads: true
    });
    await context.addInitScript(stored_theme => localStorage.setItem('theme', stored_theme), theme);
    const page = await context.newPage();
    page.on('console', message => {
        if (message.type() === 'error') errors.push(`${device}: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`${device}: ${error.message}`));
    return page;
}

async function shoot(page, name) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const path = join(SHOTS_DIR, `${name}.png`);
    await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
    return path;
}

// The dialog is only reachable from the toolbar menu, which is the point of opening it there.
async function openHistory(page) {
    await page.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Download history' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Download history' });
    await dialog.waitFor({ timeout: 15_000 });
    return dialog;
}

async function theList(page, seeded) {
    say('Opening the history from the toolbar menu');
    const dialog = await openHistory(page);
    check('the menu item opens the history', await dialog.isVisible());

    const rows = dialog.locator('.history-row');
    await rows.first().waitFor({ timeout: 15_000 });
    check('a page holds 25 of them', await rows.count() === 25, `${await rows.count()} rows`);
    check('the count is of the whole history', (await dialog.locator('.history-count').innerText()).includes(`${seeded.length} items`),
        (await dialog.locator('.history-count').innerText()).trim());

    const newest = [...seeded].sort((left, right) => right.timestamp - left.timestamp)[0];
    check('the newest is first', (await rows.first().innerText()).includes(newest.title), newest.title);
    await shoot(page, 'history-list-desktop');

    const range = await dialog.locator('.pager-range').innerText();
    check('the pager counts the whole history', range.includes(`of ${seeded.length}`), range.trim());
    await dialog.getByRole('button', { name: 'Next page' }).click();
    await waitFor('the second page', async () => (await dialog.locator('.pager-range').innerText()).startsWith('26'));
    check('the last page ends on the last item', (await dialog.locator('.pager-range').innerText()).includes(`${seeded.length} of ${seeded.length}`));
    await dialog.getByRole('button', { name: 'Previous page' }).click();
    await waitFor('the first page again', async () => (await dialog.locator('.pager-range').innerText()).startsWith('1'));
    return dialog;
}

async function filteringAndSorting(page, dialog, seeded) {
    say('Filtering and sorting it');
    const rows = dialog.locator('.history-row');
    const search = dialog.getByPlaceholder('Search history');

    await search.fill('moonwalk');
    await waitFor('the search to narrow the list', async () => (await rows.count()) === 1);
    check('searching matches a title', (await rows.first().innerText()).includes('Apollo 11 Moonwalk'));

    await search.fill('id-004');
    await waitFor('the search to match an id', async () => (await rows.count()) === 1);
    check('searching matches an id', true);

    await search.fill('another-site');
    const bySource = await waitFor('the search to match a source', async () => (await rows.count()) || null);
    check('searching matches a source', bySource === seeded.filter(item => item.extractor === 'another-site').length, `${bySource} rows`);
    await shoot(page, 'history-search-desktop');

    await search.fill('nothing matches this');
    await dialog.getByText('Nothing matches').waitFor({ timeout: 10_000 });
    check('a search that matches nothing says so', true);
    await shoot(page, 'history-no-matches-desktop');
    await search.fill('');
    await waitFor('the whole list again', async () => (await rows.count()) === 25);

    await dialog.getByRole('button', { name: /^Sort/ }).click();
    await page.getByRole('menuitemradio', { name: 'Title' }).click();
    await waitFor('the first row to change', async () => (await rows.first().innerText()).includes('Apollo 11 Moonwalk'));
    check('sorting by title starts at the top of the alphabet', true);
    await dialog.getByRole('button', { name: /^Sort/ }).click();
    await page.getByRole('menuitemradio', { name: 'Newest first' }).click();
    await waitFor('the newest first again', async () => (await rows.count()) === 25);

    // The type filter is the server's, not the list's: it asks for a narrower history.
    await dialog.getByRole('button', { name: /^Type/ }).click();
    await page.getByRole('menuitemradio', { name: 'Audio', exact: true }).click();
    await waitFor('the audio-only history', async () => (await rows.count()) === AUDIO_COUNT);
    check('the type filter asks the server for one type', true, `${AUDIO_COUNT} audio items`);
    await dialog.getByRole('button', { name: /^Type/ }).click();
    await page.getByRole('menuitemradio', { name: 'Video and audio' }).click();
    await waitFor('both types again', async () => (await rows.count()) === 25);
}

async function removingThroughTheConfirmation(page, dialog, seeded) {
    say('Removing one item, then all of them');
    const rows = dialog.locator('.history-row');
    const remove = dialog.getByRole('button', { name: 'Remove' });
    check('there is nothing to remove until something is selected', await remove.isDisabled());

    await rows.first().locator('.history-row-button').click();
    check('one selected row says so', (await dialog.locator('.history-count').innerText()).includes('1 selected'));
    check('and can be removed', !(await remove.isDisabled()));
    await shoot(page, 'history-selected-desktop');

    await remove.click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Remove from history' });
    await confirm.waitFor({ timeout: 10_000 });
    const asked = (await confirm.locator('.dialog-text').innerText()).trim();
    check('removing asks first, about the one item', asked.startsWith('This item'), asked);
    await shoot(page, 'history-confirm-desktop');

    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'detached' }).catch(() => {});
    await sleep(500);
    check('cancelling removes nothing', (await storedHistory()).length === seeded.length, `${(await storedHistory()).length} left`);

    await dialog.getByRole('button', { name: 'Select all' }).click();
    check('Select all selects the whole history, not just the page',
        (await dialog.locator('.history-count').innerText()).includes(`${seeded.length} selected`),
        (await dialog.locator('.history-count').innerText()).trim());

    await dialog.getByRole('button', { name: 'Remove' }).click();
    const confirmAll = page.getByRole('dialog').filter({ hasText: 'Remove from history' });
    await confirmAll.waitFor({ timeout: 10_000 });
    await confirmAll.getByRole('button', { name: 'Remove' }).click();

    const emptied = await waitFor('the history to be emptied', async () => (await storedHistory()).length === 0);
    check('confirming removes every selected item from the database', !!emptied);
    await dialog.getByText('Your history is empty').waitFor({ timeout: 15_000 });
    check('an empty history says so', true);
    await shoot(page, 'history-empty-desktop');
}

async function importingAndExporting(page, dialog) {
    say('Importing an archive file, then exporting one back out');
    const file = join(RUN_DIR, 'archive-to-import.txt');
    await writeFile(file, `${IMPORT_LINES.join('\n')}\n`);

    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Choose a file' }).click();
    await (await chooser).setFiles(file);
    await dialog.locator('.import-file').waitFor({ timeout: 10_000 });
    check('the chosen file is named before it is imported', (await dialog.locator('.import-file-names').innerText()).includes('archive-to-import.txt'));
    await shoot(page, 'history-import-desktop');

    await dialog.getByRole('button', { name: 'Import' }).click();
    const imported = await waitFor('the import to be recorded', async () => {
        const stored = await storedHistory();
        return stored.length === IMPORT_LINES.length ? stored : null;
    });
    check('importing records one item per line', !!imported, `${imported.length} items`);
    check('and each keeps the source it came from', imported.some(item => item.extractor === 'another-site'));
    await dialog.locator('.history-row').first().waitFor({ timeout: 15_000 });
    check('the list shows them without reopening the dialog', await dialog.locator('.history-row').count() === IMPORT_LINES.length);

    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export' }).click();
    const saved = await download;
    const text = await readFile(await saved.path(), 'utf8');
    check('exporting names the file archive.txt', saved.suggestedFilename() === 'archive.txt', saved.suggestedFilename());
    check('and writes back what the archive file said',
        IMPORT_LINES.every(line => text.includes(line)), `${text.trim().split('\n').length} lines`);
}

// The two dialogs the Settings page opens that this pass rebuilt as well: the one that asks
// for a single value, and the one whose fields a toggle turns on.
async function theSettingsDialogs(page) {
    say('Opening the dialogs the Settings page holds');
    await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    await page.getByRole('tab', { name: 'Downloader' }).click();
    await page.getByRole('button', { name: 'Add category' }).click();
    const naming = page.getByRole('dialog').filter({ hasText: 'Name the category' });
    await naming.waitFor({ timeout: 10_000 });
    const add = naming.getByRole('button', { name: 'Add' });
    check('a dialog that asks for a value cannot be submitted empty', await add.isDisabled());
    await naming.getByRole('textbox').fill('Documentaries');
    check('and can be once it has one', !(await add.isDisabled()));
    await shoot(page, 'input-desktop');
    await naming.getByRole('button', { name: 'Cancel' }).click();
    await naming.waitFor({ state: 'detached' }).catch(() => {});

    await page.getByRole('tab', { name: 'Notifications' }).click();
    await page.getByRole('button', { name: 'Set Template' }).click();
    const webhook = page.getByRole('dialog').filter({ hasText: 'Webhook template' });
    await webhook.waitFor({ timeout: 10_000 });
    const title_template = webhook.getByRole('textbox').first();
    check('a template cannot be written until it is turned on', await title_template.isDisabled());
    await webhook.getByRole('switch').click();
    await waitFor('the templates to become writable', async () => !(await title_template.isDisabled()));
    check('and can be after the toggle', true);
    await shoot(page, 'webhook-template-desktop');
    await webhook.getByRole('button', { name: 'Cancel' }).click();
    await webhook.waitFor({ state: 'detached' }).catch(() => {});
}

async function phoneAndLight(browser, errors) {
    say('Capturing the phone and light layouts');
    const phone = await newPage(browser, 'phone', errors);
    const phoneDialog = await openHistory(phone);
    await phoneDialog.locator('.history-row').first().waitFor({ timeout: 15_000 });
    await shoot(phone, 'history-list-phone');
    // On a phone a picker opens a sheet rather than a menu, inside the dialog as anywhere else.
    await phoneDialog.getByRole('button', { name: /^Sort/ }).click();
    await phone.locator('app-picker-sheet').waitFor({ timeout: 10_000 });
    check('a picker in the dialog opens a sheet on a phone', true);
    await shoot(phone, 'history-sort-sheet-phone');
    await phone.keyboard.press('Escape');
    await phoneDialog.locator('.history-row').first().locator('.history-row-button').click();
    await phoneDialog.getByRole('button', { name: 'Remove' }).click();
    await phone.getByRole('dialog').filter({ hasText: 'Remove from history' }).waitFor({ timeout: 10_000 });
    await shoot(phone, 'history-confirm-phone');
    await phone.context().close();

    const light = await newPage(browser, 'desktop', errors, 'default');
    const lightDialog = await openHistory(light);
    await lightDialog.locator('.history-row').first().waitFor({ timeout: 15_000 });
    await shoot(light, 'history-list-light');
    await lightDialog.locator('.history-row').first().locator('.history-row-button').click();
    await lightDialog.getByRole('button', { name: 'Remove' }).click();
    await light.getByRole('dialog').filter({ hasText: 'Remove from history' }).waitFor({ timeout: 10_000 });
    await shoot(light, 'history-confirm-light');
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

    say(`Staging the backend and the history in ${RUN_DIR}`);
    await rm(RUN_DIR, { recursive: true, force: true });
    await mkdir(SHOTS_DIR, { recursive: true });
    await copyBackend(RUN_DIR);
    const seeded = await seedHistory();

    say(`Booting the backend on ${BASE}...`);
    const backend = await startBackend(RUN_DIR, PORT);

    const browser = await chromium.launch();
    const errors = [];
    try {
        check('the seeded history is what the backend serves', (await storedHistory()).length === seeded.length);

        const page = await newPage(browser, 'desktop', errors);
        const dialog = await theList(page, seeded);
        await filteringAndSorting(page, dialog, seeded);
        // Before the removal, so the other widths are captured with a history in them.
        await phoneAndLight(browser, errors);
        await removingThroughTheConfirmation(page, dialog, seeded);
        await importingAndExporting(page, dialog);
        await theSettingsDialogs(page);
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
