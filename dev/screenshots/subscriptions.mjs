// Runs a real subscription through the subscription pages, end to end.
//
// Subscribes to a small public playlist from the Subscriptions page, waits for its videos to
// download, checks what the backend recorded against what was chosen on the page, checks it
// again to see nothing is downloaded twice, saves a setting from the subscription's own page,
// and unsubscribes. Screenshots of each page, at a desktop and a phone width, are left in the
// shots folder it prints.
//
// Nothing is mocked: the frontend is built from the working tree, the backend runs from a
// throwaway copy (see stage.mjs), and yt-dlp downloads from the site. That is also why it is
// not part of CI -- it fails when the site does.
//
// Usage: node subscriptions.mjs [--skip-build] [--keep] [--url <playlist url>]
//   --keep leaves the backend running with the subscription in place, and skips unsubscribing.

import { chromium } from 'playwright';
import { mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
    CACHE, buildFrontend, copyBackend, hasFrontendBuild, isListening, releaseBackend, say, sleep, startBackend,
    writeMigrationFlags
} from './stage.mjs';

// Four NASA videos, about five minutes in all, which NASA publishes for free use. At 360p
// the whole playlist is around 10 MB and downloads in seconds.
const DEFAULT_PLAYLIST = {
    url: 'https://www.youtube.com/playlist?list=PL2aBZuCeDwlRBnr2rfhTkBHB-vRlWkiW9',
    title: 'Space Stars Shine for NASA Spinoffs',
    count: 4
};

const RUN_DIR = join(CACHE, 'subscriptions');
const SHOTS_DIR = join(RUN_DIR, 'shots');
// Beside the README capture's 17449, so both can run at once.
const PORT = 17450;
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

async function waitFor(description, predicate, timeout_ms = 30_000) {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(500);
    }
    throw new Error(`timed out after ${timeout_ms / 1000}s waiting for ${description} (backend log: ${join(RUN_DIR, 'backend.log')})`);
}

