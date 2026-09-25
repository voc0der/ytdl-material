// Drives library sharing in multi-user mode, end to end: one account shares its library, another
// switches to it from Profile, browses and plays it read only, and goes back to its own.
//
// Sharing is the one feature that needs two accounts at once, and what it must not do -- let the
// second account change anything of the first's -- is invisible from either account's own pages.
// So this stages both, drives the pages the way each person would, and asks the backend after
// every step what it recorded, including that the writes a shared library does not offer are
// refused when they are asked for anyway.
//
// Bob's videos are the sample from the backend tests, so the stream the player asks for has
// bytes to answer with. What is checked is that the stream is served to the viewer, not that
// it plays.
//
// The backend limits /api/auth to 25 requests in 15 minutes per address. A run makes about
// fifteen, and the count lives in the backend process, which every run boots afresh.
//
// Nothing is mocked: the frontend is built from the working tree and the backend runs from a
// throwaway copy (see stage.mjs). It downloads nothing. Screenshots at a desktop and a phone
// width, light and dark, are left in the shots folder it prints.
//
// Usage: node sharing.mjs [--skip-build] [--keep]
//   --keep leaves the backend running with both accounts, Bob's library still shared.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CACHE, HERE, REPO_ROOT, buildFrontend, copyBackend, hasFrontendBuild, isListening, releaseBackend, say,
    startBackend, writeMigrationFlags
} from './stage.mjs';

const FIXTURES = join(HERE, 'fixtures');
const SAMPLE_VIDEO = join(REPO_ROOT, 'backend', 'test', 'sample_mp4.mp4');
const RUN_DIR = join(CACHE, 'sharing');
const SHOTS_DIR = join(RUN_DIR, 'shots');
// Beside the README capture's 17449 and the other harnesses' 17450 to 17458.
const PORT = 17459;
const BASE = `http://localhost:${PORT}`;

const ADMIN = { uid: 'admin', name: 'admin', password: 'sharing-harness-admin' };
const OWNER = { uid: 'bob', name: 'Bob', password: 'sharing-harness-bob' };
const VIEWER = { uid: 'vocoder', name: 'vocoder', password: 'sharing-harness-viewer' };
// How much of the README library is Bob's, and how much is the viewer's own.
const OWNER_VIDEOS = 4;
const VIEWER_VIDEOS = 1;

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
    const hex = createHash('sha1').update(`ytdl-material-sharing:${id}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function api(route, body = {}, token = null, library = null) {
    const query = new URLSearchParams();
    if (token) query.set('jwt', token);
    if (library) query.set('library', library);
    const response = await fetch(`${BASE}/api/${route}?${query}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}

// Each account's videos live in its own folder under users/, which is what the stream and
// thumbnail routes check a record's path against.
async function seed() {
    const library = JSON.parse(await readFile(join(FIXTURES, 'library.json'), 'utf8'));
    const downloaded = Date.parse(library.downloaded);
    await mkdir(join(RUN_DIR, 'appdata'), { recursive: true });

    const record = async (owner, video, index) => {
        const dir = join('users', owner.uid, 'video');
        await mkdir(join(RUN_DIR, dir), { recursive: true });
        await cp(SAMPLE_VIDEO, join(RUN_DIR, dir, `${video.id}.mp4`));
        await cp(join(FIXTURES, 'thumbnails', `${video.id}.jpg`), join(RUN_DIR, dir, `${video.id}.jpg`));
        const uid = stableUid(`${owner.uid}:${video.id}`);
        return {
            id: video.id, title: video.title, thumbnailURL: `/api/thumbnail/${uid}`, isAudio: false,
            duration: video.duration, url: '', uploader: video.uploader, size: 2538,
            path: `${dir}/${video.id}.mp4`, thumbnailPath: `${dir}/${video.id}.jpg`,
            upload_date: `${video.upload_date.slice(0, 4)}-${video.upload_date.slice(4, 6)}-${video.upload_date.slice(6, 8)}`,
            description: video.description, view_count: video.view_count, height: video.height, abr: null,
            favorite: false, local_view_count: 0, source_metadata_checked: true, uid, user_uid: owner.uid,
            registered: downloaded - index * 60_000
        };
    };

    const owner_files = [];
    for (const [index, video] of library.videos.slice(0, OWNER_VIDEOS).entries()) owner_files.push(await record(OWNER, video, index));
    const viewer_files = [];
    for (const [index, video] of library.videos.slice(OWNER_VIDEOS, OWNER_VIDEOS + VIEWER_VIDEOS).entries()) {
        viewer_files.push(await record(VIEWER, video, index));
    }

    // A real playlist takes its first file's thumbnail from the site, which there is none of
    // here. The API path the files carry would be asked for without a token and refused.
    const playlist = {
        name: 'Bob\'s favourites', uids: owner_files.slice(0, 2).map(file => file.uid), id: stableUid('playlist:bob'),
        thumbnailURL: null, registered: downloaded, randomize_order: false,
        duration: owner_files[0].duration + owner_files[1].duration, user_uid: OWNER.uid
    };

    await writeFile(join(RUN_DIR, 'appdata', 'local_db.json'), JSON.stringify({
        files: [...owner_files, ...viewer_files], playlists: [playlist]
    }, null, 2));
    await writeMigrationFlags(RUN_DIR);
    return { owner_files, viewer_files, playlist };
}

