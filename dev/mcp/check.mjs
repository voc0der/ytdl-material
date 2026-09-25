// Drives the MCP server in mcp-server/ against a real backend, the way an MCP client would:
// over stdio, with an API token, through every tool.
//
// The backend runs in multi-user mode from a throwaway copy (see ../screenshots/stage.mjs),
// seeded with an admin's library and downloads in every state, and one file of another
// account's that the admin must not see. The server is started with uv, as the docs tell
// people to, so a run also proves the script's inline dependencies still resolve.
//
// Nothing is mocked. The one download it starts points at a closed local port, so it fails
// at once and nothing is fetched; the backend's usual downloader update check at boot is
// the only network access.
//
// Usage: node dev/mcp/check.mjs [--keep]
//   --keep leaves the backend running with both accounts afterwards.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import {
    CACHE, HERE as SCREENSHOTS, REPO_ROOT, copyBackend, isListening, releaseBackend, say, sleep, startBackend,
    writeMigrationFlags
} from '../screenshots/stage.mjs';

const SERVER = join(REPO_ROOT, 'mcp-server', 'ytdl_material_mcp.py');
const RUN_DIR = join(CACHE, 'mcp');
// After the sharing harness's 17459.
const PORT = 17460;
const BASE = `http://localhost:${PORT}`;
// Links must be built from YTDL_PUBLIC_URL, not from the address the API was reached at.
const PUBLIC = 'https://media.example.com';
// Nothing listens on the discard port, so a download of this fails without leaving the host.
const DEAD_URL = 'http://127.0.0.1:9/nothing-here';

const ADMIN = { uid: 'admin', name: 'admin', password: 'mcp-harness-admin' };
const VIEWER = { uid: 'viewer', name: 'viewer', password: 'mcp-harness-viewer' };

const TOOLS = ['search_library', 'list_downloads', 'start_download', 'pause_download', 'resume_download', 'cancel_download'];

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok });
    const mark = ok ? '\x1b[0;32m✓\x1b[0m' : '\x1b[0;31m✗\x1b[0m';
    console.log(`    ${mark} ${name}${detail ? ` (${detail})` : ''}`);
}

