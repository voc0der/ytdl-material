// Drives the Settings page, tab by tab, end to end.
//
// Settings is the page where a broken control is invisible until someone's server stops doing
// what they told it to: every row writes into one config object, and one Save writes that
// object to disk. So this opens each tab, checks its rows rendered, changes a setting of each
// kind the page has -- a toggle, a text field, a picker, a set of chips -- saves, and reads the
// config back off the backend to see that what was picked is what was stored. It also checks
// Cancel puts the page back, and that the tab lives in the URL so a link to one works.
//
// Nothing is mocked: the frontend is built from the working tree and the backend runs from a
// throwaway copy (see stage.mjs). It downloads nothing from the network. Screenshots of every
// tab, desktop and phone, light and dark, are left in the shots folder it prints.
//
// Usage: node settings.mjs [--skip-build] [--keep]
//   --keep leaves the backend running with everything in place.

import { chromium } from 'playwright';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CACHE, buildFrontend, copyBackend, hasFrontendBuild, isListening, releaseBackend, say, sleep, startBackend,
    stopBackend, writeMigrationFlags
} from './stage.mjs';

const RUN_DIR = join(CACHE, 'settings');
const SHOTS_DIR = join(RUN_DIR, 'shots');
// Beside the README capture's 17449, subscriptions' 17450, downloads' 17451 and dialogs' 17452.
const PORT = 17453;
const BASE = `http://localhost:${PORT}`;

// Every tab, in the order the rail shows them, with something each one must render.
const TABS = [
    { key: 'main', label: 'Main', shows: 'Users base path' },
    { key: 'downloader', label: 'Downloader', shows: 'Audio folder path' },
    { key: 'extra', label: 'Extra', shows: 'Top title' },
    { key: 'database', label: 'Database', shows: 'Records per table' },
    { key: 'notifications', label: 'Notifications', shows: 'Webhook URL' },
    { key: 'advanced', label: 'Advanced', shows: 'Select a downloader' },
    { key: 'logs', label: 'Logs', shows: 'Lines' }
];

const DEVICES = {
    desktop: { viewport: { width: 1280, height: 1000 }, isMobile: false, hasTouch: false },
    phone: { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }
};

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok });
    const mark = ok ? '\x1b[0;32m✓\x1b[0m' : '\x1b[0;31m✗\x1b[0m';
    console.log(`    ${mark} ${name}${detail ? ` (${detail})` : ''}`);
}