async function newPage(browser, device, errors, token, theme = 'dark') {
    const context = await browser.newContext({
        ...DEVICES[device],
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: theme === 'dark' ? 'dark' : 'light',
        reducedMotion: 'reduce'
    });
    await context.addInitScript(([stored_theme, jwt]) => {
        localStorage.setItem('theme', stored_theme);
        localStorage.setItem('jwt_token', jwt);
    }, [theme, token]);
    const page = await context.newPage();
    page.expectedRefusals = 0;
    // The fallback check asks for a library that has just stopped being shared, which is
    // refused and logged. That is the page working, not a finding.
    //
    // /api/downloads is a separate, older problem: the toolbar polls it for every signed-in
    // account, and one without the downloads_manager permission -- the viewer, like any account
    // made by registering -- is refused on every poll. It has nothing to do with sharing.
    const expected = (url, text = '') => /\/api\/downloads(\?|$)/.test(url)
        || (page.expectedRefusals > 0 && (/[?&]library=/.test(url) || text === 'That library is not shared'));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        if (expected(message.location()?.url ?? '', message.text())) return;
        errors.push(`${device}/${theme}: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`${device}/${theme}: ${error.message}`));
    page.streams = [];
    page.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (path === '/api/stream') page.streams.push({ url: response.url(), status: response.status() });
        if (response.status() >= 400 && !expected(response.url())) {
            errors.push(`${device}/${theme}: ${response.status()} ${path}${new URL(response.url()).search.replace(/jwt=[^&]+/, 'jwt=…')}`);
        }
    });
    return page;
}

async function shoot(page, name) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

const profile = page => page.locator('app-user-profile-dialog');
const ownerSwitch = page => profile(page).locator('.library-owner-switch');
const shareToggle = page => profile(page).locator('mat-slide-toggle button[role="switch"]');
const backToMine = page => page.locator('.viewing-library-button');
const fileCount = page => page.locator('.library-switch-count').first();
const cards = page => page.locator('app-unified-file-card');

async function openHome(page) {
    await page.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
    await page.locator('.library-switcher').waitFor({ timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
}

async function openProfile(page) {
    await page.locator('button[aria-label="More options"]').click();
    await page.getByRole('menuitem', { name: 'Profile' }).click();
    await profile(page).waitFor();
    // The shared libraries arrive after the dialog opens.
    await page.waitForLoadState('networkidle').catch(() => {});
}

async function closeProfile(page) {
    await page.keyboard.press('Escape');
    await profile(page).waitFor({ state: 'detached' });
}

async function waitForFileCount(page, count) {
    try {
        await page.waitForFunction(([selector, expected]) => document.querySelector(selector)?.textContent.trim() === expected,
            ['.library-switch-count', String(count)], { timeout: 15_000 });
        return true;
    } catch {
        return false;
    }
}

async function sharing(page, token) {
    say('Bob shares his library');
    await openHome(page);
    await openProfile(page);
    const row = profile(page).locator('.settings-row', { hasText: 'Share library' });
    check('Preferences offers to share the library', await row.count() === 1);
    check('and says who can see it and what they cannot do',
        (await row.innerText()).includes('Everyone with an account here') && (await row.innerText()).includes('Nobody else can change'));
    check('it starts off', await shareToggle(page).getAttribute('aria-checked') === 'false');
    check('nobody else can switch to it yet', (await api('getSharedLibraries', {}, token.viewer)).body?.libraries?.length === 0);

    await shareToggle(page).click();
    await page.locator('mat-snack-bar-container', { hasText: 'now shared' }).waitFor({ timeout: 10_000 });
    const libraries = (await api('getSharedLibraries', {}, token.viewer)).body?.libraries ?? [];
    check('turning it on shares it', libraries.length === 1 && libraries[0].uid === OWNER.uid && libraries[0].name === OWNER.name,
        JSON.stringify(libraries));
    check('and nothing but his name and uid is handed out', libraries.every(library => Object.keys(library).sort().join() === 'name,uid'));
    check('his own switch lists nobody, since only he shares', await ownerSwitch(page).count() === 0);
    await shoot(page, 'sharing-profile-desktop');
    await closeProfile(page);
}

async function browsing(page, seeded, token) {
    say('The viewer switches to Bob\'s library');
    await openHome(page);
    check('the viewer starts on their own library', await waitForFileCount(page, VIEWER_VIDEOS));
    check('with nothing in the toolbar saying otherwise', await backToMine(page).count() === 0);

    await openProfile(page);
    check('their name has become a switch', (await ownerSwitch(page).innerText()).includes(VIEWER.name));
    await ownerSwitch(page).click();
    const choices = page.getByRole('menuitemradio');
    const labels = (await choices.allInnerTexts()).map(text => text.replace(/\s+/g, ' ').replace(/^check /, '').trim());
    check('it offers their own library and Bob\'s', labels.join('|') === `${VIEWER.name} Yours|${OWNER.name} Read only`, labels.join(', '));
    await shoot(page, 'sharing-switch-desktop');

    await choices.filter({ hasText: OWNER.name }).click();
    await profile(page).waitFor({ state: 'detached' });
    check('picking Bob closes Profile on the library', page.url().endsWith('#/home'), page.url().split('#')[1]);
    check('the library is Bob\'s', await waitForFileCount(page, seeded.owner_files.length));
    check('the toolbar says whose it is, and offers the way back',
        (await backToMine(page).getAttribute('aria-label')) === 'Browsing Bob\'s library. Back to yours');

    await page.waitForFunction(() => [...document.querySelectorAll('app-unified-file-card img')]
        .every(img => img.complete), null, { timeout: 15_000 }).catch(() => {});
    const thumbnails = await page.locator('app-unified-file-card img').evaluateAll(images => images.map(img => img.naturalWidth));
    check('his thumbnails are served', thumbnails.length === seeded.owner_files.length && thumbnails.every(width => width > 0),
        thumbnails.join(', '));

    await cards(page).first().locator('button.menuButton').click();
    const actions = (await page.locator('.mat-mdc-menu-panel button.mat-mdc-menu-item').allInnerTexts())
        .map(text => text.replace(/^info\s*/, '').trim());
    check('a file\'s menu offers nothing but its media info', actions.join('|') === 'Media info', actions.join(', '));
    await shoot(page, 'sharing-library-desktop');
    await page.locator('.mat-mdc-menu-panel button.mat-mdc-menu-item').click();
    const info = page.locator('app-video-info-dialog');
    await info.waitFor();
    await page.waitForLoadState('networkidle').catch(() => {});
    check('Media info says it is read only', (await info.locator('.dialog-subtitle').innerText()).includes('You can look, but not change anything'));
    check('and offers no edit, favorite or cover art',
        await info.locator('.favorite-button').count() === 0
        && !(await info.locator('.dialog-actions').innerText()).match(/Edit details|cover art|Snip/));
    await shoot(page, 'sharing-info-desktop');
    await page.keyboard.press('Escape');
    await info.waitFor({ state: 'detached' });

    await page.locator('.library-switch', { hasText: 'Playlists' }).click();
    const playlist_card = cards(page).filter({ hasText: seeded.playlist.name });
    await playlist_card.waitFor({ timeout: 10_000 }).catch(() => {});
    check('his playlists are there', await playlist_card.count() === 1);
    check('with no menu to edit or delete them', await playlist_card.locator('button.menuButton').count() === 0);
    check('and nothing offered to make one', await page.locator('.playlist-shortcut-action').count() === 0);
    await page.locator('.library-switch', { hasText: 'Videos' }).click();

    say('Playing one of Bob\'s videos');
    const played = seeded.owner_files[0];
    await cards(page).filter({ hasText: played.title.slice(0, 30) }).first().locator('.file-metadata').click();
    await page.waitForURL(/#\/player/, { timeout: 15_000 });
    check('the player is opened on his library', decodeURIComponent(page.url()).includes('library=bob'));
    await page.locator('.action-buttons-row').waitFor({ timeout: 15_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    const served = page.streams.filter(stream => stream.url.includes(played.uid));
    check('his video is streamed to the viewer', served.length > 0 && served.every(stream => [200, 206].includes(stream.status)),
        served.map(stream => stream.status).join(', '));
    const icons = await page.locator('.action-buttons-row mat-icon').allInnerTexts();
    check('the player offers no download or share', !icons.some(icon => ['cloud_download', 'share'].includes(icon.trim())), icons.join(', '));
    const after = (await api('getFile', { uid: played.uid }, token.owner)).body?.file;
    check('watching it does not add to his view count', after && (after.local_view_count ?? 0) === 0, `${after?.local_view_count}`);
    await shoot(page, 'sharing-player-desktop');

    say('Going back to the viewer\'s own library');
    await backToMine(page).click();
    await page.waitForURL(/#\/home$/, { timeout: 15_000 });
    check('one press goes back to their own library', await waitForFileCount(page, VIEWER_VIDEOS));
    check('and the toolbar button goes with it', await backToMine(page).count() === 0);

    await openProfile(page);
    await ownerSwitch(page).click();
    await page.getByRole('menuitemradio').filter({ hasText: OWNER.name }).click();
    await profile(page).waitFor({ state: 'detached' });
    await waitForFileCount(page, seeded.owner_files.length);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.library-switcher').waitFor({ timeout: 30_000 });
    check('a reload starts on their own library again', await waitForFileCount(page, VIEWER_VIDEOS));
}

async function refusing(seeded, token) {
    say('Asking for what a shared library does not offer');
    const file = seeded.owner_files[1];

    // updateFile answers success whether or not its filter matched anything, so the record is
    // what says whether it was changed.
    const favorite = await api('updateFile', { uid: file.uid, change_obj: { favorite: true, title: 'Renamed' } }, token.viewer);
    const deleted = await api('deleteFile', { uid: file.uid }, token.viewer);
    const art = await api('generateThumbnail', { uid: file.uid }, token.viewer);
    const added = await api('addFileToPlaylist', { playlist_id: seeded.playlist.id, file_uid: file.uid }, token.viewer, OWNER.uid);
    const stored = (await api('getFile', { uid: file.uid }, token.owner)).body?.file;
    const playlist = (await api('getPlaylist', { playlist_id: seeded.playlist.id }, token.owner)).body?.playlist;
    check('the viewer cannot edit or favorite his files', stored?.favorite === false && stored?.title === file.title,
        `answered ${JSON.stringify(favorite.body)}, stored favorite ${stored?.favorite}`);
    check('or delete them', deleted.body === false && !!stored);
    check('or redo their cover art', art.body?.success === false);
    check('or change his playlists, even naming his library', added.body?.success === false && playlist?.uids?.length === seeded.playlist.uids.length);

    const download = await fetch(`${BASE}/api/downloadFileFromServer?jwt=${token.viewer}&library=${OWNER.uid}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: file.uid })
    });
    const bytes = download.ok ? (await download.arrayBuffer()).byteLength : 0;
    check('or download a copy of them', bytes === 0, `${download.status}, ${bytes} bytes`);

    const private_library = await api('getAllFiles', {}, token.viewer, ADMIN.uid);
    check('a library that is not shared is refused', private_library.status === 403, `${private_library.status}`);
    const as_owner = await api('getAllFiles', {}, token.owner, VIEWER.uid);
    check('including the viewer\'s, which Bob never got to see', as_owner.status === 403, `${as_owner.status}`);
}