// Resolves once a refresh has finished and nothing it queued is still waiting or running.
async function waitForRefresh(sub_id, label, timeout_ms = 300_000) {
    let last = '';
    return await waitFor(`the ${label} to finish`, async () => {
        const { subscription } = await api('getSubscription', { id: sub_id, include_videos: false });
        const status = subscription.refresh_status ?? {};
        const line = `${status.phase ?? 'idle'}: ${subscription.file_count ?? 0} files, ${status.pending_download_count ?? 0} pending, ${status.running_download_count ?? 0} running`;
        if (line !== last) {
            console.log(`    ${label} ${line}`);
            last = line;
        }
        const settled = !subscription.downloading
            && !status.active
            && ['complete', 'queued', 'error', 'cancelled'].includes(status.phase)
            && !(status.pending_download_count > 0)
            && !(status.running_download_count > 0);
        return settled ? subscription : null;
    }, timeout_ms);
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
    // Covers load lazily; give the ones on screen the chance to decode.
    await page.evaluate(() => Promise.all([...document.images].filter(image => !image.complete).map(image => new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
    }))));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const path = join(SHOTS_DIR, `${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled', caret: 'hide' });
    return path;
}

async function subscribeFromPage(page, playlist) {
    say('Subscribing from the Subscriptions page');
    await open(page, 'subscriptions');
    await page.getByText('No subscriptions yet').waitFor();
    check('an empty list says so', true);
    await shoot(page, 'empty-desktop');

    const link = page.getByPlaceholder('Paste a channel or playlist link');
    await link.fill(playlist.url);
    await page.getByRole('button', { name: /^Quality/ }).click();
    await page.getByRole('menuitemradio', { name: '360p' }).click();
    await page.getByRole('button', { name: 'More subscription options' }).click();
    await page.getByRole('switch', { name: 'Playlist' }).click();
    await shoot(page, 'subscribe-desktop');

    const started = Date.now();
    await page.getByRole('button', { name: 'Subscribe', exact: true }).click();
    // Subscribing reads the link before it answers, so this takes a few seconds.
    await waitFor('the form to clear', async () => (await link.inputValue()) === '', 120_000);
    check('the form cleared after subscribing', true);

    const { subscriptions } = await api('getSubscriptions');
    const sub = subscriptions[0];
    check('the quality chosen on the page was saved', sub?.maxQuality === '360', sub?.maxQuality);
    check('the playlist option chosen on the page was saved', sub?.auto_create_playlist === true);
    if (!sub) throw new Error('the subscription was not saved');

    const done = await waitForRefresh(sub.id, 'first check');
    console.log(`    took ${Math.round((Date.now() - started) / 1000)}s`);
    return done;
}

async function checkDownloads(sub, playlist) {
    check('recognised as a playlist', sub.isPlaylist === true);
    if (playlist.title) check('named after the playlist', sub.name === playlist.title, sub.name);
    check('refresh finished without an error', sub.refresh_status?.phase !== 'error', sub.refresh_status?.error ?? sub.refresh_status?.phase);
    if (playlist.count) check(`downloaded all ${playlist.count} videos`, sub.file_count === playlist.count, `${sub.file_count} files`);

    const { files } = await api('getSubscription', { id: sub.id });
    const folder = join(RUN_DIR, 'subscriptions', 'playlists', sub.name);
    let inFolder = 0;
    let withThumbnail = 0;
    for (const file of files) {
        if (join(RUN_DIR, file.path).startsWith(folder)) inFolder++;
        try {
            if (file.thumbnailPath && (await stat(join(RUN_DIR, file.thumbnailPath))).size > 0) withThumbnail++;
        } catch {
            // missing on disk
        }
    }
    check('files saved in the subscription folder', files.length > 0 && inFolder === files.length, relative(RUN_DIR, folder));
    check('every file has a thumbnail on disk', withThumbnail === files.length, `${withThumbnail}/${files.length}`);

    const { playlists } = await api('getPlaylists');
    const auto = playlists.find(entry => entry.source_sub_id === sub.id);
    check('downloads were added to a playlist', auto && auto.uids.length === files.length, auto ? `${auto.uids.length} in "${auto.name}"` : 'none');

    const { subscriptions } = await api('getSubscriptions');
    const summary = subscriptions.find(entry => entry.id === sub.id);
    check('the list gives the subscription a cover', files.some(file => file.uid === summary?.thumbnail_file_uid));
    return folder;
}

async function checkAgainFromCard(page, sub) {
    say('Checking again from the card menu');
    await open(page, 'subscriptions');
    const card = page.locator('.subscription-card', { hasText: sub.name });
    await card.locator('img').waitFor();
    check('the card shows its file count', await card.getByText(`${sub.file_count} files`).isVisible());
    await shoot(page, 'list-desktop');

    await card.getByRole('button', { name: 'More actions' }).click();
    await shoot(page, 'card-menu-desktop');
    await page.getByRole('menuitem', { name: 'Check now' }).click();
    // Let the check start before waiting for it to finish.
    await sleep(1500);
    const rechecked = await waitForRefresh(sub.id, 'second check');
    check('a second check downloads nothing new', rechecked.file_count === sub.file_count, `${rechecked.file_count} files`);
}

async function saveSettingsFromPage(page, sub) {
    say('Pausing it from its settings');
    await open(page, 'subscriptions');
    await page.getByRole('link', { name: sub.name }).click();
    await page.getByRole('heading', { name: sub.name }).waitFor();
    await shoot(page, 'subscription-desktop');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const panel = page.locator('.settings-panel');
    await panel.waitFor();
    check('Save waits for a change', await panel.getByRole('button', { name: 'Save' }).isDisabled());
    await panel.getByRole('switch', { name: 'Paused' }).click();
    await shoot(page, 'settings-desktop');
    await panel.getByRole('button', { name: 'Save' }).click();

    await panel.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    check('saving closes the settings', await panel.count() === 0);
    const { subscription } = await api('getSubscription', { id: sub.id, include_videos: false });
    check('the change was saved', subscription.paused === true);
    check('saving kept the other settings', subscription.maxQuality === '360' && subscription.auto_create_playlist === true);
    await page.locator('.sub-status', { hasText: 'Paused' }).waitFor({ timeout: 5_000 }).catch(() => {});
    check('the page shows it paused', await page.locator('.sub-status', { hasText: 'Paused' }).isVisible());
}

async function capturePhoneAndLight(browser, sub, errors) {
    say('Capturing the phone and light layouts');
    const phone = await newPage(browser, 'phone', errors);
    await open(phone, 'subscriptions');
    await phone.locator('.subscription-card img').waitFor();
    await shoot(phone, 'list-phone');
    await phone.getByRole('button', { name: 'More subscription options' }).click();
    await shoot(phone, 'subscribe-phone');
    await open(phone, `subscription;id=${sub.id};settings=true`);
    await phone.locator('.settings-panel').waitFor();
    await shoot(phone, 'settings-phone');
    await phone.context().close();

    const light = await newPage(browser, 'desktop', errors, 'default');
    await open(light, 'subscriptions');
    await light.locator('.subscription-card img').waitFor();
    await shoot(light, 'list-light');
    await open(light, `subscription;id=${sub.id};settings=true`);
    await light.locator('.settings-panel').waitFor();
    await shoot(light, 'settings-light');
    await light.context().close();
}

async function unsubscribeFromPage(page, sub, folder) {
    say('Unsubscribing from its page');
    await open(page, `subscription;id=${sub.id}`);
    await page.getByRole('heading', { name: sub.name }).waitFor();
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Unsubscribe' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    check('unsubscribing warns that the files are deleted', await dialog.getByText(`${sub.file_count} downloaded files are deleted too`).isVisible());
    await dialog.getByRole('button', { name: 'Unsubscribe' }).click();

    await page.getByText('No subscriptions yet').waitFor({ timeout: 30_000 });
    check('unsubscribing returns to the empty list', true);
    const { subscriptions } = await api('getSubscriptions');
    check('the subscription is gone', subscriptions.length === 0);
    check('its folder is gone', !existsSync(folder));
}

async function main() {
    const keep = process.argv.includes('--keep');
    const skipBuild = process.argv.includes('--skip-build');
    const url = argValue('--url');
    // A playlist other than the default has no known title or length to check against.
    const playlist = url ? { url, title: null, count: null } : DEFAULT_PLAYLIST;

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
        ytdl_allow_subscriptions: 'true',
        // No Deno is assumed; yt-dlp can use the Node running this script instead.
        ytdl_js_runtimes: 'node'
    });

    const browser = await chromium.launch();
    const errors = [];
    try {
        const page = await newPage(browser, 'desktop', errors);
        const sub = await subscribeFromPage(page, playlist);
        const folder = await checkDownloads(sub, playlist);
        await checkAgainFromCard(page, sub);
        await saveSettingsFromPage(page, sub);
        await capturePhoneAndLight(browser, sub, errors);
        if (!keep) {
            await unsubscribeFromPage(page, sub, folder);
        }

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
