const { assert, fs, os, path, uuid, db_api, utils, files_api, subscriptions_api, generateEmptyVideoFile, useTemporaryMediaRoots, CONSTS } = require('./test-shared');
const bcrypt = require('bcryptjs');

describe('Tasks', function() {
    const tasks_api = require('../tasks');
    const notifications_api = require('../notifications');

    async function waitForCondition(predicate, timeout_ms = 2000) {
        const start = Date.now();
        while (Date.now() - start < timeout_ms) {
            if (await predicate()) return true;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return false;
    }

    const getTask = (task_key) => db_api.getRecord('tasks', {key: task_key});

    // Merged into the options the task already has. Without nested mode the local database
    // stores 'options.x' as a key of its own, and the task never sees it.
    const setTaskOptions = (task_key, options) => db_api.updateRecord('tasks', {key: task_key},
        Object.fromEntries(Object.entries(options).map(([key, value]) => [`options.${key}`, value])), true);

    beforeEach(async function() {
        // await db_api.connectToDB();
        await db_api.removeAllRecords('tasks');

        const dummy_task = {
            run: async () => { await utils.wait(500); return true; },
            confirm: async () => { await utils.wait(500); return true; },
            title: 'Dummy task',
            job: null
        };
        tasks_api.TASKS['dummy_task'] = dummy_task;

        await tasks_api.setupTasks();
        // Jobs are kept apart from the task objects, so a job an earlier test scheduled
        // outlives the dummy task being replaced.
        await tasks_api.updateTaskSchedule('dummy_task', null);
    });
    it('Backup db', async function() {
        const backups_original = await utils.recFindByExt('appdata', 'bak');
        const original_length = backups_original.length;
        await tasks_api.executeTask('backup_local_db');
        const backups_new = await utils.recFindByExt('appdata', 'bak');
        const new_length = backups_new.length;
        assert(original_length === new_length-1);
    });

    it('Creates the subscription check task with a daily default schedule', async function() {
        const task = await db_api.getRecord('tasks', {key: 'subscriptions_check'});

        assert(task);
        assert.strictEqual(task['title'], 'Check subscriptions');
        assert.strictEqual(task['schedule']['type'], 'recurring');
        assert.strictEqual(task['schedule']['data']['hour'], 0);
        assert.strictEqual(task['schedule']['data']['minute'], 0);
        assert(!!tasks_api.TASKS['subscriptions_check']['job']);
    });

    it('Creates the playback transcode cleanup task with a quiet daily default schedule', async function() {
        const task = await db_api.getRecord('tasks', {key: 'delete_old_transcodes'});

        assert(task);
        assert.strictEqual(task['title'], 'Delete old playback transcodes');
        assert.strictEqual(task['schedule']['type'], 'recurring');
        assert.strictEqual(task['schedule']['data']['hour'], 0);
        assert.strictEqual(task['schedule']['data']['minute'], 0);
        assert(!!tasks_api.TASKS['delete_old_transcodes']['job']);
        // it runs every day, so a notification each time would only be noise
        assert.strictEqual(tasks_api.TASKS['delete_old_transcodes']['notifyOnFinish'], false);
    });

    it('Creates the apply categories task without a default schedule', async function() {
        const task = await db_api.getRecord('tasks', {key: 'apply_categories'});

        assert(task);
        assert.strictEqual(task['title'], 'Apply categories to existing files');
        assert.strictEqual(task['schedule'], null);
        assert.strictEqual(tasks_api.TASKS['apply_categories']['job'], null);
    });

    it('Creates the codec discovery task unscheduled, converting with no limit', async function() {
        const task = await db_api.getRecord('tasks', {key: 'codec_discovery'});

        assert(task);
        assert.strictEqual(task['title'], 'Codec discovery');
        assert.strictEqual(task['schedule'], null, 'it only runs when asked to until it is scheduled');
        assert.strictEqual(task['options']['convert_to_preferred'], true);
        assert.strictEqual(task['options']['max_conversions'], 0);
        assert.strictEqual(tasks_api.TASKS['codec_discovery']['runInBackground'], true);
    });

    it('Leaves a task that threw idle, with its error, rather than running forever', async function() {
        tasks_api.TASKS['dummy_task'].run = async () => { throw new Error('Task blew up!'); };
        tasks_api.TASKS['dummy_task'].confirm = null;

        await tasks_api.executeRun('dummy_task');

        const task = await db_api.getRecord('tasks', {key: 'dummy_task'});
        assert.strictEqual(task['running'], false);
        assert.strictEqual(task['error'], 'Task blew up!');
        assert(task['last_ran']);
    });

    it('Refreshes a stored task title on startup', async function() {
        await db_api.updateRecord('tasks', {key: 'youtubedl_update_check'}, {title: 'Old title'});
        await tasks_api.setupTasks();

        const task = await db_api.getRecord('tasks', {key: 'youtubedl_update_check'});
        assert.strictEqual(task['title'], 'Update yt-dlp');
    });

    it('Runs subscription checks from the task manager', async function() {
        const original_check_subscriptions = subscriptions_api.checkSubscriptions;
        let check_subscriptions_called = false;

        subscriptions_api.checkSubscriptions = async () => {
            check_subscriptions_called = true;
            return {success: true, checked: true, checked_count: 1, sub_ids: ['test-subscription']};
        };

        try {
            await tasks_api.executeRun('subscriptions_check');
            const task = await db_api.getRecord('tasks', {key: 'subscriptions_check'});

            assert(check_subscriptions_called);
            assert(task['last_ran']);
            assert.strictEqual(task['running'], false);
        } finally {
            subscriptions_api.checkSubscriptions = original_check_subscriptions;
        }
    });

    it('Does not send a generic task notification after checking subscriptions', async function() {
        const original_check_subscriptions = subscriptions_api.checkSubscriptions;
        const original_send_task_notification = notifications_api.sendTaskNotification;
        const notified_task_keys = [];

        subscriptions_api.checkSubscriptions = async () => {
            return {success: true, checked: true, checked_count: 1, sub_ids: ['test-subscription']};
        };
        notifications_api.sendTaskNotification = async (task_obj) => {
            notified_task_keys.push(task_obj.key);
        };

        try {
            await tasks_api.executeRun('subscriptions_check');
            await tasks_api.executeRun('dummy_task');

            assert.deepStrictEqual(notified_task_keys, ['dummy_task']);
        } finally {
            subscriptions_api.checkSubscriptions = original_check_subscriptions;
            notifications_api.sendTaskNotification = original_send_task_notification;
        }
    });

    it('Runs the scheduled subscription check task on startup', async function() {
        const original_check_subscriptions = subscriptions_api.checkSubscriptions;
        let check_subscriptions_called = false;

        subscriptions_api.checkSubscriptions = async () => {
            check_subscriptions_called = true;
            return {success: true, checked: true, checked_count: 1, sub_ids: ['startup-subscription']};
        };

        try {
            const success = await tasks_api.executeRunOnStartup('subscriptions_check');
            const task = await db_api.getRecord('tasks', {key: 'subscriptions_check'});

            assert.strictEqual(success, true);
            assert(check_subscriptions_called);
            assert(task['last_ran']);
        } finally {
            subscriptions_api.checkSubscriptions = original_check_subscriptions;
        }
    });

    it('Skips the startup subscription check when the task is not scheduled', async function() {
        const original_check_subscriptions = subscriptions_api.checkSubscriptions;
        let check_subscriptions_called = false;

        subscriptions_api.checkSubscriptions = async () => {
            check_subscriptions_called = true;
            return {success: true};
        };

        try {
            await tasks_api.updateTaskSchedule('subscriptions_check', null);
            const success = await tasks_api.executeRunOnStartup('subscriptions_check');

            assert.strictEqual(success, false);
            assert.strictEqual(check_subscriptions_called, false);
        } finally {
            subscriptions_api.checkSubscriptions = original_check_subscriptions;
        }
    });

    it('Check for missing files', async function() {
        this.timeout(300000);
        await db_api.removeAllRecords('files', {uid: 'test'});
        const test_missing_file = {uid: 'test', path: 'test/missing_file.mp4'};
        await db_api.insertRecordIntoTable('files', test_missing_file);
        await tasks_api.executeTask('missing_files_check');
        const missing_file_db_record = await db_api.getRecord('files', {uid: 'test'});
        assert(!missing_file_db_record);
    });

    it('Check for duplicate files', async function() {
        this.timeout(300000);
        await db_api.removeAllRecords('files', {uid: 'test1'});
        await db_api.removeAllRecords('files', {uid: 'test2'});
        const test_duplicate_file1 = {uid: 'test1', path: 'test/missing_file.mp4'};
        const test_duplicate_file2 = {uid: 'test2', path: 'test/missing_file.mp4'};
        const test_duplicate_file3 = {uid: 'test3', path: 'test/missing_file.mp4'};
        await db_api.insertRecordIntoTable('files', test_duplicate_file1);
        await db_api.insertRecordIntoTable('files', test_duplicate_file2);
        await db_api.insertRecordIntoTable('files', test_duplicate_file3);

        await tasks_api.executeRun('duplicate_files_check');
        const task_obj = await db_api.getRecord('tasks', {key: 'duplicate_files_check'});
        assert(task_obj['data'] && task_obj['data']['uids'] && task_obj['data']['uids'].length >= 1, true);

        await tasks_api.executeTask('duplicate_files_check');
        const duplicated_record_count = await db_api.getRecords('files', {path: 'test/missing_file.mp4'}, true);
        assert(duplicated_record_count === 1);
    });

    it('Applies categories to existing files and overwrites stale categories', async function() {
        const matching_file_uid = 'apply-category-match';
        const unmatched_file_uid = 'apply-category-unmatched';
        const matching_file_path = 'video/apply-category-match.mp4';
        const matching_info_path = 'video/apply-category-match.info.json';
        const category_uid = uuid();

        await db_api.removeAllRecords('categories');
        await db_api.removeAllRecords('files', {uid: matching_file_uid});
        await db_api.removeAllRecords('files', {uid: unmatched_file_uid});
        fs.ensureDirSync('video');
        fs.writeJSONSync(matching_info_path, {
            title: 'Sample Music Video',
            fulltitle: 'Sample Music Video',
            webpage_url: 'https://example.com/watch?v=music',
            categories: ['Music']
        });

        try {
            await db_api.insertRecordIntoTable('categories', {
                name: 'Music',
                uid: category_uid,
                rules: [{
                    preceding_operator: null,
                    comparator: 'includes',
                    property: 'categories',
                    value: 'Music'
                }],
                custom_output: ''
            });
            await db_api.insertRecordIntoTable('files', {
                uid: matching_file_uid,
                title: 'Old Title',
                path: matching_file_path,
                isAudio: false,
                category: {name: 'Old', uid: 'old-category'}
            });
            await db_api.insertRecordIntoTable('files', {
                uid: unmatched_file_uid,
                title: 'Unmatched Video',
                path: 'video/apply-category-unmatched.mp4',
                isAudio: false,
                category: {name: 'Old', uid: 'old-category'}
            });

            await tasks_api.executeRun('apply_categories');

            const matching_file = await db_api.getRecord('files', {uid: matching_file_uid});
            const unmatched_file = await db_api.getRecord('files', {uid: unmatched_file_uid});

            assert.deepStrictEqual(matching_file.category, {name: 'Music', uid: category_uid});
            assert.strictEqual(unmatched_file.category, null);
        } finally {
            await db_api.removeAllRecords('categories');
            await db_api.removeAllRecords('files', {uid: matching_file_uid});
            await db_api.removeAllRecords('files', {uid: unmatched_file_uid});
            if (fs.existsSync(matching_info_path)) fs.unlinkSync(matching_info_path);
        }
    });

    it('Import unregistered files', async function() {
        this.timeout(300000);

        // Generated somewhere disposable rather than over the tracked fixture: ffmpeg's
        // output is not byte-stable, so regenerating it in place left the repository
        // dirty after every test run.
        const generated_video_path = path.join(os.tmpdir(), `ytdl-sample-${uuid()}.mp4`);
        const success = await generateEmptyVideoFile(generated_video_path);

        // pre-test cleanup
        await db_api.removeAllRecords('files', {path: 'test/missing_file.mp4'});
        if (fs.existsSync('video/sample_mp4.info.json')) fs.unlinkSync('video/sample_mp4.info.json');
        if (fs.existsSync('video/sample_mp4.mp4'))       fs.unlinkSync('video/sample_mp4.mp4');

        // copies in files
        fs.copyFileSync('test/sample_mp4.info.json', 'video/sample_mp4.info.json');
        fs.copyFileSync(generated_video_path, 'video/sample_mp4.mp4');
        await tasks_api.executeTask('missing_db_records');
        const imported_file = await db_api.getRecord('files', {title: 'Sample File'});
        assert(success && !!imported_file);
        
        // post-test cleanup
        if (fs.existsSync('video/sample_mp4.info.json')) fs.unlinkSync('video/sample_mp4.info.json');
        if (fs.existsSync('video/sample_mp4.mp4'))       fs.unlinkSync('video/sample_mp4.mp4');
        await fs.remove(generated_video_path);
    });

    it('Schedule and cancel task', async function() {
        this.timeout(5000);
        const today_one_year = new Date();
        today_one_year.setFullYear(today_one_year.getFullYear() + 1);
        const schedule_obj = {
            type: 'timestamp',
            data: { timestamp: today_one_year.getTime() }
        }
        await tasks_api.updateTaskSchedule('dummy_task', schedule_obj);
        const dummy_task = await db_api.getRecord('tasks', {key: 'dummy_task'});
        assert(!!tasks_api.TASKS['dummy_task']['job']);
        assert(!!dummy_task['schedule']);

        await tasks_api.updateTaskSchedule('dummy_task', null);
        const dummy_task_updated = await db_api.getRecord('tasks', {key: 'dummy_task'});
        assert(!tasks_api.TASKS['dummy_task']['job']);
        assert(!dummy_task_updated['schedule']);
    });

    it('Schedule and run task', async function() {
        this.timeout(5000);
        const today_1_second = new Date();
        today_1_second.setSeconds(today_1_second.getSeconds() + 1);
        const schedule_obj = {
            type: 'timestamp',
            data: { timestamp: today_1_second.getTime() }
        }
        await tasks_api.updateTaskSchedule('dummy_task', schedule_obj);
        assert(!!tasks_api.TASKS['dummy_task']['job']);
        await utils.wait(2000);
        const dummy_task_obj = await db_api.getRecord('tasks', {key: 'dummy_task'});
        assert(dummy_task_obj['data']);
    });

    it('Does not schedule a one-time task whose time has already passed', async function() {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        await tasks_api.updateTaskSchedule('dummy_task', {
            type: 'timestamp',
            data: { timestamp: yesterday.getTime() }
        });

        assert(!tasks_api.TASKS['dummy_task']['job'], 'a schedule in the past must not produce a job');

        await tasks_api.updateTaskSchedule('dummy_task', null);
    });

    it('drops the job of a task whose record is gone when it sets the record up again', async function() {
        // Which is how a restore from a backup without the task leaves it.
        await tasks_api.updateTaskSchedule('dummy_task', {type: 'recurring', data: {hour: 3, minute: 30}});
        await db_api.removeRecord('tasks', {key: 'dummy_task'});

        await tasks_api.setupTasks();

        assert.strictEqual((await getTask('dummy_task'))['schedule'], null);
        assert.strictEqual(tasks_api.TASKS['dummy_task']['job'], null);
    });

    it('stops a job it is told to drop', async function() {
        // How Reset tasks drops each task's job. The job went on firing regardless.
        this.timeout(5000);
        await tasks_api.updateTaskSchedule('dummy_task', {type: 'timestamp', data: {timestamp: Date.now() + 1000}});

        tasks_api.TASKS['dummy_task']['job'] = null;
        await utils.wait(2000);

        const task = await getTask('dummy_task');
        assert.strictEqual(task['running'], false);
        assert.strictEqual(task['last_ran'], null);
    });

    it('keeps the schedule it had when given one that can never run', async function() {
        // These were saved anyway, and the task was shown as scheduled with nothing to run it.
        const daily = {type: 'recurring', data: {hour: 3, minute: 30}};
        assert.strictEqual(await tasks_api.updateTaskSchedule('dummy_task', daily), true);
        const job = tasks_api.TASKS['dummy_task']['job'];

        const yesterday = Date.now() - 24 * 60 * 60 * 1000;
        const never = [
            {type: 'timestamp', data: {timestamp: yesterday}},
            {type: 'timestamp', data: {timestamp: 'not a time'}},
            {type: 'recurring', data: {hour: 25, minute: 0}},
            {type: 'fortnightly', data: {}}
        ];
        try {
            for (const schedule of never) {
                assert.strictEqual(await tasks_api.updateTaskSchedule('dummy_task', schedule), false, JSON.stringify(schedule));
                assert.deepStrictEqual((await getTask('dummy_task'))['schedule'], daily);
                assert.strictEqual(tasks_api.TASKS['dummy_task']['job'], job);
            }
            assert(tasks_api.getNextRun('dummy_task') instanceof Date);
        } finally {
            await tasks_api.updateTaskSchedule('dummy_task', null);
        }
    });

    it('replaces a job, stopping the one it had', async function() {
        const stopped = [];
        const job = (name) => ({nextRun: () => null, stop: () => stopped.push(name)});

        tasks_api.TASKS['dummy_task']['job'] = job('first');
        tasks_api.TASKS['dummy_task']['job'] = job('second');

        assert.deepStrictEqual(stopped, ['first']);
        tasks_api.TASKS['dummy_task']['job'] = null;
        assert.deepStrictEqual(stopped, ['first', 'second']);
    });

    it('clears a single run once it fires, and runs the task', async function() {
        const run_at = Date.now() + 60 * 60 * 1000;
        await tasks_api.updateTaskSchedule('dummy_task', {type: 'timestamp', data: {timestamp: run_at}});

        await tasks_api.TASKS['dummy_task']['job'].trigger();

        assert.strictEqual((await getTask('dummy_task'))['schedule'], null);
        assert(await waitForCondition(async () => !!(await getTask('dummy_task'))['last_ran']));
    });

    it('skips a scheduled run while the task is still busy', async function() {
        let runs = 0;
        tasks_api.TASKS['dummy_task'].run = async () => { runs++; };
        const daily = {type: 'recurring', data: {hour: 3, minute: 30}};
        await tasks_api.updateTaskSchedule('dummy_task', daily);

        for (const busy of [{running: true}, {confirming: true}]) {
            await db_api.updateRecord('tasks', {key: 'dummy_task'}, {running: false, confirming: false, ...busy});
            await tasks_api.TASKS['dummy_task']['job'].trigger();
        }

        assert.strictEqual(runs, 0);
        assert.deepStrictEqual((await getTask('dummy_task'))['schedule'], daily);
    });

    it('drops a single run whose time went by while the server was down', async function() {
        await db_api.updateRecord('tasks', {key: 'dummy_task'}, {schedule: {type: 'timestamp', data: {timestamp: Date.now() - 1000}}});

        await tasks_api.setupTasks();

        assert.strictEqual((await getTask('dummy_task'))['schedule'], null);
        assert.strictEqual(tasks_api.TASKS['dummy_task']['job'], null);
    });

    it('refuses to run a task that does not exist', async function() {
        assert.strictEqual(await tasks_api.executeTask('not_a_task'), undefined);
        assert.strictEqual(await tasks_api.executeRunOnStartup('not_a_task'), false);
        assert.strictEqual(await tasks_api.updateTaskSchedule('not_a_task', null), false);
    });

    it('skips its run on startup while the task is still busy', async function() {
        let runs = 0;
        tasks_api.TASKS['dummy_task'].run = async () => { runs++; };
        await tasks_api.updateTaskSchedule('dummy_task', {type: 'recurring', data: {hour: 3, minute: 30}});
        // setupTasks clears a stale running flag, so the task has to be busy past it.
        const original_setup = tasks_api.setupTasks;
        tasks_api.setupTasks = async () => {
            await original_setup();
            await db_api.updateRecord('tasks', {key: 'dummy_task'}, {running: true});
        };

        try {
            assert.strictEqual(await tasks_api.executeRunOnStartup('dummy_task'), false);
            assert.strictEqual(runs, 0);
        } finally {
            tasks_api.setupTasks = original_setup;
        }
    });

    it('finds nothing to remove when no two records share a file', async function() {
        const original_find = db_api.findDuplicatesByKey;
        db_api.findDuplicatesByKey = async () => [];

        try {
            await tasks_api.executeRun('duplicate_files_check');
            assert.deepStrictEqual((await getTask('duplicate_files_check'))['data'], {uids: []});
        } finally {
            db_api.findDuplicatesByKey = original_find;
        }
    });

    describe('Schedule conversion', function() {
        it('maps a daily schedule onto a cron pattern', function() {
            assert.strictEqual(tasks_api.buildCronPattern({hour: 0, minute: 0}), '0 0 0 * * *');
            assert.strictEqual(tasks_api.buildCronPattern({hour: 3, minute: 30}), '0 30 3 * * *');
        });

        it('maps a weekly schedule onto a day-of-week list', function() {
            assert.strictEqual(tasks_api.buildCronPattern({hour: 3, minute: 30, dayOfWeek: [1, 3, 5]}), '0 30 3 * * 1,3,5');
            assert.strictEqual(tasks_api.buildCronPattern({hour: 3, minute: 30, dayOfWeek: 0}), '0 30 3 * * 0');
        });

        it('treats an absent field as every value, but pins seconds to zero', function() {
            // The seconds field matters: node-schedule defaulted an unset second to 0, so
            // an hour-only schedule fired once a minute. '*' there would fire every second.
            assert.strictEqual(tasks_api.buildCronPattern({hour: 3}), '0 * 3 * * *');
            assert.strictEqual(tasks_api.buildCronPattern({}), '0 * * * * *');
            assert.strictEqual(tasks_api.buildCronPattern({hour: 3, minute: 30, dayOfWeek: []}), '0 30 3 * * *');
        });
    });

    describe('Next run', function() {
        afterEach(async function() {
            await tasks_api.updateTaskSchedule('dummy_task', null);
        });

        it('has no next run for a task that is not scheduled', function() {
            assert.strictEqual(tasks_api.getNextRun('dummy_task'), null);
        });

        it('reports when a scheduled task runs next', async function() {
            // The page cannot say when a task runs next without this. It read nextInvocation()
            // off the job, which is node-schedule's name for it -- croner, which replaced it,
            // calls it nextRun(), so the answer was always null and every scheduled task
            // reported nothing at all.
            await tasks_api.updateTaskSchedule('dummy_task', {type: 'recurring', data: {hour: 3, minute: 30, tz: 'Etc/UTC'}});

            const next_run = tasks_api.getNextRun('dummy_task');

            assert(next_run instanceof Date, 'expected a Date for a scheduled task');
            assert(next_run.getTime() > Date.now(), 'expected the next run to be in the future');
            assert.strictEqual(next_run.getUTCHours(), 3);
            assert.strictEqual(next_run.getUTCMinutes(), 30);
        });

        it('has no next run for a task that does not exist', function() {
            assert.strictEqual(tasks_api.getNextRun('not_a_task'), null);
        });

        it("reads the next run off a job that calls it node-schedule's name", function() {
            const next_run = new Date(Date.now() + 60 * 1000);
            tasks_api.TASKS['dummy_task']['job'] = {nextInvocation: () => next_run, stop() {}};
            assert.strictEqual(tasks_api.getNextRun('dummy_task'), next_run);

            tasks_api.TASKS['dummy_task']['job'] = {stop() {}};
            assert.strictEqual(tasks_api.getNextRun('dummy_task'), null);
        });
    });

    describe('Schedule timezones', function() {
        const scheduleAt = async (tz) => {
            await tasks_api.updateTaskSchedule('dummy_task', {
                type: 'recurring',
                data: {hour: 3, minute: 30, tz: tz}
            });
            const job = tasks_api.TASKS['dummy_task']['job'];
            assert(!!job, `expected a job for timezone ${tz}`);
            return job.nextRun();
        };

        afterEach(async function() {
            await tasks_api.updateTaskSchedule('dummy_task', null);
        });

        it('honours the timezone stored with the schedule', async function() {
            // The schedule dialog sends the browser's timezone with every schedule. It
            // used to be passed to node-schedule as an eighth constructor argument that
            // its seven-argument constructor discarded, so every task silently ran in the
            // server's local time instead.
            const tokyo = await scheduleAt('Asia/Tokyo');
            const utc = await scheduleAt('Etc/UTC');

            assert.notStrictEqual(tokyo.getTime(), utc.getTime(),
                '03:30 in Tokyo and 03:30 in UTC are not the same moment');
            assert.strictEqual(utc.getUTCHours(), 3);
            assert.strictEqual(utc.getUTCMinutes(), 30);
        });

        it('falls back to server local time when the timezone is unusable', async function() {
            // croner throws on a timezone it cannot resolve; one bad stored value must not
            // take down scheduling for every other task.
            const nonsense = await scheduleAt('Not/AZone');

            assert(!!nonsense);
            assert.strictEqual(nonsense.getHours(), 3);
            assert.strictEqual(nonsense.getMinutes(), 30);
        });
    });

    describe('Confirming', function() {
        it('acts on the findings, then clears them', async function() {
            await db_api.updateRecord('tasks', {key: 'dummy_task'}, {data: {uids: ['found']}});

            assert.strictEqual(await tasks_api.executeConfirm('dummy_task'), true);

            const task = await getTask('dummy_task');
            assert.strictEqual(task['confirming'], false);
            assert.strictEqual(task['data'], null);
            assert(task['last_confirmed']);
        });

        it('leaves a task whose confirm failed idle, with its error and its findings', async function() {
            // It stayed confirming, which refused every run after it until a restart.
            tasks_api.TASKS['dummy_task'].confirm = async () => { throw new Error('Could not act on that'); };
            await db_api.updateRecord('tasks', {key: 'dummy_task'}, {data: {uids: ['found']}});

            assert.strictEqual(await tasks_api.executeConfirm('dummy_task'), false);

            const task = await getTask('dummy_task');
            assert.strictEqual(task['confirming'], false);
            assert.strictEqual(task['error'], 'Could not act on that');
            assert.deepStrictEqual(task['data'], {uids: ['found']});
            assert.strictEqual(task['last_confirmed'], null);
        });

        it('says so for a task that has nothing to confirm', async function() {
            tasks_api.TASKS['dummy_task'].confirm = null;

            assert.strictEqual(await tasks_api.executeConfirm('dummy_task'), false);
        });
    });

    describe('Rebuilding the database', function() {
        // Names of their own: the shared database holds every other test's records too.
        const USER = 'rebuild-user';
        const ROOT_CHANNEL = {id: 'rebuild-root-channel', name: 'Rebuild Root Channel', url: 'https://example.com/@rebuild-root', isPlaylist: false, use_subfolder: true};
        const ROOT_PLAYLIST = {id: 'rebuild-root-playlist', name: 'Rebuild Root Playlist', url: 'https://example.com/playlist?list=rebuild', isPlaylist: true, use_subfolder: false};
        const USER_CHANNEL = {id: 'rebuild-user-channel', name: 'Rebuild User Channel', url: 'https://example.com/@rebuild-user', isPlaylist: false, use_subfolder: true, user_uid: USER};
        const KEPT_CHANNEL = {id: 'rebuild-kept-channel', name: 'Rebuild Kept Channel', url: 'https://example.com/@rebuild-kept', isPlaylist: false, use_subfolder: true};
        const SUBSCRIPTIONS = [ROOT_CHANNEL, ROOT_PLAYLIST, USER_CHANNEL, KEPT_CHANNEL];

        let roots;
        let steps;
        let original_backup;
        let original_import;

        // What a subscription leaves beside its files, as a Mongo record would have it.
        const writeBackup = (dir, sub) => fs.outputJSONSync(path.join(dir, CONSTS.SUBSCRIPTION_BACKUP_PATH), {...sub, _id: 'mongo-id', paused: false});

        const cleanUp = async () => {
            for (const sub of SUBSCRIPTIONS) await db_api.removeAllRecords('subscriptions', {id: sub.id});
            await db_api.removeAllRecords('users', {uid: USER});
        };

        beforeEach(async function() {
            await cleanUp();
            roots = useTemporaryMediaRoots();
            steps = [];
            original_backup = db_api.backupDB;
            original_import = files_api.importUnregisteredFiles;
            db_api.backupDB = async () => { steps.push('backup'); };
            files_api.importUnregisteredFiles = async () => { steps.push('import'); return []; };

            writeBackup(path.join(roots.subscriptions, 'channels', ROOT_CHANNEL.name), ROOT_CHANNEL);
            writeBackup(path.join(roots.subscriptions, 'playlists', '.metadata', ROOT_PLAYLIST.name), ROOT_PLAYLIST);
            writeBackup(path.join(roots.users, USER, 'subscriptions', 'channels', USER_CHANNEL.name), USER_CHANNEL);
            writeBackup(path.join(roots.subscriptions, 'channels', KEPT_CHANNEL.name), KEPT_CHANNEL);
            // Neither of these has a subscription to bring back.
            fs.outputFileSync(path.join(roots.subscriptions, 'channels', 'Unreadable', CONSTS.SUBSCRIPTION_BACKUP_PATH), 'not json');
            fs.ensureDirSync(path.join(roots.subscriptions, 'channels', 'No backup'));

            await db_api.insertRecordIntoTable('subscriptions', {...KEPT_CHANNEL, paused: false});
        });

        afterEach(async function() {
            db_api.backupDB = original_backup;
            files_api.importUnregisteredFiles = original_import;
            roots.restore();
            await cleanUp();
        });

        it('backs up first, then brings back the users and subscriptions it finds, paused', async function() {
            this.timeout(10000);

            await tasks_api.executeRun('rebuild_database');

            assert.strictEqual((await getTask('rebuild_database'))['error'], null);
            assert.deepStrictEqual(steps, ['backup', 'import']);

            for (const sub of [ROOT_CHANNEL, ROOT_PLAYLIST, USER_CHANNEL]) {
                const restored = await db_api.getRecord('subscriptions', {id: sub.id});
                assert(restored, `expected ${sub.name} back`);
                assert.strictEqual(restored.paused, true, `${sub.name} should wait to be switched back on`);
                assert.strictEqual(restored._id, undefined);
            }
            assert.strictEqual((await db_api.getRecord('subscriptions', {id: USER_CHANNEL.id})).user_uid, USER);
            assert.strictEqual((await db_api.getRecord('subscriptions', {id: ROOT_PLAYLIST.id})).isPlaylist, true);
        });

        it('registers a user it finds a folder for, with the password the confirmation warns of', async function() {
            this.timeout(10000);

            await tasks_api.executeRun('rebuild_database');

            const user = await db_api.getRecord('users', {uid: USER});
            assert(user, 'expected the user whose folder it found');
            assert(bcrypt.compareSync('password', user.passhash));
        });

        it('leaves alone a subscription that is already there, and one it cannot read', async function() {
            this.timeout(10000);

            await tasks_api.executeRun('rebuild_database');

            const kept = await db_api.getRecords('subscriptions', {id: KEPT_CHANNEL.id});
            assert.strictEqual(kept.length, 1);
            assert.strictEqual(kept[0].paused, false);
            assert.strictEqual(await db_api.getRecords('subscriptions', {name: 'Unreadable'}, true), 0);
        });
    });

    describe('Deleting old files', function() {
        const DAY_MS = 24 * 60 * 60 * 1000;
        const OLD_FILE = 'delete-old-files-old';
        const OLD_SUBSCRIPTION_FILE = 'delete-old-files-old-subscription';
        const NEW_FILE = 'delete-old-files-new';
        const OURS = [OLD_FILE, OLD_SUBSCRIPTION_FILE, NEW_FILE];

        let deleted;
        let original_delete_file;

        // The shared database holds other tests' files too, old ones among them.
        const deletedOfOurs = () => Object.fromEntries(deleted.filter(({uid}) => OURS.includes(uid)).map(({uid, blacklist}) => [uid, blacklist]));

        const deleteOldFiles = async (options) => {
            await setTaskOptions('delete_old_files', options);
            await tasks_api.executeRun('delete_old_files');
            await tasks_api.executeConfirm('delete_old_files');
        };

        beforeEach(async function() {
            deleted = [];
            original_delete_file = files_api.deleteFile;
            files_api.deleteFile = async (uid, blacklist) => { deleted.push({uid, blacklist}); return true; };

            for (const uid of OURS) await db_api.removeAllRecords('files', {uid});
            await db_api.insertRecordIntoTable('files', {uid: OLD_FILE, path: 'video/old.mp4', registered: Date.now() - 40 * DAY_MS});
            await db_api.insertRecordIntoTable('files', {uid: OLD_SUBSCRIPTION_FILE, path: 'subscriptions/channels/Old/old.mp4', sub_id: 'old-subscription', registered: Date.now() - 40 * DAY_MS});
            await db_api.insertRecordIntoTable('files', {uid: NEW_FILE, path: 'video/new.mp4', registered: Date.now() - DAY_MS});
        });

        afterEach(async function() {
            files_api.deleteFile = original_delete_file;
            for (const uid of OURS) await db_api.removeAllRecords('files', {uid});
        });

        it('deletes only the files older than the age set', async function() {
            await deleteOldFiles({threshold_days: 30});

            assert.deepStrictEqual(deletedOfOurs(), {[OLD_FILE]: false, [OLD_SUBSCRIPTION_FILE]: false});
        });

        it('keeps to subscription files when asked to, and blacklists what it deletes', async function() {
            // This used to blacklist the subscription files and delete every other old file in
            // the library along with them. Read off the file instead of the task, the blacklist
            // was always off, so a deleted video came back with the subscription's next check.
            await deleteOldFiles({threshold_days: 30, blacklist_subscription_files: true});

            assert.deepStrictEqual(deletedOfOurs(), {[OLD_SUBSCRIPTION_FILE]: true});
        });

        it('keeps to subscription files when everything it deletes is blacklisted as well', async function() {
            await deleteOldFiles({threshold_days: 30, blacklist_files: true, blacklist_subscription_files: true});

            assert.deepStrictEqual(deletedOfOurs(), {[OLD_SUBSCRIPTION_FILE]: true});
        });

        it('leaves the other files an earlier run found once it keeps to subscription files', async function() {
            await setTaskOptions('delete_old_files', {threshold_days: 30});
            await tasks_api.executeRun('delete_old_files');
            await setTaskOptions('delete_old_files', {blacklist_subscription_files: true});
            await tasks_api.executeConfirm('delete_old_files');

            assert.deepStrictEqual(deletedOfOurs(), {[OLD_SUBSCRIPTION_FILE]: true});
        });

        it('blacklists every file it deletes when asked to', async function() {
            await deleteOldFiles({threshold_days: 30, blacklist_files: true});

            assert.deepStrictEqual(deletedOfOurs(), {[OLD_FILE]: true, [OLD_SUBSCRIPTION_FILE]: true});
        });

        it('refuses an age that is not a number of days above zero', async function() {
            // A negative age put the cutoff in the future, which every file is older than,
            // so a typo in the age was enough to delete the whole library.
            for (const threshold_days of [-30, '-30', '0', 'soon']) {
                await setTaskOptions('delete_old_files', {threshold_days});
                await tasks_api.executeRun('delete_old_files');

                const task = await getTask('delete_old_files');
                assert.strictEqual(task['data'], null, `expected nothing to delete for ${JSON.stringify(threshold_days)}`);
                assert.match(task['error'], /not a number of days above zero/);
            }
        });
    });

    describe('Acting on findings without asking', function() {
        let confirmed;
        let unhandled;
        const keepUnhandled = reason => unhandled.push(reason);

        beforeEach(async function() {
            confirmed = [];
            unhandled = [];
            process.on('unhandledRejection', keepUnhandled);
            tasks_api.TASKS['dummy_task'].confirm = async (data) => { confirmed.push(data); };
            await db_api.updateRecord('tasks', {key: 'dummy_task'}, {options: {auto_confirm: true}});
        });

        afterEach(function() {
            process.removeListener('unhandledRejection', keepUnhandled);
        });

        it('acts on what a run turned up', async function() {
            tasks_api.TASKS['dummy_task'].run = async () => ({uids: ['found']});

            await tasks_api.executeRun('dummy_task');

            assert(await waitForCondition(async () => !!(await getTask('dummy_task'))['last_confirmed']));
            assert.deepStrictEqual(confirmed, [{uids: ['found']}]);
        });

        it('leaves a run that turned up nothing alone', async function() {
            tasks_api.TASKS['dummy_task'].run = async () => null;

            await tasks_api.executeRun('dummy_task');
            await utils.wait(100);

            assert.deepStrictEqual(confirmed, []);
            assert.strictEqual((await getTask('dummy_task'))['last_confirmed'], null);
        });

        it('does not delete old files when no age is set, and does not throw over it', async function() {
            // Without an age the run finds nothing to do. Confirming that read a property
            // of null, and nothing waits on the confirm, so the server died of the rejection.
            await setTaskOptions('delete_old_files', {auto_confirm: true});

            await tasks_api.executeRun('delete_old_files');
            await utils.wait(100);

            const task = await getTask('delete_old_files');
            assert.deepStrictEqual(unhandled, []);
            assert.strictEqual(task['confirming'], false);
            assert.strictEqual(task['last_confirmed'], null);
            assert.match(task['error'], /no limit was set/);
        });

        it('keeps a confirm that failed from ending the process', async function() {
            tasks_api.TASKS['dummy_task'].run = async () => ({uids: ['found']});
            tasks_api.TASKS['dummy_task'].confirm = async () => { throw new Error('Could not act on that'); };

            await tasks_api.executeRun('dummy_task');

            assert(await waitForCondition(async () => !!(await getTask('dummy_task'))['error']));
            assert.deepStrictEqual(unhandled, []);
            assert.strictEqual((await getTask('dummy_task'))['confirming'], false);
        });

        it('does not download yt-dlp a second time after its check updated it', async function() {
            // The check installs an update itself and returns nothing. Confirming that
            // anyway downloaded the latest release again and recorded its version as null,
            // so every later check saw an unknown version and downloaded it once more.
            const update_task = tasks_api.TASKS['youtubedl_update_check'];
            const original_run = update_task.run;
            const original_confirm = update_task.confirm;
            const updates = [];
            update_task.run = async () => undefined;
            update_task.confirm = async (version) => { updates.push(version); };

            try {
                await setTaskOptions('youtubedl_update_check', {auto_confirm: true});
                await tasks_api.executeRun('youtubedl_update_check');
                await utils.wait(100);

                assert.deepStrictEqual(updates, []);
            } finally {
                update_task.run = original_run;
                update_task.confirm = original_confirm;
            }
        });
    });
});
