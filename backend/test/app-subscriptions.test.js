const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const { startApp } = require('./helpers/app-process');

/*************************************************
 * A yt-dlp for the server to run, which answers
 * from scenario.json beside it, so a check goes
 * through the real routes with no network. Tests
 * rewrite the scenario between requests: `source`
 * is the channel's own record, `listing` its
 * uploads. Every call is appended to calls.jsonl.
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
`;

const channel = (name, overrides = {}) => ({id: name, title: name, uploader: name, channel_id: name, thumbnails: [], ...overrides});

/*************************************************
 * The subscription routes on the real server,
 * with a server of their own: a check runs in the
 * background after the request that started it
 * has been answered, and anything it leaves
 * running would otherwise outlive the test.
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

    // Subscribes to a channel the fake yt-dlp knows, and waits out the check that follows.
    const subscribe = async (url, name, listing = {entries: []}) => {
        await answer({source: {entries: [channel(name)]}, listing});
        const res = await app.api.post('/api/subscribe').send({url, maxQuality: 'best', audioOnly: false}).expect(200);
        assert(res.body.new_sub, `subscribing failed: ${JSON.stringify(res.body)}`);
        await checkFinished(res.body.new_sub.id);
        return res.body.new_sub;
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

    it('has no route that starts a check in the name of stopping one', async function() {
        const sub = await subscribe('https://example.com/c/misnamed', 'Misnamed Channel');
        const checks = (await listings('https://example.com/c/misnamed')).length;

        // Asked for as JSON, the way the app asks: a page request would be handed the app instead.
        await app.api.post('/api/cancelSubscriptionCheck').set('Accept', 'application/json').send({sub_id: sub.id}).expect(404);

        await new Promise(resolve => setTimeout(resolve, 250));
        assert.strictEqual((await listings('https://example.com/c/misnamed')).length, checks);
    });
});
