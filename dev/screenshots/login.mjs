// Drives the login page in multi-user mode, end to end: a wrong password, registering an
// account, and logging in with it.
//
// The page only exists with accounts, so the backend boots in multi-user mode with an admin
// already registered (without one the app opens the create-admin dialog over the page instead).
// Registration is left on, as it ships. Every request to register is counted, because the
// registration form once submitted itself whenever a password field was clicked into.
//
// The backend limits /api/auth to 25 requests in 15 minutes per address. A run makes about ten,
// and the count lives in the backend process, which every run boots afresh.
//
// Nothing is mocked: the frontend is built from the working tree and the backend runs from a
// throwaway copy (see stage.mjs). It downloads nothing. Screenshots at a desktop and a phone
// width, light and dark, are left in the shots folder it prints.
//
// Usage: node login.mjs [--skip-build] [--keep]
//   --keep leaves the backend running, with the admin account and the one registered here.

import { chromium } from 'playwright';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CACHE, buildFrontend, copyBackend, hasFrontendBuild, isListening, releaseBackend, say,
    startBackend, writeMigrationFlags
} from './stage.mjs';

const RUN_DIR = join(CACHE, 'login');
const SHOTS_DIR = join(RUN_DIR, 'shots');
// Beside the README capture's 17449, subscriptions' 17450, downloads' 17451, dialogs' 17452,
// settings' 17453, notifications' 17454 and library's 17455.
const PORT = 17456;
const BASE = `http://localhost:${PORT}`;

const ADMIN_PASSWORD = 'login-harness-admin';
const NEW_USER = 'harness-user';
const NEW_PASSWORD = 'login-harness-password';

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

async function post(route, body) {
    const response = await fetch(`${BASE}/api/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json().catch(() => null) };
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
        // A wrong password is answered with a 401, which the browser logs as a failed request.
        // That is the page working, not a finding.
        if (message.type() === 'error' && !message.text().includes('401')) errors.push(`${device}/${theme}: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`${device}/${theme}: ${error.message}`));
    page.registerRequests = 0;
    page.on('request', request => {
        if (request.url().includes('/api/auth/register')) page.registerRequests++;
    });
    page.refused = [];
    page.on('response', response => {
        if (response.status() === 401) page.refused.push(new URL(response.url()).pathname);
    });
    return page;
}

async function shoot(page, name) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

const card = page => page.locator('.login-card');
const fields = page => card(page).locator('.login-form input');
const submit = page => card(page).locator('.login-submit');