async function storedConfig() {
    const response = await fetch(`${BASE}/api/config`);
    if (!response.ok) throw new Error(`/api/config answered ${response.status}`);
    const body = await response.json();
    return body['config_file']?.['YtdlMaterial'] ?? body['YtdlMaterial'] ?? body;
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

// The whole page from the top, or the part of it around one thing when that is the point.
async function shoot(page, name, focus = null) {
    if (focus) {
        await focus.scrollIntoViewIfNeeded();
    } else {
        await page.evaluate(() => {
            window.scrollTo(0, 0);
            document.querySelector('mat-sidenav-content')?.scrollTo(0, 0);
        });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const path = join(SHOTS_DIR, `${name}.png`);
    await page.screenshot({ path, fullPage: !focus, animations: 'disabled', caret: 'hide' });
    return path;
}

async function openSettings(page, tab = null) {
    await page.goto(`${BASE}/#/settings${tab ? `;tab=${tab}` : ''}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.getByRole('tab', { name: 'Main' }).waitFor({ timeout: 20_000 });
}

async function everyTab(page) {
    say('Opening every tab from the rail');
    await openSettings(page);

    for (const tab of TABS) {
        await page.getByRole('tab', { name: tab.label, exact: true }).click();
        await page.getByText(tab.shows, { exact: false }).first().waitFor({ timeout: 20_000 });
        const selected = await page.getByRole('tab', { name: tab.label, exact: true }).getAttribute('aria-selected');
        check(`the ${tab.key} tab opens and says what is in it`, selected === 'true');
        await shoot(page, `settings-${tab.key}-desktop`);
    }

    // The tab is in the URL, so a link to one opens on it.
    check('the open tab is in the URL', page.url().includes(';tab=logs'), page.url().split('#')[1] ?? '');
    await openSettings(page, 'notifications');
    check('and a link to a tab opens on it',
        await page.getByRole('tab', { name: 'Notifications', exact: true }).getAttribute('aria-selected') === 'true');
}

async function theUsersTab(page) {
    say('Checking the tab that needs multi-user mode');
    await openSettings(page);
    const users = page.getByRole('tab', { name: 'Users', exact: true });
    check('the Users tab is not available without multi-user mode', await users.getAttribute('aria-disabled') === 'true');

    await users.hover();
    const tooltip = page.locator('.mat-mdc-tooltip');
    await tooltip.waitFor({ timeout: 10_000 });
    check('and hovering it says why', (await tooltip.innerText()).includes('multi-user mode'), (await tooltip.innerText()).trim());

    // force, because aria-disabled is what it says and Playwright will not click it otherwise.
    await users.click({ force: true });
    check('clicking it does nothing', await users.getAttribute('aria-selected') === 'false');
}

// The row a setting lives in, found by what the page calls it.
function row(page, title) {
    return page.locator('.settings-row', { hasText: title });
}

async function savingAndCancelling(page) {
    say('Changing a setting of each kind, then saving');
    await openSettings(page, 'main');

    const savebar = page.locator('.settings-savebar');
    check('there is nothing to save before anything is changed', await savebar.count() === 0);

    await row(page, 'Allow theme change').getByRole('switch').click();
    await savebar.waitFor({ timeout: 10_000 });
    check('changing a setting offers to save it', await savebar.isVisible());
    await shoot(page, 'settings-unsaved-desktop');

    // Cancel puts the page back, which is also what makes the bar go away.
    await savebar.getByRole('button', { name: 'Cancel' }).click();
    await savebar.waitFor({ state: 'detached', timeout: 10_000 });
    check('Cancel puts the page back', true);

    // One of each kind of control, across two tabs, then one Save for all of it.
    const before = await storedConfig();
    await row(page, 'Redownload fresh uploads').getByRole('switch').click();
    await page.getByRole('button', { name: /^Theme/ }).click();
    await page.getByRole('menuitemradio', { name: 'Default', exact: true }).click();

    await page.getByRole('tab', { name: 'Extra', exact: true }).click();
    await page.getByLabel('Top title').waitFor({ timeout: 10_000 });
    check('an unsaved change survives switching tabs', await savebar.isVisible());
    await page.getByLabel('Top title').fill('Harness title');

    await savebar.getByRole('button', { name: 'Save' }).click();
    await savebar.waitFor({ state: 'detached', timeout: 15_000 });
    check('saving leaves nothing to save', true);

    const after = await waitFor('the config to be written', async () => {
        const config = await storedConfig();
        return config?.['Extra']?.['title_top'] === 'Harness title' ? config : null;
    });
    check('the text field was stored', after['Extra']['title_top'] === 'Harness title', after['Extra']['title_top']);
    check('the picker was stored', after['Themes']['default_theme'] === 'default', String(after['Themes']['default_theme']));
    check('the toggle was stored',
        after['Subscriptions']['redownload_fresh_uploads'] !== before['Subscriptions']['redownload_fresh_uploads'],
        String(after['Subscriptions']['redownload_fresh_uploads']));

    // Put the title back, so the rest of the run looks like a stock install.
    await page.getByLabel('Top title').fill(before['Extra']['title_top'] ?? 'ytdl-material');
    await savebar.getByRole('button', { name: 'Save' }).click();
    await savebar.waitFor({ state: 'detached', timeout: 15_000 });
    check('and a second save writes the change back', true);
}

async function notificationChips(page) {
    say('Picking which notifications are sent');
    await openSettings(page, 'notifications');

    const complete = page.getByRole('button', { name: 'Download complete', exact: true });
    // Every kind is sent while "all" is on, so there is nothing to pick between.
    check('the kinds cannot be picked while every kind is sent', await complete.isDisabled());

    await row(page, 'Enable all notifications').getByRole('switch').click();
    await waitFor('the kinds to become pickable', async () => !(await complete.isDisabled()));
    await complete.click();
    check('picking a kind marks it', await complete.getAttribute('aria-pressed') === 'true');

    const savebar = page.locator('.settings-savebar');
    await savebar.getByRole('button', { name: 'Save' }).click();
    await savebar.waitFor({ state: 'detached', timeout: 15_000 });

    const stored = await waitFor('the kinds to be stored', async () => {
        const config = await storedConfig();
        const allowed = config?.['Extra']?.['allowed_notification_types'];
        return Array.isArray(allowed) && allowed.includes('download_complete') ? allowed : null;
    });
    check('and it is stored as one of the allowed types', !!stored, stored.join(', '));
    check('while the ones not picked are left out', !stored.includes('download_error'));
    check('and turning every kind back on locks them again', await (async () => {
        await row(page, 'Enable all notifications').getByRole('switch').click();
        await waitFor('the kinds to lock again', async () => await complete.isDisabled());
        return true;
    })());
    await shoot(page, 'settings-notifications-picked-desktop');
}

async function categories(page) {
    say('Working the categories list');
    await openSettings(page, 'downloader');

    await page.getByRole('button', { name: '(Add default set)' }).click();
    const rows = page.locator('.category-row');
    await rows.first().waitFor({ timeout: 20_000 });
    const added = await rows.count();
    check('the default set adds categories', added > 0, `${added} categories`);
    await shoot(page, 'settings-categories-desktop', page.locator('.category-list'));

    // The dialog that names a new one, and the confirmation that removes it again.
    await page.getByRole('button', { name: 'Add category' }).click();
    const naming = page.getByRole('dialog').filter({ hasText: 'Name the category' });
    await naming.waitFor({ timeout: 10_000 });
    await naming.getByRole('textbox').fill('From the harness');
    await naming.getByRole('button', { name: 'Add' }).click();

    // Naming one opens its rules straight away, which is where its rules are set.
    const editing = page.getByRole('dialog').filter({ hasText: 'Editing category' });
    await editing.waitFor({ timeout: 15_000 });
    check('a new category opens on its rules', (await editing.innerText()).includes('From the harness'));
    await editing.getByRole('button', { name: 'Add rule' }).click();
    check('a rule can be added to it', await editing.locator('.rule-row').count() === 1);
    await shoot(page, 'settings-category-rules-desktop');
    await editing.getByRole('button', { name: 'Cancel' }).click();
    await editing.waitFor({ state: 'detached' }).catch(() => {});

    await waitFor('the new category to be listed', async () => (await rows.count()) === added + 1);
    const harness_row = page.locator('.category-row').filter({ hasText: 'From the harness' });
    await harness_row.getByRole('button', { name: 'Delete category' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Delete category' });
    await confirm.waitFor({ timeout: 10_000 });
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await waitFor('the category to go', async () => (await page.locator('.category-row').count()) === added);
    check('and removing one asks first, then removes it', true);
}

async function theDialogsSettingsOpens(page) {
    say('Opening the dialogs the page holds');
    await openSettings(page, 'downloader');

    await page.getByRole('button', { name: 'Edit args' }).click();
    const args = page.getByRole('dialog').filter({ hasText: 'Modify youtube-dl args' });
    await args.waitFor({ timeout: 10_000 });
    await args.getByLabel('Arg', { exact: true }).fill('--write-thumbnail');
    await page.getByRole('option', { name: /write-thumbnail/ }).first().click();
    await args.getByRole('button', { name: 'Add arg' }).click();
    check('the args dialog builds an arg list', (await args.innerText()).includes('--write-thumbnail'));
    await shoot(page, 'settings-args-desktop');
    await args.getByRole('button', { name: 'Modify' }).click();
    await args.waitFor({ state: 'detached' }).catch(() => {});
    check('and hands it back to the field it came from',
        (await page.getByLabel('Global custom args').inputValue()).includes('--write-thumbnail'));

    await openSettings(page, 'advanced');
    await page.getByRole('button', { name: 'Set Cookies' }).click();
    const cookies = page.getByRole('dialog').filter({ hasText: 'Upload new cookies' });
    await cookies.waitFor({ timeout: 10_000 });
    check('the cookies dialog offers a file and a test', (await cookies.innerText()).includes('Test cookies'));
    await shoot(page, 'settings-cookies-desktop');
    await cookies.locator('.dialog-actions').getByRole('button', { name: 'Close' }).click();
    await cookies.waitFor({ state: 'detached' }).catch(() => {});

    await openSettings(page, 'extra');
    const rss_toggle = page.locator('.settings-row', { hasText: 'Enable RSS Feed' }).getByRole('switch');
    const rss_button = page.getByRole('button', { name: 'Generate RSS URL' });
    check('the RSS dialog cannot be opened while the feed is off', await rss_button.isDisabled());
    await rss_toggle.click();
    await waitFor('the RSS button to become usable', async () => !(await rss_button.isDisabled()));
    await rss_button.click();
    const rss = page.getByRole('dialog').filter({ hasText: 'Generate RSS URL' });
    await rss.waitFor({ timeout: 10_000 });
    const feed_url = await rss.getByRole('textbox', { name: 'URL' }).inputValue();
    check('and the URL it generates points at the feed', feed_url.includes('/api/rss'), feed_url.slice(0, 60));
    await shoot(page, 'settings-rss-desktop');
    await rss.locator('.dialog-actions').getByRole('button', { name: 'Close' }).click();
    await rss.waitFor({ state: 'detached' }).catch(() => {});

    await openSettings(page, 'advanced');
    await page.locator('.settings-row', { hasText: 'Set webhook template' }).count();
    await openSettings(page, 'notifications');
    await page.getByRole('button', { name: 'Set Template' }).click();
    const webhook = page.getByRole('dialog').filter({ hasText: 'Webhook template' });
    await webhook.waitFor({ timeout: 10_000 });
    check('the webhook template dialog opens from here too', await webhook.isVisible());
    await webhook.getByRole('button', { name: 'Cancel' }).click();
    await webhook.waitFor({ state: 'detached' }).catch(() => {});
}

async function phoneAndLight(browser, errors) {
    say('Capturing the phone and light layouts');
    const phone = await newPage(browser, 'phone', errors);
    await openSettings(phone, 'main');
    await shoot(phone, 'settings-main-phone');
    // The rail scrolls sideways rather than wrapping, so it is one line at any width.
    const rail = phone.locator('.settings-tabs');
    const one_line = await rail.evaluate(node => node.scrollHeight <= node.clientHeight + 2);
    check('the tab rail stays on one line on a phone', one_line);
    await openSettings(phone, 'downloader');
    await shoot(phone, 'settings-downloader-phone');
    await phone.context().close();

    const light = await newPage(browser, 'desktop', errors, 'default');
    await openSettings(light, 'main');
    await shoot(light, 'settings-main-light');
    await openSettings(light, 'advanced');
    await shoot(light, 'settings-advanced-light');
    await light.context().close();
}

// A log is read from the bottom, so the box opens there rather than on the oldest line it
// fetched. Seeded first, because a backend that has just booted has barely logged anything.
async function theLogsTab(page) {
    say('Checking the log opens on the newest line');
    await appendFile(join(RUN_DIR, 'appdata', 'logs', 'combined.log'),
        Array.from({ length: 80 }, (_, i) => JSON.stringify({
            level: 'info', message: `settings harness log line ${i + 1} of 80`, timestamp: new Date().toISOString()
        })).join('\n') + '\n');

    await openSettings(page, 'logs');
    const box = page.locator('.log-box');
    await box.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(500);

    const scroll = await box.evaluate(element => ({
        top: Math.round(element.scrollTop),
        height: element.scrollHeight,
        client: element.clientHeight
    }));
    check('the log box has more than fits in it', scroll.height > scroll.client, `${scroll.height}px in ${scroll.client}px`);
    check('and it opens scrolled to the newest line',
        Math.abs(scroll.top - (scroll.height - scroll.client)) <= 2, `scrollTop ${scroll.top}`);

    // The backend keeps logging while the harness runs, so the newest line is whatever it
    // wrote last rather than one of the seeded ones -- what matters is that it is in view.
    const lastLineInView = await box.evaluate(element => {
        const last = [...element.querySelectorAll('.log-line')].pop();
        if (!last) return false;
        // Measured on screen rather than from offsetTop, which is relative to whichever
        // ancestor happens to be positioned and not to the box being scrolled.
        const box_rect = element.getBoundingClientRect();
        const line_rect = last.getBoundingClientRect();
        return line_rect.bottom <= box_rect.bottom + 2 && line_rect.top >= box_rect.top - 2;
    });
    check('so the newest line is one of the ones in view', lastLineInView);
}

// The Users tab carries a read-only account of the single sign-on settings. OIDC cannot be on
// when the backend boots without a real provider to discover -- it exits -- so this boots a
// second time in multi-user mode and turns it on the way an admin editing the config would.
async function theOIDCPanel(browser, errors) {
    say('Checking the single sign-on panel');
    const admin_password = 'settings-harness-password';
    const post = async (route, body, jwt) => {
        const response = await fetch(`${BASE}/api/${route}${jwt ? `?jwt=${encodeURIComponent(jwt)}` : ''}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error(`/api/${route} answered ${response.status}`);
        return response.json();
    };

    await post('auth/register', { userid: 'admin', username: 'admin', password: admin_password });
    const { token } = await post('auth/login', { username: 'admin', password: admin_password });

    const current = await (await fetch(`${BASE}/api/config?jwt=${encodeURIComponent(token)}`)).json();
    const config = current['config_file'];
    Object.assign(config['YtdlMaterial']['Users']['oidc'], {
        enabled: true,
        issuer_url: 'https://id.example.com/realms/media',
        client_id: 'ytdl-material',
        client_secret: 'a-secret-that-must-not-be-printed',
        redirect_uri: `${BASE}/api/auth/oidc/callback`,
        scope: '',
        auto_register: false,
        admin_claim: 'groups',
        admin_value: 'media-admins',
        group_claim: 'roles',
        allowed_groups: '',
        username_claim: '',
        display_name_claim: 'name'
    });
    await post('setConfig', { new_config_file: config }, token);

    const page = await newPage(browser, 'desktop', errors);
    await page.context().addInitScript(jwt => localStorage.setItem('jwt_token', jwt), token);
    await openSettings(page, 'users');

    const panel = page.locator('.settings-section', { hasText: 'Single sign-on' });
    await panel.waitFor({ timeout: 20_000 });
    check('the Users tab is reachable in multi-user mode',
        await page.getByRole('tab', { name: 'Users', exact: true }).getAttribute('aria-selected') === 'true');

    const text = await panel.innerText();
    check('the panel says the provider could not be reached', text.includes('Not connected'));
    check('and what that means for signing in', text.includes('will fail until this is fixed'));
    check('it says each secret is set', (text.match(/Set/g) ?? []).length >= 3);
    check('but prints none of them',
        !text.includes('a-secret-that-must-not-be-printed') && !text.includes('id.example.com') && !text.includes('ytdl-material'));
    check('it fills in the value the backend falls back to', text.includes('openid profile email') && text.includes('preferred_username'));
    check('and the values that were set', text.includes('groups = media-admins') && text.includes('roles') && text.includes('Any group'));
    check('auto-registration is reported as it was left', /Register users on first sign-in\s*No/.test(text), text.includes('sign-in\nNo') ? 'No' : '');
    check('nothing in the panel can be typed into', await panel.locator('input, textarea, mat-slide-toggle').count() === 0);

    await shoot(page, 'settings-users-oidc-desktop');

    // Off again, and the tab goes back to what it was.
    const restored = await (await fetch(`${BASE}/api/config?jwt=${encodeURIComponent(token)}`)).json();
    restored['config_file']['YtdlMaterial']['Users']['oidc']['enabled'] = false;
    await post('setConfig', { new_config_file: restored['config_file'] }, token);
    // A reload, not a navigation: the page holds the config it was handed when the app
    // started, and moving between routes never asks for it again.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Who can sign in').waitFor({ timeout: 20_000 });
    check('and with OIDC off the panel is not there at all',
        await page.locator('.settings-section', { hasText: 'Single sign-on' }).count() === 0);

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

    say(`Staging the backend in ${RUN_DIR}`);
    await rm(RUN_DIR, { recursive: true, force: true });
    await mkdir(SHOTS_DIR, { recursive: true });
    await copyBackend(RUN_DIR);
    await writeMigrationFlags(RUN_DIR);

    say(`Booting the backend on ${BASE}...`);
    const backend = await startBackend(RUN_DIR, PORT);

    const browser = await chromium.launch();
    const errors = [];
    try {
        const page = await newPage(browser, 'desktop', errors);
        await everyTab(page);
        await theUsersTab(page);
        await savingAndCancelling(page);
        await notificationChips(page);
        await categories(page);
        await theDialogsSettingsOpens(page);
        await theLogsTab(page);
        await page.context().close();
        await phoneAndLight(browser, errors);
    } catch (error) {
        await browser.close();
        await releaseBackend(backend, false, BASE);
        throw error;
    }

    // The rest of the page is checked without accounts, which is the common way to run this
    // server. The single sign-on panel only exists with them, so it gets its own boot.
    await stopBackend(backend);
    let multi_user_backend = null;
    try {
        say('Rebooting in multi-user mode');
        multi_user_backend = await startBackend(RUN_DIR, PORT, { ytdl_multi_user_mode: 'true' });
        await theOIDCPanel(browser, errors);

        for (const error of errors) console.log(`    page console error: ${error.slice(0, 200)}`);
        check('no page errors', errors.length === 0);
        console.log(`    screenshots: ${SHOTS_DIR}`);
    } finally {
        await browser.close();
        if (multi_user_backend) await releaseBackend(multi_user_backend, keep, BASE);
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
