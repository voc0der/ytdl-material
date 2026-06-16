/* eslint-disable no-undef */
const { assert, fs, uuid, db_api, utils, subscriptions_api, generateEmptyVideoFile } = require('./test-shared');

describe('Tasks', function() {
    const tasks_api = require('../tasks');
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

    it('Creates the apply categories task without a default schedule', async function() {
        const task = await db_api.getRecord('tasks', {key: 'apply_categories'});

        assert(task);
        assert.strictEqual(task['title'], 'Apply categories to existing files');
        assert.strictEqual(task['schedule'], null);
        assert.strictEqual(tasks_api.TASKS['apply_categories']['job'], null);
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

        const success = await generateEmptyVideoFile('test/sample_mp4.mp4');

        // pre-test cleanup
        await db_api.removeAllRecords('files', {path: 'test/missing_file.mp4'});
        if (fs.existsSync('video/sample_mp4.info.json')) fs.unlinkSync('video/sample_mp4.info.json');
        if (fs.existsSync('video/sample_mp4.mp4'))       fs.unlinkSync('video/sample_mp4.mp4');

        // copies in files
        fs.copyFileSync('test/sample_mp4.info.json', 'video/sample_mp4.info.json');
        fs.copyFileSync('test/sample_mp4.mp4', 'video/sample_mp4.mp4');
        await tasks_api.executeTask('missing_db_records');
        const imported_file = await db_api.getRecord('files', {title: 'Sample File'});
        assert(success && !!imported_file);
        
        // post-test cleanup
        if (fs.existsSync('video/sample_mp4.info.json')) fs.unlinkSync('video/sample_mp4.info.json');
        if (fs.existsSync('video/sample_mp4.mp4'))       fs.unlinkSync('video/sample_mp4.mp4');
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
});
