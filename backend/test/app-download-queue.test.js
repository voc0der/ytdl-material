const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const { startApp } = require('./helpers/app-process');

function queued(uid, user_uid, fields) {
    return {
        uid: uid,
        user_uid: user_uid,
        url: `https://example.com/clips/${uid}`,
        type: 'video',
        title: uid,
        options: {},
        finished_step: true,
        finished: false,
        running: false,
        paused: false,
        error: null,
        timestamp_start: Date.now(),
        ...fields
    };
}

// One of each state, for the administrator and for someone else.
const QUEUE = ['admin', 'alice'].flatMap(user => [
    queued(`${user}-waiting`, user, {}),
    queued(`${user}-paused`, user, {paused: true}),
    queued(`${user}-paused-failed`, user, {paused: true, error: 'ERROR: the connection dropped', error_type: 'network'}),
    queued(`${user}-failed`, user, {finished: true, error: 'ERROR: video unavailable', error_type: 'unavailable'}),
    queued(`${user}-done`, user, {finished: true, percent_complete: 100})
]);

/*************************************************
 * The downloads page's buttons that act on the
 * whole queue, on a multi-user server where each
 * person's queue is their own.
 *
 * The concurrency limit is 0, so nothing ever
 * starts: resuming a download marks it ready to
 * run, and no downloader is involved.
 ************************************************/
describe('The download queue all at once', function() {
    this.timeout(30000);

    let app;
    let session;

    const as_admin = route => app.api.post(route).query({jwt: session});
    // Every entry, as the database holds it, by state for each user.
    const queue = () => {
        const {download_queue} = fs.readJSONSync(path.join(app.root, 'appdata', 'local_db.json'));
        const describe_entry = entry => `${entry.uid}:${entry.paused ? 'paused' : entry.finished ? 'finished' : 'ready'}`;
        return download_queue.map(describe_entry).sort();
    };

    before(async function() {
        app = await startApp({
            env: {ytdl_multi_user_mode: 'true', ytdl_max_concurrent_downloads: '0'},
            prepare: async ({root}) => {
                await fs.outputJSON(path.join(root, 'appdata', 'db.json'), {
                    simplified_db_migration_complete: true,
                    new_db_system_migration_complete: true
                });
                await fs.outputJSON(path.join(root, 'appdata', 'local_db.json'), {download_queue: QUEUE});
            }
        });
        await app.api.post('/api/auth/register').send({userid: 'admin', username: 'admin', password: 'admin-password'}).expect(200);
        session = (await app.api.post('/api/auth/login').send({username: 'admin', password: 'admin-password'}).expect(200)).body.token;
    });

    after(async function() {
        if (app) await app.stop();
    });

    it('pauses everything of yours that is still to run', async function() {
        const res = await as_admin('/api/pauseAllDownloads').send({}).expect(200);
        assert(res.body.success);

        assert.deepStrictEqual(queue(), [
            'admin-done:finished', 'admin-failed:finished', 'admin-paused-failed:paused', 'admin-paused:paused', 'admin-waiting:paused',
            'alice-done:finished', 'alice-failed:finished', 'alice-paused-failed:paused', 'alice-paused:paused', 'alice-waiting:ready'
        ]);
    });

    it('resumes everything of yours that is paused, except what failed', async function() {
        const res = await as_admin('/api/resumeAllDownloads').send({}).expect(200);
        assert(res.body.success);

        assert.deepStrictEqual(queue(), [
            'admin-done:finished', 'admin-failed:finished', 'admin-paused-failed:paused', 'admin-paused:ready', 'admin-waiting:ready',
            'alice-done:finished', 'alice-failed:finished', 'alice-paused-failed:paused', 'alice-paused:paused', 'alice-waiting:ready'
        ]);
    });

    it('clears what is paused and what failed, and leaves the rest', async function() {
        assert((await as_admin('/api/clearDownloads').send({clear_paused: true}).expect(200)).body.success);
        assert.deepStrictEqual(queue().filter(entry => entry.startsWith('admin-')), [
            'admin-done:finished', 'admin-failed:finished', 'admin-paused:ready', 'admin-waiting:ready'
        ]);

        assert((await as_admin('/api/clearDownloads').send({clear_errors: true}).expect(200)).body.success);
        assert.deepStrictEqual(queue(), [
            'admin-done:finished', 'admin-paused:ready', 'admin-waiting:ready',
            'alice-done:finished', 'alice-failed:finished', 'alice-paused-failed:paused', 'alice-paused:paused', 'alice-waiting:ready'
        ]);
    });

    it('leaves the queue to its administrator', async function() {
        await app.api.post('/api/auth/register').send({userid: 'bob', username: 'bob', password: 'bob-password'}).expect(200);
        const bob = (await app.api.post('/api/auth/login').send({username: 'bob', password: 'bob-password'}).expect(200)).body.token;
        const before = queue();

        for (const route of ['/api/pauseAllDownloads', '/api/resumeAllDownloads', '/api/clearDownloads']) {
            await app.api.post(route).query({jwt: bob}).send({clear_paused: true, clear_errors: true, clear_finished: true}).expect(403);
        }
        assert.deepStrictEqual(queue(), before);
    });
});