async function unsharing(page, seeded, token) {
    say('Bob stops sharing while the viewer is browsing it');
    await openHome(page);
    await openProfile(page);
    await ownerSwitch(page).click();
    await page.getByRole('menuitemradio').filter({ hasText: OWNER.name }).click();
    await profile(page).waitFor({ state: 'detached' });
    await waitForFileCount(page, seeded.owner_files.length);

    const stopped = await api('setLibrarySharing', { enabled: false }, token.owner);
    check('Bob can stop sharing', stopped.body?.success === true);
    check('which takes his library off the list at once', (await api('getSharedLibraries', {}, token.viewer)).body?.libraries?.length === 0);
    check('and refuses it to anyone still asking', (await api('getAllFiles', {}, token.viewer, OWNER.uid)).status === 403);

    // Changing the sort asks for the library again, which is the first the page learns of it.
    page.expectedRefusals++;
    await page.locator('app-sort-property button').first().click();
    const option = page.getByRole('menuitemradio').filter({ hasText: 'Name' });
    if (await option.count()) await option.first().click(); else await page.keyboard.press('Escape');
    await page.locator('mat-snack-bar-container', { hasText: 'Showing yours instead' }).waitFor({ timeout: 10_000 }).catch(() => {});
    check('the viewer is told, and put back on their own library',
        await page.locator('mat-snack-bar-container', { hasText: 'Could not open Bob\'s library' }).count() === 1
        && await waitForFileCount(page, VIEWER_VIDEOS) && await backToMine(page).count() === 0);

    await openProfile(page);
    check('and their name is a plain heading again', await ownerSwitch(page).count() === 0
        && (await profile(page).locator('.account-summary h3').innerText()).trim() === VIEWER.name);
    await closeProfile(page);

    // Shared again, so --keep leaves something to look at.
    await api('setLibrarySharing', { enabled: true }, token.owner);
}

