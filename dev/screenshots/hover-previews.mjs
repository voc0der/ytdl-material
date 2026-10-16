// Checks real media requests against a throwaway library, with Chromium's network throttled.
// Usage: node dev/screenshots/hover-previews.mjs [--skip-build]
// Requires the screenshot harness's Playwright/Chromium dependencies and ffmpeg.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import {
    CACHE, buildFrontend, copyBackend, hasFrontendBuild, say, startBackend, stopBackend,
    writeMigrationFlags
} from './stage.mjs';

async function unusedPort() {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitFor(condition, description) {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
        assert.ok(Date.now() < deadline, description);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

if (!process.argv.includes('--skip-build') || !hasFrontendBuild()) await buildFrontend();
await mkdir(CACHE, {recursive: true});
const runDir = await mkdtemp(join(CACHE, 'hover-previews-'));
await copyBackend(runDir);
await mkdir(join(runDir, 'video'), {recursive: true});
const clip = join(runDir, 'video', 'preview.mp4');
await promisify(execFile)('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip
]);
await promisify(execFile)('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', clip, '-frames:v', '1', join(runDir, 'video', 'preview.jpg')
]);
const fileSize = (await stat(clip)).size;
const files = [1, 2, 3].map(index => ({
    uid: `preview-${index}`, id: `preview-${index}`, title: `Preview ${index}`, isAudio: false,
    duration: 60, registered: Date.now() - index, path: 'video/preview.mp4', size: fileSize,
    thumbnailPath: 'video/preview.jpg', thumbnailURL: 'local', source_metadata_checked: true
}));
await writeMigrationFlags(runDir);
await writeFile(join(runDir, 'appdata', 'local_db.json'), JSON.stringify({files, playlists: []}));

const port = await unusedPort();
const base = `http://localhost:${port}`;
let backend;
let browser;
try {
    backend = await startBackend(runDir, port);
    browser = await chromium.launch({headless: true});
    for (const [layout, width] of [['grid', 1280], ['list', 412]]) {
        const context = await browser.newContext({viewport: {width, height: 1000}});
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${base}/#/home`);
        const cards = page.locator('app-unified-file-card');
        await cards.nth(2).locator('img').waitFor();
        assert.equal(await cards.first().evaluate(card => card.classList.contains('list-layout')), layout === 'list');

        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', {cacheDisabled: true});
        await cdp.send('Network.emulateNetworkConditions', {
            offline: false, latency: 20, downloadThroughput: 256 * 1024, uploadThroughput: -1
        });
        const requests = new Map();
        let maxActiveFiles = 0;
        cdp.on('Network.requestWillBeSent', event => {
            const url = new URL(event.request.url);
            if (url.pathname !== '/api/stream') return;
            requests.set(event.requestId, {uid: url.searchParams.get('uid'), bytes: 0, done: false, cancelled: false});
            const activeFiles = new Set([...requests.values()].filter(request => !request.done).map(request => request.uid));
            maxActiveFiles = Math.max(maxActiveFiles, activeFiles.size);
        });
        cdp.on('Network.dataReceived', event => {
            const request = requests.get(event.requestId);
            if (request) request.bytes += event.dataLength;
        });
        cdp.on('Network.loadingFinished', event => {
            const request = requests.get(event.requestId);
            if (request) request.done = true;
        });
        cdp.on('Network.loadingFailed', event => {
            const request = requests.get(event.requestId);
            if (request) Object.assign(request, {done: true, cancelled: event.canceled});
        });
        const allStopped = () => [...requests.values()].every(request => request.done);
        async function playing(index) {
            await page.waitForFunction(cardIndex => {
                const video = document.querySelectorAll('app-unified-file-card')[cardIndex]?.querySelector('video');
                return video && !video.paused && video.currentTime > 0;
            }, index, {timeout: 20_000});
        }

        // Passing over a card must not start a request.
        await cards.first().hover();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(600);
        assert.equal(requests.size, 0);

        await cards.first().hover();
        await playing(0);
        await page.mouse.move(0, 0);
        await waitFor(allStopped, 'Leaving the card must cancel its request');
        assert.ok([...requests.values()].some(request => request.cancelled));

        // Re-entering still plays. Omit mouseleave deliberately to exercise the global guard.
        await cards.first().hover();
        await playing(0);
        await cards.nth(1).locator(':scope > div').dispatchEvent('mouseenter');
        await playing(1);
        assert.equal(await page.locator('video.preview-video').count(), 1);
        assert.equal(maxActiveFiles, 1, 'At most one file may be streaming, even without mouseleave');

        // Switching library tabs destroys cards without relying on a pointer leave.
        await page.locator('.library-switch', {hasText: 'Playlists'}).evaluate(button => button.click());
        await waitFor(allStopped, 'Removing the cards must cancel the last preview');
        assert.equal(await page.locator('video.preview-video').count(), 0);
        assert.ok([...requests.values()].every(request => request.bytes < fileSize / 2), 'No preview should finish downloading');
        assert.deepEqual(errors, []);
        say(`${layout}: hover playback, cancellation, re-entry, one active stream, and card removal passed`);
        console.log(JSON.stringify([...requests.values()]));
        await context.close();
    }
} finally {
    if (browser) await browser.close();
    if (backend) await stopBackend(backend);
    say(`Test library: ${runDir}`);
}
