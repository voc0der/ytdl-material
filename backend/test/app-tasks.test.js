const assert = require('assert');

const { startApp } = require('./helpers/app-process');

/*************************************************
 * The tasks page's routes on the real server, with
 * a server of their own rather than the one
 * app-server.test.js shares: one of these used to
 * take the server down, and every test after it
 * would have gone down with it.
 ************************************************/
describe('Tasks on the server as it runs', function() {
    this.timeout(30000);

    let app;

    const getTask = async (task_key) => (await app.api.post('/api/getTask').send({task_key}).expect(200)).body.task;

    // Resolves true if the server exits within the window, which a crash after the
    // response has gone does well inside it.
    const exitsWithin = (ms) => Promise.race([
        app.exited.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), ms))
    ]);

    before(async function() {
        app = await startApp();
    });

    after(async function() {
        if (app) await app.stop();
    });

    it('stays up when a task set to act on its own finds nothing to act on', async function() {
        // No age to delete files older than, so the run finds nothing. The confirm that
        // followed it threw, after the response had gone, and the server exited.
        await app.api.post('/api/updateTaskOptions').send({
            task_key: 'delete_old_files',
            new_options: {auto_confirm: true, blacklist_files: false, blacklist_subscription_files: false, threshold_days: ''}
        }).expect(200);

        const ran = await app.api.post('/api/runTask').send({task_key: 'delete_old_files'}).expect(200);
        assert.strictEqual(ran.body.success, true);

        assert.strictEqual(await exitsWithin(500), false, `the server exited:\n${app.output()}`);
        const task = await getTask('delete_old_files');
        assert.strictEqual(task.confirming, false);
        assert.match(task.error, /no limit was set/);
    });
});
