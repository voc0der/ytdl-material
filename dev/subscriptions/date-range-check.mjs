// Times a subscription check with a date range against the real site: the case that used to
// fetch every upload a channel ever made, one at a time, to find the few inside the range.
//
// Boots the backend from a throwaway copy (see ../screenshots/stage.mjs) with downloads held
// at zero, so a check queues its finds and nothing is downloaded. It subscribes through the
// API, waits for the check, and reports how long subscribing and checking took, how many
// uploads the dated listing let the check skip, what was queued, and whether the channel's
// artwork was stored and is served. It unsubscribes before it stops.
//
// Not part of CI: it talks to the site, so it fails for reasons unrelated to any change.
//
// Usage: node dev/subscriptions/date-range-check.mjs [--url URL] [--range now-1week] [--keep]
//   --url    the channel or playlist to subscribe to (default: a channel with Shorts)
//   --range  the date range, in yt-dlp's --dateafter form (default: now-1week)
//   --keep   leave the backend running, still subscribed, afterwards

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CACHE, copyBackend, isListening, releaseBackend, say, sleep, startBackend, writeMigrationFlags
} from '../screenshots/stage.mjs';

const RUN_DIR = join(CACHE, 'date-range-check');
// After the MCP harness's 17460.
const PORT = 17461;
const BASE = `http://localhost:${PORT}`;

const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const index = argv.indexOf(name);
    return index !== -1 && index + 1 < argv.length ? argv[index + 1] : fallback;
};
const url = option('--url', 'https://www.youtube.com/@3blue1brown');
const range = option('--range', 'now-1week');
const keep = argv.includes('--keep');

async function api(route, body = {}) {
    const response = await fetch(`${BASE}/api/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${route} answered ${response.status}`);
    return response.json();
}

const seconds = since => `${((Date.now() - since) / 1000).toFixed(1)}s`;

if (await isListening(BASE)) {
    throw new Error(`something is already listening on ${BASE}. If it is a --keep run, stop it with: kill -- -$(cat ${join(RUN_DIR, 'backend.pid')})`);
}

say(`Staging the backend in ${RUN_DIR}`);
await rm(RUN_DIR, { recursive: true, force: true });
await copyBackend(RUN_DIR);
await writeMigrationFlags(RUN_DIR);
say(`Booting the backend on ${BASE}...`);
const backend = await startBackend(RUN_DIR, PORT, {
    ytdl_allow_subscriptions: 'true',
    // No Deno is assumed; yt-dlp can use the Node running this script instead.
    ytdl_js_runtimes: 'node',
    // Found uploads are queued and stay queued.
    ytdl_max_concurrent_downloads: '0',
    ytdl_logger_level: 'verbose'
});

let sub_id = null;
try {
    say(`Subscribing to ${url} for ${range}`);
    const subscribed_at = Date.now();
    const subscribed = await api('subscribe', { url, timerange: range });
    sub_id = subscribed.new_sub?.id;
    if (!sub_id) throw new Error(`subscribing failed: ${subscribed.error ?? 'no subscription returned'}`);
    console.log(`    subscribed in ${seconds(subscribed_at)}`);

    // The check starts as the subscribe call returns.
    const checked_at = Date.now();
    let sub = null;
    while (Date.now() - checked_at < 30 * 60_000) {
        sub = (await api('getSubscription', { id: sub_id, include_videos: false })).subscription;
        const phase = sub.refresh_status?.phase;
        if (!sub.refresh_status?.active && phase !== 'collecting' && phase !== 'queueing' && phase !== 'idle') break;
        await sleep(1000);
    }
    const status = sub.refresh_status ?? {};
    console.log(`    checked in ${seconds(checked_at)}: ${status.phase}, ${status.queued_count ?? 0} queued${status.error ? `, error: ${status.error}` : ''}`);

    const log = await readFile(join(RUN_DIR, 'backend.log'), 'utf8');
    const skipped = log.match(/skipping (\d+) uploads of .* that predate its date filter/);
    console.log(`    skipped from the dated listing without fetching: ${skipped ? skipped[1] : 'none'}`);

    const { downloads = [] } = await api('downloads', {});
    for (const download of downloads.filter(download => download.sub_id === sub_id)) {
        console.log(`    queued: ${download.url}`);
    }

    console.log(`    name: ${sub.name}, channel id: ${sub.channel_id ?? 'none'}`);
    if (sub.artwork_updated_at) {
        const artwork = await fetch(`${BASE}/api/subscriptionArtwork/${sub_id}?v=${sub.artwork_updated_at}`);
        const bytes = (await artwork.arrayBuffer()).byteLength;
        console.log(`    artwork: ${artwork.status} ${artwork.headers.get('content-type')}, ${bytes} bytes`);
    } else {
        console.log('    artwork: none stored');
    }
} finally {
    if (sub_id && !keep) await api('unsubscribe', { sub_id, deleteMode: true }).catch(() => {});
    await releaseBackend(backend, keep, BASE);
}
