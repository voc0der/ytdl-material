const assert = require('assert');
const fs = require('fs-extra');
const http = require('http');
const path = require('path');

const { startApp, addSampleMedia } = require('./helpers/app-process');

/*************************************************
 * A yt-dlp for the server to run, which answers
 * from scenario.json beside it, so a check goes
 * through the real routes with no network. Tests
 * rewrite the scenario between requests: `source`
 * is the channel's own record, `listing` its
 * uploads. A listing that hangs stays alive until
 * it is killed, as a check under way does, and
 * one with a delay exits on its own once it is
 * up. Every call is appended to calls.jsonl, and
 * the pid of the latest listing is left in
 * listing.pid.
 ************************************************/
const FAKE_YT_DLP = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const is_source = args.includes('--dump-single-json');
if (!is_source) fs.writeFileSync(path.join(__dirname, 'listing.pid'), String(process.pid));
const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
const answer = scenario[is_source ? 'source' : 'listing'] || {};
for (const entry of answer.entries || []) process.stdout.write(JSON.stringify(entry) + '\\n');
if (answer.error) process.stderr.write(answer.error + '\\n');
process.exitCode = answer.error ? 1 : 0;
if (answer.hang) setInterval(() => {}, 1000);
else if (answer.delay) setTimeout(() => {}, answer.delay);
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