async function onAPhone(browser, errors, token, theme) {
    const page = await newPage(browser, 'phone', errors, token.viewer, theme);
    await openHome(page);
    await openProfile(page);
    await ownerSwitch(page).click();
    await shoot(page, `sharing-switch-phone-${theme}`);
    await page.getByRole('menuitemradio').filter({ hasText: OWNER.name }).click();
    await profile(page).waitFor({ state: 'detached' });
    await waitForFileCount(page, OWNER_VIDEOS);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    const visible = await backToMine(page).isVisible();
    await shoot(page, `sharing-library-phone-${theme}`);
    await page.context().close();
    return fits && visible;
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

    say(`Staging the backend and two libraries in ${RUN_DIR}`);
    await rm(RUN_DIR, { recursive: true, force: true });
    await mkdir(SHOTS_DIR, { recursive: true });
    await copyBackend(RUN_DIR);
    const seeded = await seed();

    say(`Booting the backend in multi-user mode on ${BASE}...`);
    const backend = await startBackend(RUN_DIR, PORT, { ytdl_multi_user_mode: 'true' });

    const browser = await chromium.launch();
    const errors = [];
    try {
        const token = {};
        for (const [key, account] of [['admin', ADMIN], ['owner', OWNER], ['viewer', VIEWER]]) {
            const registered = await api('auth/register', { userid: account.uid, username: account.name, password: account.password });
            const logged_in = await api('auth/login', { username: account.name, password: account.password });
            token[key] = logged_in.body?.token;
            check(`the ${key} account is registered`, registered.status === 200 && !!token[key], `${registered.status}/${logged_in.status}`);
        }

        const owner_page = await newPage(browser, 'desktop', errors, token.owner);
        await sharing(owner_page, token);
        await owner_page.context().close();

        const viewer_page = await newPage(browser, 'desktop', errors, token.viewer);
        await browsing(viewer_page, seeded, token);
        await refusing(seeded, token);

        say('Checking a phone width, and the light theme');
        check('the switch and the way back fit on a phone', await onAPhone(browser, errors, token, 'dark'));
        check('and in the light theme', await onAPhone(browser, errors, token, 'light'));

        await unsharing(viewer_page, seeded, token);
        await viewer_page.context().close();

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
