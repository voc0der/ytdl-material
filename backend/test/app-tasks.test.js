const assert = require('assert');
const fs = require('fs-extra');

const { startApp, addSampleMedia } = require('./helpers/app-process');

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
    let video_path;

    const getTask = async (task_key) => (await app.api.post('/api/getTask').send({task_key}).expect(200)).body.task;

    // Resolves true if the server exits within the window, which a crash after the
    // response has gone does well inside it.
    const exitsWithin = (ms) => Promise.race([
        app.exited.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), ms))
    ]);

    before(async function() {
        app = await startApp({
            prepare: async ({media}) => {
                video_path = await addSampleMedia(media.video);
            }
        });
        await app.api.post('/api/runTask').send({task_key: 'missing_db_records'}).expect(200);
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

    it('removes what a run found once it is confirmed', async function() {
        const [video] = (await app.api.get('/api/getMp4s').expect(200)).body.mp4s;
        await fs.remove(video_path);

        await app.api.post('/api/runTask').send({task_key: 'missing_files_check'}).expect(200);
        assert.deepStrictEqual((await getTask('missing_files_check')).data, {uids: [video.uid]});

        const confirmed = await app.api.post('/api/confirmTask').send({task_key: 'missing_files_check'}).expect(200);
        assert.strictEqual(confirmed.body.success, true);
        assert.deepStrictEqual((await app.api.get('/api/getMp4s').expect(200)).body.mp4s, []);
        assert.strictEqual((await getTask('missing_files_check')).data, null);
    });

    it('keeps a task whose confirm failed usable', async function() {
        // Findings the confirm cannot act on. It threw, the request failed with a 500,
        // and the task stayed confirming, refusing every run after it until a restart.
        await app.api.post('/api/updateTaskData').send({task_key: 'duplicate_files_check', new_data: {uids: null}}).expect(200);

        const confirmed = await app.api.post('/api/confirmTask').send({task_key: 'duplicate_files_check'}).expect(200);
        assert.strictEqual(confirmed.body.success, false);

        const task = await getTask('duplicate_files_check');
        assert.strictEqual(task.confirming, false);
        assert(task.error, 'expected the failure to be on the task');

        const ran = await app.api.post('/api/runTask').send({task_key: 'duplicate_files_check'}).expect(200);
        assert.strictEqual(ran.body.success, true);
    });

    it('refuses to run, confirm or schedule a task that does not exist', async function() {
        // Running or confirming one failed with a 500, and scheduling one said it worked.
        for (const route of ['/api/runTask', '/api/confirmTask']) {
            const res = await app.api.post(route).send({task_key: 'no_such_task'}).expect(200);
            assert.deepStrictEqual(res.body, {success: false}, route);
        }

        const scheduled = await app.api.post('/api/updateTaskSchedule').send({task_key: 'no_such_task', new_schedule: null}).expect(200);
        assert.deepStrictEqual(scheduled.body, {success: false});
    });

    it('refuses a single run at a time already gone by, and keeps the schedule it had', async function() {
        // Saved anyway, it left the task showing as scheduled, with nothing to run it.
        const daily = {type: 'recurring', data: {hour: 3, minute: 30}};
        await app.api.post('/api/updateTaskSchedule').send({task_key: 'backup_local_db', new_schedule: daily}).expect(200);

        try {
            const res = await app.api.post('/api/updateTaskSchedule').send({
                task_key: 'backup_local_db',
                new_schedule: {type: 'timestamp', data: {timestamp: Date.now() - 60 * 60 * 1000}}
            }).expect(200);

            assert.deepStrictEqual(res.body, {success: false});
            const task = await getTask('backup_local_db');
            assert.deepStrictEqual(task.schedule, daily);
            assert(task.next_invocation > Date.now(), 'expected the daily run to still be coming');
        } finally {
            await app.api.post('/api/updateTaskSchedule').send({task_key: 'backup_local_db', new_schedule: null}).expect(200);
        }
    });

    it('runs the schedules a restore brings back, and only those', async function() {
        // Nothing rescheduled the tasks a restore brought back until the next restart. A
        // restored schedule never ran, and the jobs of the schedules it replaced went on.
        const schedule = (task_key, new_schedule) => app.api.post('/api/updateTaskSchedule').send({task_key, new_schedule}).expect(200);
        const at_half_past_four = {type: 'recurring', data: {hour: 4, minute: 30}};
        await schedule('missing_files_check', at_half_past_four);
        await schedule('duplicate_files_check', {type: 'recurring', data: {hour: 5, minute: 0}});
        await app.api.post('/api/runTask').send({task_key: 'backup_local_db'}).expect(200);
        const [backup] = (await app.api.post('/api/getDBBackups').send({}).expect(200)).body.db_backups;

        const replaced_run_at = Date.now() + 60 * 60 * 1000;
        await schedule('missing_files_check', null);
        await schedule('duplicate_files_check', {type: 'timestamp', data: {timestamp: replaced_run_at}});

        const restored = await app.api.post('/api/restoreDBBackup').send({file_name: backup.name}).expect(200);
        assert.strictEqual(restored.body.success, true);

        const missing_files_check = await getTask('missing_files_check');
        assert.deepStrictEqual(missing_files_check.schedule, at_half_past_four);
        assert(missing_files_check.next_invocation > Date.now(), 'expected the restored schedule to run');

        // What runs next is the restored 05:00, not the single run it replaced.
        const next_run = (await getTask('duplicate_files_check')).next_invocation;
        assert.notStrictEqual(next_run, replaced_run_at, 'the replaced schedule is still the one that runs');
        assert.deepStrictEqual([new Date(next_run).getHours(), new Date(next_run).getMinutes()], [5, 0]);

        await schedule('missing_files_check', null);
        await schedule('duplicate_files_check', null);
    });

    // Last: a reset puts every task back the way it started.
    it('stops the schedules a reset removes', async function() {
        // A reset dropped each task's job without stopping it, so each went on firing at
        // its old time. The subscription check, which a reset schedules again, ran then as
        // well as at the midnight the reset gave it.
        await app.api.post('/api/updateTaskSchedule').send({
            task_key: 'subscriptions_check',
            new_schedule: {type: 'timestamp', data: {timestamp: Date.now() + 2000}}
        }).expect(200);
        await app.api.post('/api/resetTasks').send({}).expect(200);

        await new Promise(resolve => setTimeout(resolve, 3000));

        const task = await getTask('subscriptions_check');
        assert.strictEqual(task.last_ran, null, 'the check ran at the time the reset removed');
        assert.strictEqual(task.schedule.type, 'recurring');
    });
});
