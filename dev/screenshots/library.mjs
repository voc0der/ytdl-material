// Drives the playlist editor and the Duplicates page, end to end.
//
// Both are the library's own tools and both only show what they do against a library: the
// editor picks from every file there is and puts them in order, and the duplicates page deletes
// the copies it finds. So this stages one -- the README's NASA videos and their playlists, plus
// a few of those videos downloaded again -- and works both pages the way a person would,
// checking what the backend recorded each time.
//
// It exists because of NG0919: the editor once embedded the media library that opens it, the two
// imported each other, and the production bundle evaluated the editor first. New playlist then
// opened an empty dialog, but only in a production build -- the dev server and the unit tests
// evaluate modules in an order where both are defined. Nothing short of a production build in a
// browser catches that class of bug, so that is what this runs.
//
// Nothing is mocked: the frontend is built from the working tree and the backend runs from a
// throwaway copy (see stage.mjs). It downloads nothing. Screenshots at a desktop and a phone
// width, light and dark, are left in the shots folder it prints.
//
// Usage: node library.mjs [--skip-build] [--keep]
//   --keep leaves the backend running with everything in place.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CACHE, HERE, buildFrontend, copyBackend, hasFrontendBuild, isListening, releaseBackend, say,
    startBackend, writeMigrationFlags
} from './stage.mjs';

const FIXTURES = join(HERE, 'fixtures');
const RUN_DIR = join(CACHE, 'library');
const SHOTS_DIR = join(RUN_DIR, 'shots');
// Beside the README capture's 17449, subscriptions' 17450, downloads' 17451, dialogs' 17452,
// settings' 17453 and notifications' 17454.
const PORT = 17455;
const BASE = `http://localhost:${PORT}`;

const DEVICES = {
    desktop: { viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false },
    phone: { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }
};

// Videos downloaded more than once, and how many extra times. One is cleaned up keeping the
// first download and the other keeping the latest, so both directions are checked.
const DOWNLOADED_AGAIN = { 'apollo-11-moonwalk': 2, 'jupiter-great-red-spot': 1 };

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok });
    const mark = ok ? '\x1b[0;32m✓\x1b[0m' : '\x1b[0;31m✗\x1b[0m';
    console.log(`    ${mark} ${name}${detail ? ` (${detail})` : ''}`);
}

function stableUid(id) {
    const hex = createHash('sha1').update(`ytdl-material-library:${id}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function api(route, body = {}) {
    const response = await fetch(`${BASE}/api/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`/api/${route} answered ${response.status}`);
    return response.json();
}

const storedPlaylists = async () => (await api('getPlaylists'))['playlists'] ?? [];
const storedFiles = async () => (await api('getAllFiles'))['files'] ?? [];
const storedDuplicates = async () => (await api('getDuplicates'))['duplicates'] ?? [];