async function openLogin(page) {
    await page.goto(`${BASE}/#/login`, { waitUntil: 'domcontentloaded' });
    await card(page).locator('.login-form').waitFor({ timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
}

async function loggingIn(page) {
    say('Logging in with the wrong password');
    await page.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
    await card(page).locator('.login-form').waitFor({ timeout: 30_000 });
    check('a page that needs an account sends you to log in', page.url().includes('/login'), page.url().split('#')[1]);
    check('it is headed by what it is for', (await card(page).locator('.login-title').innerText()).trim() === 'Log in');
    check('and the app it is for', (await card(page).locator('.login-subtitle').innerText()).includes('ytdl-material'));
    check('the admin exists, so nothing asks to create one', await page.locator('app-set-default-admin-dialog').count() === 0);
    // The app around the page used to ask for notifications, subscriptions and categories with
    // nobody logged in, earning a 401 and a console error for each.
    await page.waitForLoadState('networkidle').catch(() => {});
    check('nothing on the page asks for what needs an account', page.refused.length === 0, page.refused.join(', '));
    check('and there is no bell for notifications nobody can have',
        await page.locator('mat-toolbar button:has(mat-icon:text-matches("^notifications"))').count() === 0);
    check('it asks for a user name and a password', await fields(page).count() === 2);
    const labels = await card(page).locator('.login-field-label').allInnerTexts();
    check('each with a label above it, not inside it', labels.join('|') === 'User name|Password', labels.join(', '));
    check('it cannot be submitted empty', await submit(page).isDisabled());

    const button = await submit(page).boundingBox();
    const form = await card(page).locator('.login-form').boundingBox();
    const cardBox = await card(page).boundingBox();
    check('the button sits in the card, as wide as the fields',
        Math.abs(button.width - form.width) < 1 && button.y + button.height < cardBox.y + cardBox.height - 8);

    await fields(page).nth(0).fill('admin');
    await fields(page).nth(1).fill('not-the-password');
    await fields(page).nth(1).press('Enter');
    const alert = card(page).locator('[role="alert"]');
    await alert.waitFor({ timeout: 10_000 });
    check('Enter submits, and a wrong password is said on the card', (await alert.innerText()).includes('User name or password is incorrect!'));
    check('without leaving the page, or forgetting where to go afterwards', page.url().includes('/login?returnTo='), page.url().split('#')[1]);
    check('and without calling a wrong password an expired login',
        await page.locator('.mat-mdc-snack-bar-label', { hasText: 'Login expired' }).count() === 0);

    await card(page).locator('.login-field .kit-icon-button').click();
    check('the password can be shown', await fields(page).nth(1).getAttribute('type') === 'text');
    await card(page).locator('.login-field .kit-icon-button').click();
    await shoot(page, 'login-error-desktop');
}

async function registering(page) {
    say('Registering an account');
    await card(page).getByRole('radio', { name: 'Register' }).click();
    check('registering asks for the password twice', await fields(page).count() === 3);
    check('and says so in the heading', (await card(page).locator('.login-title').innerText()).trim() === 'Create an account');
    check('the error from logging in is gone', await card(page).locator('[role="alert"]').count() === 0);

    // The form used to register on any click into either password field. With the fields still
    // empty that only failed validation, so they are filled in first, the way somebody going back
    // to fix a typo would have them.
    await fields(page).nth(0).fill(NEW_USER);
    await fields(page).nth(1).fill(NEW_PASSWORD);
    await fields(page).nth(2).fill(NEW_PASSWORD);
    await fields(page).nth(1).click();
    await fields(page).nth(2).click();
    await page.waitForTimeout(500);
    check('clicking into a password field registers nobody', page.registerRequests === 0, `${page.registerRequests} requests`);

    await fields(page).nth(2).fill(`${NEW_PASSWORD}-typo`);
    await submit(page).click();
    const alert = card(page).locator('[role="alert"]');
    await alert.waitFor();
    check('passwords that differ are caught before anything is sent',
        (await alert.innerText()).includes('The passwords do not match.') && page.registerRequests === 0);
    await shoot(page, 'login-register-desktop');

    await fields(page).nth(2).fill(NEW_PASSWORD);
    await submit(page).click();
    const notice = card(page).locator('[role="status"]');
    await notice.waitFor({ timeout: 10_000 });
    check('registering says it worked', (await notice.innerText()).includes(`Registered ${NEW_USER}`));
    check('and goes back to logging in with the new name in', (await card(page).locator('.login-title').innerText()).trim() === 'Log in'
        && await fields(page).nth(0).inputValue() === NEW_USER);
    check('one request, one account', page.registerRequests === 1, `${page.registerRequests} requests`);

    await fields(page).nth(1).fill(NEW_PASSWORD);
    await submit(page).click();
    await page.waitForURL(url => url.hash.startsWith('#/home'), { timeout: 20_000 }).catch(() => {});
    check('the new account logs in and lands on the home page', page.url().includes('/home'), page.url().split('#')[1]);
    check('with a session to come back to', !!(await page.evaluate(() => localStorage.getItem('jwt_token'))));
}

async function elsewhere(browser, errors) {
    say('Checking a phone width, and the light theme');
    const phone = await newPage(browser, 'phone', errors, 'light');
    await openLogin(phone);
    const fits = await phone.evaluate(() => {
        const card = document.querySelector('.login-card').getBoundingClientRect();
        return card.left >= 0 && card.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth + 1;
    });
    check('the card fits on a phone', fits);
    await shoot(phone, 'login-phone-light');
    await phone.context().close();

    const light = await newPage(browser, 'desktop', errors, 'light');
    await openLogin(light);
    await shoot(light, 'login-desktop-light');
    await light.context().close();

    const dark = await newPage(browser, 'phone', errors, 'dark');
    await openLogin(dark);
    await dark.getByRole('radio', { name: 'Register' }).click();
    await shoot(dark, 'login-register-phone-dark');
    await dark.context().close();
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

    say(`Booting the backend in multi-user mode on ${BASE}...`);
    const backend = await startBackend(RUN_DIR, PORT, { ytdl_multi_user_mode: 'true' });

    const browser = await chromium.launch();
    const errors = [];
    try {
        const admin = await post('auth/register', { userid: 'admin', username: 'admin', password: ADMIN_PASSWORD });
        check('the admin account is registered', admin.status === 200 && admin.body?.user, `${admin.status}`);

        const page = await newPage(browser, 'desktop', errors);
        await loggingIn(page);
        await registering(page);
        await page.context().close();
        await elsewhere(browser, errors);

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