function stableUid(id) {
    const hex = createHash('sha256').update(`ytdl-material-mcp:${id}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function api(route, body = {}, jwt = null) {
    const query = jwt ? `?${new URLSearchParams({ jwt })}` : '';
    const response = await fetch(`${BASE}/api/${route}${query}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}

// The admin gets five files -- one of them audio, one a favourite -- a playlist, and a
// download in each state the tools read or act on. The viewer gets one file and one paused
// download, which the admin's tools must neither list nor touch.
async function seed() {
    const library = JSON.parse(await readFile(join(SCREENSHOTS, 'fixtures', 'library.json'), 'utf8'));
    const downloaded = Date.parse(library.downloaded);

    const file = (owner, video, index, extra = {}) => ({
        id: video.id, title: video.title, thumbnailURL: null, isAudio: false, duration: video.duration, url: '',
        uploader: video.uploader, size: 2538, path: `users/${owner.uid}/video/${video.id}.mp4`,
        upload_date: `${video.upload_date.slice(0, 4)}-${video.upload_date.slice(4, 6)}-${video.upload_date.slice(6, 8)}`,
        favorite: false, uid: stableUid(`${owner.uid}:${video.id}`), user_uid: owner.uid,
        registered: downloaded - index * 60_000, ...extra
    });
    const admin_files = library.videos.slice(0, 5).map((video, index) => file(ADMIN, video, index, {
        ...(index === 1 ? { favorite: true } : {}),
        ...(index === 4 ? { isAudio: true, path: `users/admin/audio/${video.id}.mp3` } : {})
    }));
    const viewer_file = file(VIEWER, library.videos[5], 0);

    const playlist = {
        name: 'Launches', uids: admin_files.slice(0, 2).map(item => item.uid), id: stableUid('playlist'),
        thumbnailURL: null, registered: downloaded, randomize_order: false, duration: 0, user_uid: ADMIN.uid
    };

    let started = downloaded;
    const download = (key, owner, fields) => ({
        uid: stableUid(`download:${key}`), url: `${DEAD_URL}/${key}`, type: 'video', title: key, user_uid: owner.uid,
        options: {}, step_index: 0, paused: false, running: false, finished_step: true, finished: false,
        error: null, error_summary: null, error_type: null, percent_complete: null, timestamp_start: started += 60_000,
        ...fields
    });
    const downloads = {
        finished_file: download('finished_file', ADMIN, {
            finished: true, step_index: 3, percent_complete: 100, container: { uid: admin_files[0].uid }
        }),
        finished_playlist: download('finished_playlist', ADMIN, {
            finished: true, step_index: 3, percent_complete: 100, container: { id: playlist.id, uids: [] }
        }),
        failed: download('failed', ADMIN, {
            finished: true, error: 'ERROR: Unsupported URL', error_summary: 'ERROR: Unsupported URL'
        }),
        to_cancel: download('to_cancel', ADMIN, { paused: true }),
        to_resume: download('to_resume', ADMIN, { paused: true }),
        viewers: download('viewers', VIEWER, { paused: true })
    };

    await mkdir(join(RUN_DIR, 'appdata'), { recursive: true });
    await writeFile(join(RUN_DIR, 'appdata', 'local_db.json'), JSON.stringify({
        files: [...admin_files, viewer_file], playlists: [playlist], download_queue: Object.values(downloads)
    }, null, 2));
    await writeMigrationFlags(RUN_DIR);
    return { admin_files, viewer_file, playlist, downloads };
}

// Just enough of an MCP client: newline-delimited JSON-RPC over the server's stdio.
class Client {
    constructor(env) {
        const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ytdl_/i.test(key)));
        this.child = spawn('uv', ['run', '--quiet', '--script', SERVER], {
            env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe']
        });
        this.pending = new Map();
        this.next_id = 1;
        this.stderr = '';
        this.child.stderr.on('data', chunk => { this.stderr += chunk; });
        this.exited = new Promise(resolve => this.child.on('exit', code => {
            for (const { reject } of this.pending.values()) reject(new Error(`server exited (${code}): ${this.stderr.slice(-500)}`));
            this.pending.clear();
            resolve(code);
        }));
        createInterface({ input: this.child.stdout }).on('line', line => {
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                console.log(`    server wrote a line that is not JSON: ${line.slice(0, 200)}`);
                return;
            }
            const waiter = this.pending.get(message.id);
            if (!waiter) return;
            this.pending.delete(message.id);
            if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
            else waiter.resolve(message.result);
        });
    }

    send(message) {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    }

    // The first request also waits for uv, which may be resolving the dependencies.
    request(method, params = {}) {
        const id = this.next_id++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} got no answer in 120s: ${this.stderr.slice(-500)}`));
            }, 120_000);
            this.pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); }
            });
            this.send({ id, method, params });
        });
    }

    async initialize() {
        const result = await this.request('initialize', {
            protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ytdl-material-mcp-check', version: '1' }
        });
        this.send({ method: 'notifications/initialized' });
        return result;
    }

    // What a tool answered, parsed, and whether it was an error.
    async call(name, args = {}) {
        const result = await this.request('tools/call', { name, arguments: args });
        const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        let data = result.structuredContent ?? null;
        if (!data && !result.isError) {
            try { data = JSON.parse(text); } catch { data = null; }
        }
        return { error: !!result.isError, text, data };
    }

    async close() {
        this.child.stdin.end();
        const timer = setTimeout(() => this.child.kill('SIGKILL'), 5_000);
        await this.exited;
        clearTimeout(timer);
    }
}

async function withClient(env, body) {
    const client = new Client({ YTDL_URL: BASE, YTDL_PUBLIC_URL: PUBLIC, ...env });
    try {
        return await body(client, await client.initialize());
    } finally {
        await client.close();
    }
}

const link = params => `${PUBLIC}/#/player${Object.entries(params).map(([key, value]) => `;${key}=${value}`).join('')}`;