const isRunning = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code !== 'ESRCH';
    }
};

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

    // Left by a server stopped halfway through a check. It goes into the database the way an
    // older install's does, which the server imports as it starts.
    const interrupted = {
        id: 'interrupted-sub',
        name: 'Interrupted Channel',
        url: 'https://example.com/c/interrupted',
        type: 'video',
        isPlaylist: false,
        paused: true,
        downloading: true,
        child_process: {pid: 999999},
        refresh_status: {active: true, phase: 'collecting', discovered_count: 3, started_at: Date.now() - 60000}
    };

    before(async function() {
        app = await startApp({
            env: {ytdl_max_concurrent_downloads: '0'},
            prepare: async ({root}) => {
                bin = path.join(root, 'appdata', 'bin');
                await fs.ensureDir(bin);
                await fs.writeFile(path.join(bin, 'yt-dlp'), FAKE_YT_DLP, {mode: 0o755});
                await fs.writeFile(path.join(bin, 'calls.jsonl'), '');
                await fs.writeJSON(path.join(root, 'appdata', 'db.json'), {subscriptions: [interrupted]});
            }
        });
    });

    after(async function() {
        if (app) await app.stop();
    });

    it('lets go of a check the last shutdown cut off', async function() {
        const {subscription} = await getSub(interrupted.id);

        assert.strictEqual(subscription.downloading, false);
        assert.strictEqual(subscription.refresh_status.active, false);
        assert.strictEqual(subscription.refresh_status.phase, 'cancelled');
        assert.strictEqual(subscription.refresh_status.discovered_count, 3);

        // So it can be checked again.
        const checked = await check(interrupted, []);
        assert.strictEqual(checked.refresh_status.phase, 'complete');
    });

    it('subscribes under the name its source gives, and queues what the first check finds', async function() {
        const sub = await subscribe('https://example.com/c/first', 'First Channel', {entries: [upload('first-1'), upload('first-2')]});

        assert.strictEqual(sub.name, 'First Channel');
        const {subscription} = await getSub(sub.id);
        assert.strictEqual(subscription.refresh_status.phase, 'queued');
        assert.strictEqual(subscription.refresh_status.queued_count, 2);
        assert.strictEqual(subscription.refresh_status.pending_download_count, 2);

        const [listing] = await listings('https://example.com/c/first');
        assert(listing.includes('--flat-playlist'));
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

    it('finds a subscription by name, and leaves its files out when asked to', async function() {
        const sub = await subscribe('https://example.com/c/named', 'Named Channel');
        await addSubscriptionFile(sub, 'named-1');

        const by_name = (await app.api.post('/api/getSubscription').send({name: 'Named Channel'}).expect(200)).body;
        assert.strictEqual(by_name.subscription.id, sub.id);
        assert.strictEqual(by_name.subscription.file_count, 1);
        assert.strictEqual(by_name.files.length, 1);

        const without_files = (await app.api.post('/api/getSubscription').send({id: sub.id, include_videos: false}).expect(200)).body;
        assert.deepStrictEqual(without_files.files, []);
        assert.strictEqual(without_files.subscription.videos, undefined);
        assert.strictEqual(without_files.subscription.file_count, 1);

        await app.api.post('/api/getSubscription').send({id: 'no-such-subscription'}).expect(400);
    });

    it('subscribes with a date range and a file name of its own', async function() {
        await answer({source: {entries: [channel('Dated Channel')]}, listing: {entries: []}});
        const res = await app.api.post('/api/subscribe')
            .send({url: 'https://example.com/c/dated', timerange: 'now-7days', customFileOutput: '%(upload_date)s %(title)s'})
            .expect(200);
        await checkFinished(res.body.new_sub.id);

        const {subscription} = await getSub(res.body.new_sub.id);
        assert.strictEqual(subscription.timerange, 'now-7days');
        assert.strictEqual(subscription.custom_output, '%(upload_date)s %(title)s');
    });

    it('refuses arguments a download may not be given', async function() {
        const refused = await app.api.post('/api/subscribe')
            .send({url: 'https://example.com/c/refused', customArgs: '--exec,,touch /tmp/owned'})
            .expect(400);
        assert.strictEqual(refused.body.success, false);
        assert.match(refused.body.error, /--exec/);
        assert(!(await getSubs()).some(sub => sub.url === 'https://example.com/c/refused'));

        const sub = await subscribe('https://example.com/c/kept', 'Kept Channel');
        const update = await app.api.post('/api/updateSubscription')
            .send({subscription: {id: sub.id, custom_args: '--exec,,touch /tmp/owned'}})
            .expect(400);
        assert.strictEqual(update.body.success, false);
        assert.strictEqual((await getSub(sub.id)).subscription.custom_args, undefined);
    });

    it('saves a change of settings', async function() {
        const sub = await subscribe('https://example.com/c/settings', 'Settings Channel');

        const updated = await app.api.post('/api/updateSubscription').send({subscription: {id: sub.id, paused: true, maxQuality: '720'}}).expect(200);

        assert.strictEqual(updated.body.success, true);
        const {subscription} = await getSub(sub.id);
        assert.strictEqual(subscription.paused, true);
        assert.strictEqual(subscription.maxQuality, '720');
    });

    it('checks a channel as soon as its playlists are asked for, since only a check finds them', async function() {
        const sub = await subscribe('https://example.com/c/collector', 'Collector Channel');
        const checks = (await listings(sub.url)).length;

        const updated = await app.api.post('/api/updateSubscription').send({subscription: {id: sub.id, retrieve_channel_playlists: true}}).expect(200);

        assert.strictEqual(updated.body.success, true);
        await waitFor(async () => (await listings(sub.url)).length > checks, 'a check to start');
        await checkFinished(sub.id);
    });

    it('checks a subscription on request, and stops a check under way', async function() {
        const sub = await subscribe('https://example.com/c/stoppable', 'Stoppable Channel');
        await answer({source: {entries: [channel('Stoppable Channel')]}, listing: {entries: [upload('stoppable-1')], hang: true}});

        const checked = await app.api.post('/api/checkSubscription').send({sub_id: sub.id}).expect(200);
        assert.strictEqual(checked.body.success, true);
        await waitFor(async () => (await listings('https://example.com/c/stoppable')).length === 2, 'the check to list the uploads');
        await waitFor(async () => (await getSub(sub.id)).subscription.refresh_status.discovered_count === 1, 'the check to find the upload');
        const pid = Number(await fs.readFile(path.join(bin, 'listing.pid'), 'utf8'));

        const stopped = await app.api.post('/api/cancelCheckSubscription').send({sub_id: sub.id}).expect(200);

        assert.strictEqual(stopped.body.success, true);
        // Killed by the time the answer comes, but reaped by the server a moment later.
        await waitFor(() => !isRunning(pid), 'the listing to exit', 5000);
        const {subscription} = await getSub(sub.id);
        assert.strictEqual(subscription.downloading, false);
        assert.strictEqual(subscription.refresh_status.phase, 'cancelled');
        assert.deepStrictEqual((await getDownloads()).filter(download => download.sub_id === sub.id), []);

        // Nothing is running now, so there is nothing to stop.
        const again = await app.api.post('/api/cancelCheckSubscription').send({sub_id: sub.id}).expect(200);
        assert.strictEqual(again.body.success, false);
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

    it('starts the downloads of a subscription on request', async function() {
        const sub = await subscribe('https://example.com/c/on-request', 'On Request Channel');
        await answer({source: {entries: [channel('On Request Channel')]}, listing: {entries: [upload('on-request-1')]}});

        const started = await app.api.post('/api/downloadVideosForSubscription').send({subID: sub.id}).expect(200);

        assert.strictEqual(started.body.success, true);
        await waitFor(async () => (await getSub(sub.id)).subscription.refresh_status.pending_download_count === 1, 'the upload to be queued');

        const missing = await app.api.post('/api/downloadVideosForSubscription').send({subID: 'no-such-subscription'}).expect(200);
        assert.strictEqual(missing.body.success, false);
    });

    it('deletes a subscription file, and keeps it from coming back when asked to', async function() {
        const sub = await subscribe('https://example.com/c/deleting', 'Deleting Channel');
        const kept_out = await addSubscriptionFile(sub, 'deleting-1');
        const allowed_back = await addSubscriptionFile(sub, 'deleting-2');

        await app.api.post('/api/deleteSubscriptionFile').send({file_uid: kept_out.uid, deleteForever: true}).expect(200);
        await app.api.post('/api/deleteSubscriptionFile').send({file_uid: allowed_back.uid, deleteForever: false}).expect(200);

        assert.strictEqual(await fs.pathExists(kept_out.path), false);
        assert.strictEqual(await fs.pathExists(allowed_back.path), false);
        assert.strictEqual((await getSub(sub.id)).subscription.file_count, 0);

        // The next check passes over the one deleted for good, and downloads the other again.
        const checked = await check(sub, [upload('deleting-1'), upload('deleting-2')]);
        assert.strictEqual(checked.refresh_status.queued_count, 1);

        await app.api.post('/api/deleteSubscriptionFile').send({file_uid: kept_out.uid, deleteForever: true}).expect(404);
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

    it('deletes a subscription file that was already deleted by hand', async function() {
        const sub = await subscribe('https://example.com/c/by-hand', 'By Hand Channel');
        const deleted = await addSubscriptionFile(sub, 'by-hand-1');
        const redownloaded = await addSubscriptionFile(sub, 'by-hand-2');
        await fs.remove(deleted.path);
        await fs.remove(redownloaded.path);

        // Refused as no regular file, its record stayed in the library for good.
        const res = await app.api.post('/api/deleteSubscriptionFile').send({file_uid: deleted.uid, deleteForever: false}).expect(200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual((await getSub(sub.id)).subscription.file_count, 1);

        // And "Delete and redownload" failed on it every time it was asked.
        await answer({source: {entries: [channel('By Hand Channel')]}, listing: {entries: [upload('by-hand-1'), upload('by-hand-2')]}});
        const redownload = await app.api.post('/api/redownloadSubscription').send({sub_id: sub.id}).expect(200);
        assert.deepStrictEqual(redownload.body, {success: true, deleted_count: 1, failed_count: 0, refresh_started: true});
        await waitFor(async () => (await getSub(sub.id)).subscription.refresh_status.pending_download_count === 2, 'both uploads to be queued again');
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

    it('unsubscribes, and deletes what was downloaded with it', async function() {
        const sub = await subscribe('https://example.com/c/leaving', 'Leaving Channel');
        const file = await addSubscriptionFile(sub, 'leaving-1');

        const left = await app.api.post('/api/unsubscribe').send({sub_id: sub.id, deleteMode: true}).expect(200);

        assert.strictEqual(left.body.success, true);
        assert.strictEqual(await fs.pathExists(file.path), false);
        assert(!(await getSubs()).some(candidate => candidate.id === sub.id));

        const again = await app.api.post('/api/unsubscribe').send({sub_id: sub.id, deleteMode: true}).expect(200);
        assert.strictEqual(again.body.success, false);
        assert.match(again.body.error, /not found/);
    });

    it('deletes the files of a subscription and downloads them again', async function() {
        const sub = await subscribe('https://example.com/c/again', 'Again Channel');
        const file = await addSubscriptionFile(sub, 'again-1');
        await answer({source: {entries: [channel('Again Channel')]}, listing: {entries: [upload('again-1')]}});

        const redownload = await app.api.post('/api/redownloadSubscription').send({sub_id: sub.id}).expect(200);

        assert.deepStrictEqual(redownload.body, {success: true, deleted_count: 1, failed_count: 0, refresh_started: true});
        assert.strictEqual(await fs.pathExists(file.path), false);
        await waitFor(async () => (await getSub(sub.id)).subscription.refresh_status.pending_download_count === 1, 'the upload to be queued again');
    });

    it('serves the artwork of a subscription once it has some', async function() {
        const image = Buffer.from('89504e470d0a1a0a', 'hex');
        const artwork_server = http.createServer((req, res) => {
            res.writeHead(200, {'Content-Type': 'image/png'});
            res.end(image);
        });
        await new Promise(resolve => artwork_server.listen(0, '127.0.0.1', resolve));
        const artwork_url = `http://127.0.0.1:${artwork_server.address().port}/avatar.png`;

        try {
            const plain = await subscribe('https://example.com/c/plain', 'Plain Channel');
            await app.api.get(`/api/subscriptionArtwork/${plain.id}`).expect(404);

            await answer({source: {entries: [channel('Pictured Channel', {thumbnails: [{id: 'avatar_uncropped', url: artwork_url, width: 88, height: 88}]})]}, listing: {entries: []}});
            const res = await app.api.post('/api/subscribe').send({url: 'https://example.com/c/pictured'}).expect(200);
            await checkFinished(res.body.new_sub.id);

            const served = await app.api.get(`/api/subscriptionArtwork/${res.body.new_sub.id}`).buffer(true).expect(200);
            assert.match(served.headers['content-type'], /image\/png/);
            assert.deepStrictEqual(Buffer.from(served.body), image);
        } finally {
            await new Promise(resolve => artwork_server.close(resolve));
        }
    });

    it('keeps no artwork that is not an image, or that never arrives', async function() {
        const artwork_server = http.createServer((req, res) => {
            if (req.url === '/cut-off.png') {
                res.destroy();
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end('<html><body>Not an image</body></html>');
        });
        await new Promise(resolve => artwork_server.listen(0, '127.0.0.1', resolve));
        const artwork_base = `http://127.0.0.1:${artwork_server.address().port}`;

        try {
            for (const [slug, artwork_path] of [['page', '/avatar'], ['cut-off', '/cut-off.png']]) {
                const name = `Artless ${slug}`;
                await answer({source: {entries: [channel(name, {thumbnails: [{id: 'avatar_uncropped', url: artwork_base + artwork_path, width: 88, height: 88}]})]}, listing: {entries: []}});
                const res = await app.api.post('/api/subscribe').send({url: `https://example.com/c/artless-${slug}`}).expect(200);
                await checkFinished(res.body.new_sub.id);

                await app.api.get(`/api/subscriptionArtwork/${res.body.new_sub.id}`).expect(404);
                assert.strictEqual((await getSub(res.body.new_sub.id)).subscription.artwork_file, undefined);
            }
        } finally {
            await new Promise(resolve => artwork_server.close(resolve));
        }
    });
});
