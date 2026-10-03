const { assert, fs, os, path, uuid, db_api, utils, files_api, subscriptions_api, generateEmptyVideoFile } = require('./test-shared');

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

        it('blacklists the subscription files it deletes when only those are to be blacklisted', async function() {
            // Read off the file instead of the task, this was always off, so a deleted video
            // left its subscription's archive and came back with the subscription's next check.
            await deleteOldFiles({threshold_days: 30, blacklist_subscription_files: true});

            assert.deepStrictEqual(deletedOfOurs(), {[OLD_FILE]: false, [OLD_SUBSCRIPTION_FILE]: true});
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