async function startingUp() {
    say('Checking the server refuses to start without a usable YTDL_URL');
    const client = new Client({ YTDL_URL: `localhost:${PORT}` });
    client.child.stdin.end();
    const code = await client.exited;
    check('it exits with an error naming YTDL_URL', code !== 0 && /YTDL_URL/.test(client.stderr), `exit ${code}`);
}

async function describing(client, initialized) {
    say('Checking what the server says about itself');
    check('it names itself ytdl-material', initialized.serverInfo?.name === 'ytdl-material', initialized.serverInfo?.name);
    check('its instructions say a download uid is not a library item', /download_uid/.test(initialized.instructions ?? ''));

    const { tools } = await client.request('tools/list');
    const names = tools.map(tool => tool.name).sort();
    check('it offers the six tools', JSON.stringify(names) === JSON.stringify([...TOOLS].sort()), names.join(', '));
    const tool = name => tools.find(item => item.name === name) ?? {};
    check('the two listing tools are marked read only',
        tool('search_library').annotations?.readOnlyHint === true && tool('list_downloads').annotations?.readOnlyHint === true);
    check('starting a download is not', tool('start_download').annotations?.readOnlyHint === false);
    check('cancelling is marked destructive', tool('cancel_download').annotations?.destructiveHint === true);
    check('the library limit is bounded in the schema', tool('search_library').inputSchema?.properties?.limit?.maximum === 25);
}

async function searching(client, seeded) {
    say('Searching the library');
    const { admin_files, viewer_file } = seeded;

    const all = await client.call('search_library');
    const uids = (all.data?.results ?? []).map(item => item.uid);
    check('an empty search lists all five of the admin\'s files', !all.error && all.data?.total === 5 && uids.length === 5,
        all.error ? all.text : `total ${all.data?.total}`);
    check('newest first', JSON.stringify(uids) === JSON.stringify(admin_files.map(item => item.uid)));
    check('and not the other account\'s file', !uids.includes(viewer_file.uid));
    const first = all.data?.results?.[0] ?? {};
    check('each result links to its player on the public address', first.link === link({ uid: admin_files[0].uid }), first.link);
    check('with its title, uploader, length and upload date',
        first.title === admin_files[0].title && first.uploader === 'NASA' && first.duration_seconds === admin_files[0].duration
        && first.uploaded === admin_files[0].upload_date && first.type === 'video');
    check('and when it was added, as a date', first.added === new Date(admin_files[0].registered).toISOString().replace('.000Z', '+00:00'),
        first.added);

    const apollo = await client.call('search_library', { query: 'apollo' });
    check('a query matches titles', apollo.data?.total === 1 && apollo.data.results[0]?.uid === admin_files[1].uid,
        apollo.error ? apollo.text : `${apollo.data?.total} found`);

    const audio = await client.call('search_library', { media_type: 'audio' });
    check('audio only finds the audio file', audio.data?.total === 1 && audio.data.results[0]?.type === 'audio');

    const favorites = await client.call('search_library', { favorites_only: true });
    check('favourites only finds the favourite', favorites.data?.total === 1 && favorites.data.results[0]?.favorite === true);

    const two = await client.call('search_library', { limit: 2 });
    check('a limit returns that many and still counts them all', two.data?.results?.length === 2 && two.data.total === 5);

    const too_many = await client.call('search_library', { limit: 100 });
    check('a limit over 25 is refused', too_many.error, too_many.text.slice(0, 80));
}

