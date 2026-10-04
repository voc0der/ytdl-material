const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const { startApp, addSampleMedia } = require('./helpers/app-process');

/*************************************************
 * A yt-dlp for the server to run, which answers
 * from scenario.json beside it, so a check goes
 * through the real routes with no network. Tests
 * rewrite the scenario between requests: `source`
 * is the channel's own record, `listing` its
 * uploads. A listing with a delay is still going
 * for that long before it exits, as a check under
 * way is. Every call is appended to calls.jsonl.
 ************************************************/
const FAKE_YT_DLP = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const is_source = args.includes('--dump-single-json');
const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
const answer = scenario[is_source ? 'source' : 'listing'] || {};
for (const entry of answer.entries || []) process.stdout.write(JSON.stringify(entry) + '\\n');
if (answer.error) process.stderr.write(answer.error + '\\n');
process.exitCode = answer.error ? 1 : 0;
if (answer.delay) setTimeout(() => {}, answer.delay);
`;

const channel = (name, overrides = {}) => ({id: name, title: name, uploader: name, channel_id: name, thumbnails: [], ...overrides});

const upload = (id, overrides = {}) => ({
    id,
    title: `Upload ${id}`,
    extractor: 'generic',
    extractor_key: 'Generic',
    webpage_url: `https://example.com/watch/${id}`,
    url: `https://example.com/watch/${id}`,
    ...overrides
});

/*************************************************
 * The subscription routes on the real server,
 * with a server of their own: a check runs in the
 * background after the request that started it
 * has been answered, and anything it leaves
 * running would otherwise outlive the test. One
 * of these also used to take the server down.
 *
 * Downloads are held at zero at a time, so what a
 * check queues stays queued where a test can see
 * it, rather than running the fake yt-dlp as a
 * download.
 ************************************************/