// The README library, with its playlists, and a second and third download of some of it. Every
// file carries the duplicate key a real download is given, which is what the page groups on.
async function seed() {
    const library = JSON.parse(await readFile(join(FIXTURES, 'library.json'), 'utf8'));
    const downloaded = Date.parse(library.downloaded);
    const videoDir = join(RUN_DIR, 'video');
    await mkdir(videoDir, { recursive: true });
    await mkdir(join(RUN_DIR, 'appdata'), { recursive: true });

    const record = async (video, index, suffix = '', registered = downloaded - index * 60_000) => {
        const name = `${video.id}${suffix}`;
        const uid = stableUid(name);
        // Empty, but there: cleaning up deletes the file, and a file that is not there to delete
        // counts as a failure.
        await writeFile(join(videoDir, `${name}.mp4`), '');
        await cp(join(FIXTURES, 'thumbnails', `${video.id}.jpg`), join(videoDir, `${name}.jpg`));
        return {
            id: video.id, title: video.title, thumbnailURL: `/api/thumbnail/${uid}`, isAudio: false,
            duration: video.duration, url: '', uploader: video.uploader, size: 0,
            path: `video/${name}.mp4`,
            upload_date: `${video.upload_date.slice(0, 4)}-${video.upload_date.slice(4, 6)}-${video.upload_date.slice(6, 8)}`,
            description: video.description, view_count: video.view_count, height: video.height, abr: null,
            source_id: video.id, source_extractor: 'generic', duplicate_key: `generic:${video.id}:video`,
            favorite: false, source_metadata_checked: true, thumbnailPath: `video/${name}.jpg`, uid,
            registered
        };
    };

    const files = [];
    for (const [index, video] of library.videos.entries()) {
        files.push(await record(video, index));
        for (let copy = 1; copy <= (DOWNLOADED_AGAIN[video.id] ?? 0); copy++) {
            // Days later, so the first download is unambiguously the original.
            files.push(await record(video, index, ` (${copy})`, downloaded + copy * 86_400_000));
        }
    }

    const byId = new Map(files.filter(file => !file.path.includes(' (')).map(file => [file.id, file]));
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
    return { library, files, playlists };
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
        if (message.type() === 'error') errors.push(`${device}/${theme}: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`${device}/${theme}: ${error.message}`));
    return page;
}

async function shoot(page, name) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

const editor = page => page.locator('app-create-playlist');
const fileRow = (page, title) => editor(page).locator('.file-row', { hasText: title }).first();
const orderTitles = page => editor(page).locator('.order-row .file-title').allInnerTexts();

async function goToPlaylists(page) {
    await page.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.locator('.library-switch', { hasText: 'Playlists' }).click();
    await page.locator('app-unified-file-card').first().waitFor({ timeout: 30_000 });
}

async function openNewPlaylist(page) {
    await goToPlaylists(page);
    await page.locator('.playlist-shortcut-action').click();
    await editor(page).locator('.playlist-controls').waitFor({ timeout: 10_000 });
    await editor(page).locator('.file-row').first().waitFor({ timeout: 10_000 });
}

// The CDK starts a drag only once the pointer has moved a few pixels with the button held, so
// this moves in steps the way a hand would rather than jumping to the target.
async function drag(page, from, to) {
    const start = await from.boundingBox();
    const end = await to.boundingBox();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 - 8, { steps: 4 });
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2 - 6, { steps: 16 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(400);
}

async function creatingOne(page, seeded) {
    say('Creating a playlist from New playlist');
    await openNewPlaylist(page);

    const title = (await editor(page).locator('.dialog-title').innerText()).trim();
    check('New playlist opens the editor, not an empty surface', title === 'Create a playlist', title);
    check('it starts on the library', await editor(page).locator('.list-filter-option.active').innerText().then(text => text.startsWith('Library')));

    const surface = await page.locator('.mat-mdc-dialog-surface').boundingBox();
    check('the dialog is dialog-sized rather than the whole window',
        surface.width <= 720 && surface.height <= 760 && surface.y >= 16, `${Math.round(surface.width)}x${Math.round(surface.height)}`);

    const rows = await editor(page).locator('.file-row').count();
    check('every file in the library is there to pick from', rows === seeded.files.length, `${rows} of ${seeded.files.length}`);

    // The list scrolls under the name, the tabs and the search, which stay where they are.
    const controls_before = await editor(page).locator('.playlist-controls').boundingBox();
    const content = editor(page).locator('.playlist-content');
    const scrollable = await content.evaluate(element => element.scrollHeight > element.clientHeight);
    await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForTimeout(200);
    const controls_after = await editor(page).locator('.playlist-controls').boundingBox();
    check('only the list scrolls', scrollable && Math.abs(controls_before.y - controls_after.y) < 1);
    await content.evaluate(element => { element.scrollTop = 0; });
    await shoot(page, 'playlist-create-desktop');

    await editor(page).locator('.playlist-search input').fill('apollo');
    await page.waitForTimeout(200);
    const matching = await editor(page).locator('.file-row').count();
    const apollo_files = seeded.files.filter(file => /apollo/i.test(file.title)).length;
    check('searching narrows the list', matching === apollo_files, `${matching} match`);
    await editor(page).locator('.playlist-search input').fill('');
    await page.waitForTimeout(200);

    // Titles there is one copy of, so the row picked is the file expected.
    const picks = [
        'Apollo 13: ‘Houston',
        'STS-129 HD Launch',
        'Waking up, working'
    ];
    for (const pick of picks) await fileRow(page, pick).click();
    check('a picked row says it is picked', await fileRow(page, picks[0]).getAttribute('aria-checked') === 'true');
    const tab_count = (await editor(page).locator('.list-filter-option', { hasText: 'In playlist' }).innerText()).replace(/\D+/g, '');
    check('the playlist tab counts them', tab_count === '3', tab_count);
    const subtitle = await editor(page).locator('.dialog-subtitle').innerText();
    check('and the heading adds up how long they run', /3 files · 35:42/.test(subtitle), subtitle);

    const create = editor(page).locator('.dialog-actions .kit-primary');
    check('it cannot be created without a name', await create.isDisabled());
    await editor(page).locator('.playlist-controls .dialog-field input').fill('Harness picks');
    check('and can once it has one', await create.isEnabled());

    await editor(page).locator('.list-filter-option', { hasText: 'In playlist' }).click();
    const order = await orderTitles(page);
    check('the playlist is in the order the files were picked', picks.every((pick, index) => order[index]?.startsWith(pick.slice(0, 12))));
    await shoot(page, 'playlist-order-desktop');

    await create.click();
    await editor(page).waitFor({ state: 'detached', timeout: 10_000 });
    check('creating it closes the editor', await editor(page).count() === 0);

    const created = (await storedPlaylists()).find(playlist => playlist.name === 'Harness picks');
    const expected = picks.map(pick => seeded.files.find(file => file.title.startsWith(pick.slice(0, 12))).uid);
    check('the backend has it, in that order', created && JSON.stringify(created.uids) === JSON.stringify(expected));
    await page.waitForTimeout(800);
    check('and the library shows it without a reload',
        await page.locator('app-unified-file-card', { hasText: 'Harness picks' }).count() === 1);
    return created;
}

async function editingOne(page, seeded, created) {
    say('Editing it: reordering, removing, renaming');
    const card = page.locator('app-unified-file-card', { hasText: 'Harness picks' }).first();
    await card.locator('button[aria-label="More actions"]').click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await editor(page).locator('.order-row').first().waitFor({ timeout: 10_000 });

    check('editing opens on what is in the playlist', (await editor(page).locator('.dialog-title').innerText()).includes('Edit playlist'));
    check('with its name filled in', await editor(page).locator('.playlist-controls .dialog-field input').inputValue() === 'Harness picks');
    const save = editor(page).locator('.dialog-actions .kit-primary');
    check('and nothing to save yet', await save.isDisabled());

    const before = await orderTitles(page);
    const handles = editor(page).locator('.order-handle');
    await drag(page, handles.nth(2), handles.nth(0));
    const dragged = await orderTitles(page);
    check('dragging the last row to the top moves it there', dragged[0] === before[2] && dragged[1] === before[0], dragged.map(title => title.slice(0, 12)).join(' / '));

    await handles.nth(0).focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    const keyed = await orderTitles(page);
    check('the arrow keys move a row too', keyed[0] === dragged[1] && keyed[1] === dragged[0]);
    const focused = await page.evaluate(() => document.activeElement?.closest('.order-row')?.querySelector('.file-title')?.textContent?.trim());
    check('and focus goes with it', focused === dragged[0], focused?.slice(0, 20));

    await editor(page).locator('.order-row').nth(2).locator('button[aria-label="Remove from playlist"]').click();
    const kept = await orderTitles(page);
    check('removing a row takes it out', kept.length === 2 && !kept.includes(keyed[2]));

    await editor(page).getByRole('button', { name: 'Reverse' }).click();
    const reversed = await orderTitles(page);
    check('reverse turns the order around', reversed[0] === kept[1] && reversed[1] === kept[0]);

    await editor(page).locator('.playlist-controls .dialog-field input').fill('Harness picks, edited');
    check('with changes there is something to save', await save.isEnabled());
    await shoot(page, 'playlist-edit-desktop');
    await save.click();
    await editor(page).waitFor({ state: 'detached', timeout: 10_000 });

    const stored = (await storedPlaylists()).find(playlist => playlist.id === created.id);
    const titleOf = uid => seeded.files.find(file => file.uid === uid)?.title;
    check('the backend has the new name', stored?.name === 'Harness picks, edited', stored?.name);
    check('and the new order', JSON.stringify(stored?.uids.map(titleOf)) === JSON.stringify(reversed));
}

async function editorOnAPhone(browser, errors, theme) {
    const page = await newPage(browser, 'phone', errors, theme);
    await openNewPlaylist(page);
    const fits = await page.locator('.mat-mdc-dialog-surface').evaluate(surface => {
        const box = surface.getBoundingClientRect();
        const dialog = surface.querySelector('.kit-dialog');
        return box.left >= 0 && box.right <= window.innerWidth && dialog.scrollWidth <= dialog.clientWidth + 1;
    });
    await fileRow(page, 'STS-129').click();
    const rowsFit = await editor(page).locator('.file-row').evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth + 1));
    await shoot(page, `playlist-create-phone-${theme}`);
    await page.context().close();
    return fits && rowsFit;
}

async function theDuplicatesPage(page, seeded) {
    say('Cleaning up duplicates');
    await page.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    const nav = page.locator('a[href*="duplicates"], a[routerlink="/duplicates"]');
    // The drawer is closed on a narrow window and open on this one; either way the link is in it.
    check('the navigation offers Duplicates while there are some', await nav.count() > 0);

    await page.goto(`${BASE}/#/duplicates`, { waitUntil: 'domcontentloaded' });
    await page.locator('.duplicate-row').first().waitFor({ timeout: 20_000 });

    const groups = Object.keys(DOWNLOADED_AGAIN).length;
    const extra = Object.values(DOWNLOADED_AGAIN).reduce((total, count) => total + count, 0);
    check('it has a heading', (await page.locator('.page-title').innerText()).trim() === 'Duplicates');
    check('every file downloaded more than once has a row', await page.locator('.duplicate-row').count() === groups);
    const summary = await page.locator('.duplicates-summary').innerText();
    check('the summary says how many and how many copies would go',
        summary.includes(`${groups} files downloaded more than once`) && summary.includes(`${extra} extra copies`), summary);

    const cleanUp = page.locator('.duplicate-row', { hasText: 'Apollo 11' }).locator('.duplicate-actions .kit-chip');
    check('cleaning up is a labelled button, not a bare icon', (await cleanUp.innerText()).includes('Clean up'));

    const overflowing = await page.locator('.duplicate-row').evaluateAll(rows => rows.filter(row => row.scrollWidth > row.clientWidth + 1).length);
    check('no row runs wider than the page', overflowing === 0);

    const apolloRow = page.locator('.duplicate-row', { hasText: 'Apollo 11' });
    await apolloRow.getByRole('button', { name: 'Show every copy' }).click();
    const copies = await apolloRow.locator('.copy-row').count();
    check('opening a row lists every copy', copies === DOWNLOADED_AGAIN['apollo-11-moonwalk'] + 1, `${copies} copies`);
    check('marking the first download and the latest',
        (await apolloRow.locator('.copy-row').first().innerText()).includes('First download')
        && (await apolloRow.locator('.copy-row').last().innerText()).includes('Latest'));
    await shoot(page, 'duplicates-desktop');

    const apollo = seeded.files.filter(file => file.id === 'apollo-11-moonwalk');
    await cleanUp.click();
    const confirm = page.locator('app-confirm-dialog');
    await confirm.waitFor();
    check('the confirmation says which copy each choice keeps', (await confirm.innerText()).includes('keeps the first download'));
    await shoot(page, 'duplicates-confirm-desktop');
    await confirm.getByRole('button', { name: 'Remove newest' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.duplicate-row').length === 1, null, { timeout: 15_000 });

    const remaining = (await storedFiles()).filter(file => file.id === 'apollo-11-moonwalk');
    check('Remove newest keeps only the first download', remaining.length === 1 && remaining[0].uid === apollo[0].uid);
    check('and deletes the others from disk', apollo.slice(1).every(file => !existsSync(join(RUN_DIR, file.path))));

    const jupiter = seeded.files.filter(file => file.id === 'jupiter-great-red-spot');
    await page.locator('.duplicate-row', { hasText: 'Jupiter' }).locator('.duplicate-actions .kit-chip').click();
    await confirm.getByRole('button', { name: 'Remove oldest' }).click();
    await page.locator('.empty-state').waitFor({ timeout: 15_000 });

    const kept = (await storedFiles()).filter(file => file.id === 'jupiter-great-red-spot');
    check('Remove oldest keeps only the latest download', kept.length === 1 && kept[0].uid === jupiter[jupiter.length - 1].uid);
    check('with nothing left the page says so', (await page.locator('.empty-state h2').innerText()).includes('No duplicates'));
    check('and so does the backend', (await storedDuplicates()).length === 0);
    await shoot(page, 'duplicates-empty-desktop');
}

async function duplicatesOnAPhone(browser, errors) {
    const page = await newPage(browser, 'phone', errors, 'light');
    await page.goto(`${BASE}/#/duplicates`, { waitUntil: 'domcontentloaded' });
    await page.locator('.duplicate-row').first().waitFor({ timeout: 20_000 });
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    await page.locator('.duplicate-row').first().getByRole('button', { name: 'Show every copy' }).click();
    await shoot(page, 'duplicates-phone-light');
    await page.context().close();
    return fits;
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

    const browser = await chromium.launch();
    const errors = [];
    try {
        check('the seeded library is what the backend serves', (await storedFiles()).length === seeded.files.length);

        const page = await newPage(browser, 'desktop', errors);
        const created = await creatingOne(page, seeded);
        if (created) await editingOne(page, seeded, created);

        say('Checking a phone width, and the light theme');
        check('the editor fits on a phone', await editorOnAPhone(browser, errors, 'dark'));
        check('and in the light theme', await editorOnAPhone(browser, errors, 'light'));
        // Before the clean-up, while there is still something on the page to look at.
        check('the duplicates page fits on a phone', await duplicatesOnAPhone(browser, errors));

        await theDuplicatesPage(page, seeded);
        await page.context().close();

        for (const error of errors) console.log(`    page console error: ${error.slice(0, 200)}`);
        check('no page errors, NG0919 included', errors.length === 0);
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