const listed = async client => {
    const answer = await client.call('list_downloads', { page_size: 25 });
    return new Map((answer.data?.downloads ?? []).map(item => [item.download_uid, item]));
};

async function listing(client, seeded) {
    say('Listing downloads');
    const { admin_files, playlist, downloads } = seeded;

    const all = await client.call('list_downloads');
    const by_uid = new Map((all.data?.downloads ?? []).map(item => [item.download_uid, item]));
    check('it lists the admin\'s five downloads', !all.error && all.data?.total === 5 && by_uid.size === 5,
        all.error ? all.text : `total ${all.data?.total}`);
    check('and not the other account\'s', !by_uid.has(downloads.viewers.uid));
    check('newest first', all.data?.downloads?.[0]?.download_uid === downloads.to_resume.uid);

    const state = key => by_uid.get(downloads[key].uid) ?? {};
    check('each in the state the Downloads page would show',
        state('finished_file').state === 'finished' && state('finished_playlist').state === 'finished'
        && state('failed').state === 'failed' && state('to_cancel').state === 'paused',
        [...by_uid.values()].map(item => item.state).join(', '));
    check('a finished download links to the file it made', state('finished_file').link === link({ uid: admin_files[0].uid }),
        state('finished_file').link);
    check('or to the playlist', state('finished_playlist').link === link({ playlist_id: playlist.id }), state('finished_playlist').link);
    check('a failed one says why', state('failed').error === 'ERROR: Unsupported URL');
    check('an unfinished one has no link', !('link' in state('to_cancel')));
    check('each says what it was downloading', state('to_cancel').source_url === downloads.to_cancel.url);

    const unfinished = await client.call('list_downloads', { unfinished_only: true });
    check('unfinished only lists the two paused ones', unfinished.data?.total === 2 && unfinished.data.downloads.length === 2
        && unfinished.data.downloads.every(item => item.state === 'paused'));

    const page0 = await client.call('list_downloads', { page_size: 2 });
    const page1 = await client.call('list_downloads', { page_size: 2, page: 1 });
    const first_uids = (page0.data?.downloads ?? []).map(item => item.download_uid);
    const second_uids = (page1.data?.downloads ?? []).map(item => item.download_uid);
    check('it pages', first_uids.length === 2 && second_uids.length === 2 && page1.data?.page === 1
        && !second_uids.some(uid => first_uids.includes(uid)));
}

async function controlling(client, seeded) {
    say('Pausing, resuming and cancelling');
    const { downloads } = seeded;

    const again = await client.call('pause_download', { download_uid: downloads.to_cancel.uid });
    check('pausing a paused download is an error', again.error, again.text.slice(0, 80));
    const finished = await client.call('cancel_download', { download_uid: downloads.finished_file.uid });
    check('so is cancelling a finished one', finished.error);
    const theirs = await client.call('cancel_download', { download_uid: downloads.viewers.uid });
    check('and cancelling another account\'s', theirs.error);
    const empty = await client.call('cancel_download', { download_uid: '' });
    check('an empty uid is refused', empty.error);

    const cancelled = await client.call('cancel_download', { download_uid: downloads.to_cancel.uid });
    check('cancelling a paused download succeeds', !cancelled.error && cancelled.data?.success === true, cancelled.text.slice(0, 80));
    check('and it is listed as cancelled', (await listed(client)).get(downloads.to_cancel.uid)?.state === 'cancelled');
    const revived = await client.call('resume_download', { download_uid: downloads.to_cancel.uid });
    check('a cancelled download cannot be resumed', revived.error);

    const resumed = await client.call('resume_download', { download_uid: downloads.to_resume.uid });
    check('resuming a paused download succeeds', !resumed.error && resumed.data?.success === true, resumed.text.slice(0, 80));
    const after = (await listed(client)).get(downloads.to_resume.uid)?.state;
    check('and it is no longer paused', after && after !== 'paused', after);
}