describe('Subscriptions on the server as it runs', function() {
    this.timeout(30000);

    let app;
    let bin;

    const answer = async (scenario) => fs.writeJSON(path.join(bin, 'scenario.json'), scenario);
    const calls = async () => (await fs.readFile(path.join(bin, 'calls.jsonl'), 'utf8'))
        .split('\n').filter(Boolean).map(line => JSON.parse(line));
    const listings = async (url) => (await calls()).filter(args => !args.includes('--dump-single-json') && args.includes(url));

    const getSub = async (id) => (await app.api.post('/api/getSubscription').send({id}).expect(200)).body;
    const getSubs = async () => (await app.api.post('/api/getSubscriptions').send({}).expect(200)).body.subscriptions;
    const getDownloads = async () => (await app.api.post('/api/downloads').send({page_size: 100}).expect(200)).body.downloads;

    const waitFor = async (predicate, what, timeout_ms = 10000) => {
        const start = Date.now();
        while ((Date.now() - start) < timeout_ms) {
            if (await predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.fail(`timed out waiting for ${what}\n--- server output ---\n${app.output()}`);
    };
    const checkFinished = (id) => waitFor(async () => {
        const {subscription} = await getSub(id);
        return !subscription.downloading && !subscription.refresh_status.active;
    }, 'the check to finish');
    // Resolves true if the server exits within the window.
    const exitsWithin = (ms) => Promise.race([
        app.exited.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), ms))
    ]);

    // Subscribes to a channel the fake yt-dlp knows, and waits out the check that follows.
    const subscribe = async (url, name, listing = {entries: []}) => {
        await answer({source: {entries: [channel(name)]}, listing});
        const res = await app.api.post('/api/subscribe').send({url, maxQuality: 'best', audioOnly: false}).expect(200);
        assert(res.body.new_sub, `subscribing failed: ${JSON.stringify(res.body)}`);
        await checkFinished(res.body.new_sub.id);
        return res.body.new_sub;
    };

    // Runs a check that lists the given uploads, and waits for it to finish.
    const check = async (sub, entries) => {
        const checks = (await listings(sub.url)).length;
        await answer({source: {entries: [channel(sub.name)]}, listing: {entries}});
        await app.api.post('/api/checkSubscription').send({sub_id: sub.id}).expect(200);
        await waitFor(async () => (await listings(sub.url)).length > checks, 'the check to list the uploads');
        await checkFinished(sub.id);
        return (await getSub(sub.id)).subscription;
    };

    // Puts a downloaded upload into a subscription's folder and has the server register it.
    const addSubscriptionFile = async (sub, id, info = {}) => {
        await addSampleMedia(path.join(app.media.subscriptions, 'channels', sub.name), {
            name: id,
            info: {id, extractor: 'generic', extractor_key: 'Generic', webpage_url: `https://example.com/watch/${id}`, title: `Upload ${id}`, ...info}
        });
        await app.api.post('/api/runTask').send({task_key: 'missing_db_records'}).expect(200);
        const {files} = await getSub(sub.id);
        const file = files.find(candidate => candidate.url === `https://example.com/watch/${id}`);
        assert(file, `the server did not register ${id}`);
        return file;
    };

    before(async function() {
        app = await startApp({
            env: {ytdl_max_concurrent_downloads: '0'},
            prepare: async ({root}) => {
                bin = path.join(root, 'appdata', 'bin');
                await fs.ensureDir(bin);
                await fs.writeFile(path.join(bin, 'yt-dlp'), FAKE_YT_DLP, {mode: 0o755});
                await fs.writeFile(path.join(bin, 'calls.jsonl'), '');
            }
        });
    });

    after(async function() {
        if (app) await app.stop();
    });

    it('gives a subscription whose name is taken a folder of its own', async function() {
        const first = await subscribe('https://example.com/c/taken-one', 'Taken Name');
        const second = await subscribe('https://example.com/c/taken-two', 'Taken Name');

        assert.strictEqual(second.name, `Taken Name - ${second.id}`);
        const backup = (name) => fs.readJSON(path.join(app.media.subscriptions, 'channels', name, 'subscription_backup.json'));
        // Its metadata was written under the name it was given, over the first one's backup.
        assert.strictEqual((await backup('Taken Name')).id, first.id);
        assert.strictEqual((await backup(second.name)).id, second.id);
    });

    it('answers for a subscription whose link could not be read, so it can be removed', async function() {
        await answer({source: {error: 'ERROR: Unsupported URL: https://example.com/c/unreadable'}});
        const res = await app.api.post('/api/subscribe').send({url: 'https://example.com/c/unreadable', name: null}).expect(200);
        assert.strictEqual(res.body.new_sub, null);

        // Kept without a name, the way the list shows it.
        const sub = (await getSubs()).find(candidate => candidate.url === 'https://example.com/c/unreadable');
        assert(sub, 'the subscription was not kept');
        assert(!sub.name);

        // Its page asked for it and was answered with a 500, every second it was open.
        const {subscription, files} = await getSub(sub.id);
        assert.strictEqual(subscription.id, sub.id);
        assert.strictEqual(subscription.file_count, 0);
        assert.deepStrictEqual(files, []);

        const left = await app.api.post('/api/unsubscribe').send({sub_id: sub.id, deleteMode: true}).expect(200);
        assert.strictEqual(left.body.success, true);
    });

    it('stays up when the folder of a subscription cannot be made', async function() {
        // Longer than a folder name may be, as the name of a channel can be.
        const name = '日本語のプレイリスト'.repeat(30);
        await answer({source: {entries: [channel(name)]}, listing: {entries: []}});
        const res = await app.api.post('/api/subscribe').send({url: 'https://example.com/c/long-name'}).expect(200);

        assert.strictEqual(await exitsWithin(500), false, `the server exited:\n${app.output()}`);
        await checkFinished(res.body.new_sub.id);
        const {subscription} = await getSub(res.body.new_sub.id);
        assert.strictEqual(subscription.refresh_status.phase, 'error');
        assert.match(subscription.refresh_status.error, /ENAMETOOLONG/);
    });

    it('has no route that starts a check in the name of stopping one', async function() {
        const sub = await subscribe('https://example.com/c/misnamed', 'Misnamed Channel');
        const checks = (await listings('https://example.com/c/misnamed')).length;

        // Asked for as JSON, the way the app asks: a page request would be handed the app instead.
        await app.api.post('/api/cancelSubscriptionCheck').set('Accept', 'application/json').send({sub_id: sub.id}).expect(404);

        await new Promise(resolve => setTimeout(resolve, 250));
        assert.strictEqual((await listings('https://example.com/c/misnamed')).length, checks);
    });

    it('stops a check under way when unsubscribing, so nothing is queued for a subscription that is gone', async function() {
        const sub = await subscribe('https://example.com/c/abandoned', 'Abandoned Channel');
        // The listing finds two uploads, and is still going when the subscription is removed.
        await answer({source: {entries: [channel('Abandoned Channel')]}, listing: {entries: [upload('abandoned-1'), upload('abandoned-2')], delay: 1000}});
        await app.api.post('/api/checkSubscription').send({sub_id: sub.id}).expect(200);
        // What it has found so far is written as it finds the first.
        await waitFor(async () => (await getSub(sub.id)).subscription.refresh_status.discovered_count > 0, 'the check to find the uploads');
        assert.strictEqual((await getSub(sub.id)).subscription.downloading, true);

        const left = await app.api.post('/api/unsubscribe').send({sub_id: sub.id, deleteMode: true}).expect(200);
        assert.strictEqual(left.body.success, true);

        // Past the point where the listing would have finished on its own, and queued both, to
        // fail once they started for want of their subscription.
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.deepStrictEqual((await getDownloads()).filter(download => download.sub_id === sub.id), []);
    });

    it('keeps a video deleted for good from coming back, whatever its extractor calls itself', async function() {
        const sub = await subscribe('https://example.com/c/vods', 'Vods Channel');
        // One of a family of extractors, as yt-dlp names those of some sites.
        const family = {extractor: 'twitch:vod', extractor_key: 'TwitchVod'};
        const file = await addSubscriptionFile(sub, 'vod-1', family);

        await app.api.post('/api/deleteSubscriptionFile').send({file_uid: file.uid, deleteForever: true}).expect(200);

        const checked = await check(sub, [upload('vod-1', family)]);
        assert.strictEqual(checked.refresh_status.queued_count, 0);
    });

    it('deletes only what a subscription downloaded through the route for subscription files', async function() {
        const video_path = await addSampleMedia(app.media.video, {
            name: 'not-subscribed',
            info: {id: 'not-subscribed', extractor: 'generic', webpage_url: 'https://example.com/watch/not-subscribed'}
        });
        await app.api.post('/api/runTask').send({task_key: 'missing_db_records'}).expect(200);
        const file = (await app.api.get('/api/getMp4s').expect(200)).body.mp4s.find(mp4 => mp4.url === 'https://example.com/watch/not-subscribed');
        assert(file, 'the server did not register the video');

        // Deleting other files takes the filemanager permission, which this route does not ask for.
        await app.api.post('/api/deleteSubscriptionFile').send({file_uid: file.uid, deleteForever: false}).expect(404);

        assert.strictEqual(await fs.pathExists(video_path), true);
    });
});