async function starting(client) {
    say('Starting a download');
    const before = (await client.call('list_downloads')).data?.total;

    const local = await client.call('start_download', { url: 'file:///etc/passwd' });
    check('a URL that is not http(s) is refused', local.error, local.text.slice(0, 80));
    check('before asking the backend', (await client.call('list_downloads')).data?.total === before);

    const started = await client.call('start_download', { url: DEAD_URL, media_type: 'audio' });
    const queued = started.data?.downloads?.[0] ?? {};
    check('a download is queued', !started.error && started.data?.downloads?.length === 1 && !!queued.download_uid,
        started.error ? started.text : queued.state);
    check('as audio, from that URL', queued.type === 'audio' && queued.source_url === DEAD_URL);
    check('and the answer carries none of the download\'s options', !('options' in queued));

    let state = null;
    let error = null;
    for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(1_000)) {
        const item = (await listed(client)).get(queued.download_uid);
        ({ state, error } = item ?? {});
        if (state === 'failed') break;
    }
    check('it shows up failing, with the reason', state === 'failed' && !!error, `${state}: ${(error ?? '').slice(0, 60)}`);
}

async function refusing(tokens) {
    say('Checking what other accounts and bad settings are told');

    await withClient({ YTDL_API_TOKEN: tokens.viewer }, async client => {
        const mine = await client.call('search_library');
        check('another account sees only its own library', mine.data?.total === 1);
        const downloads = await client.call('list_downloads');
        check('an account without the download manager is told which permission it lacks',
            downloads.error && /downloads_manager/.test(downloads.text) && /Settings/.test(downloads.text), downloads.text.slice(0, 120));
    });

    await withClient({ YTDL_API_TOKEN: 'ytdl_not-a-real-token' }, async client => {
        const answer = await client.call('search_library');
        check('a bad token is reported as refused', answer.error && /refused the API token/.test(answer.text), answer.text.slice(0, 80));
    });

    await withClient({}, async client => {
        const answer = await client.call('search_library');
        check('no token is reported as needed', answer.error && /YTDL_API_TOKEN/.test(answer.text), answer.text.slice(0, 80));
    });

    await withClient({ YTDL_URL: 'http://127.0.0.1:9', YTDL_API_TOKEN: tokens.admin }, async client => {
        const answer = await client.call('search_library');
        check('an unreachable instance is reported as such', answer.error && /Could not reach/.test(answer.text), answer.text.slice(0, 80));
    });
}

async function main() {
    const keep = process.argv.includes('--keep');

    if (await isListening(BASE)) {
        throw new Error(`something is already listening on ${BASE}. If it is a --keep run, stop it with: kill -- -$(cat ${join(RUN_DIR, 'backend.pid')})`);
    }

    await startingUp();

    say(`Staging the backend and two libraries in ${RUN_DIR}`);
    await rm(RUN_DIR, { recursive: true, force: true });
    await copyBackend(RUN_DIR);
    const seeded = await seed();

    say(`Booting the backend in multi-user mode on ${BASE}...`);
    const backend = await startBackend(RUN_DIR, PORT, { ytdl_multi_user_mode: 'true' });

    try {
        const tokens = {};
        for (const [key, account] of [['admin', ADMIN], ['viewer', VIEWER]]) {
            await api('auth/register', { userid: account.uid, username: account.name, password: account.password });
            const jwt = (await api('auth/login', { username: account.name, password: account.password })).body?.token;
            tokens[key] = (await api('generateAPIToken', { label: 'MCP harness' }, jwt)).body?.token;
            check(`the ${key} account has an API token`, !!tokens[key]);
        }

        await withClient({ YTDL_API_TOKEN: tokens.admin }, async (client, initialized) => {
            await describing(client, initialized);
            await searching(client, seeded);
            await listing(client, seeded);
            await controlling(client, seeded);
            await starting(client);
        });
        await refusing(tokens);
    } finally {
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
