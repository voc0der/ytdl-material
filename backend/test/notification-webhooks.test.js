const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.resolve(__dirname, '../notifications.js');
const requireNotificationDependency = createRequire(filename);
const loadNotifications = vm.compileFunction(fs.readFileSync(filename, 'utf8'),
    ['exports', 'require', 'globalThis'], {filename});
const APP_URL = 'https://media.example.test/base';
const WEBHOOK_URL = 'https://hooks.example.test/events';
const FILE = {
    uid: 'file-1', title: 'A "quoted" title\nwith another line',
    url: 'https://source.example.test/watch?id=1', thumbnailURL: 'https://images.example.test/1.jpg'
};
const DOWNLOAD = {uid: 'download-1', url: FILE.url};
const TASK = {key: 'missing_files', title: 'Missing files check'};

describe('Notification webhooks', function() {
    let notifications;
    let settings;
    let requests;
    let records;
    let operations;

    beforeEach(function() {
        settings = {
            ytdl_enable_notifications: true,
            ytdl_enable_all_notifications: true,
            ytdl_allowed_notification_types: [],
            ytdl_webhook_url: WEBHOOK_URL
        };
        requests = [];
        records = [];
        operations = [];
        const dependencies = {
            './config': {
                getConfigItem: key => settings[key],
                config_updated: {subscribe() {}}
            },
            './db': {
                insertRecordIntoTable: async (table, record) => {
                    assert.equal(table, 'notifications');
                    operations.push('insert');
                    records.push(structuredClone(record));
                    return true;
                },
                removeAllRecords: async (table, filter) => {
                    assert.equal(table, 'notifications');
                    assert.deepEqual(Object.keys(filter), ['data.task_key']);
                    operations.push('remove');
                    records = records.filter(record => record.data.task_key !== filter['data.task_key']);
                    return true;
                }
            },
            './utils': {getBaseURL: () => APP_URL},
            './logger': {verbose() {}}
        };

        // Run the whole production module in this realm, with its real filename for
        // coverage. Isolate config, storage and HTTP without changing globals, the
        // require cache, or the shared module's config subscription. No request escapes.
        notifications = {};
        loadNotifications(notifications,
            name => dependencies[name] || requireNotificationDependency(name), {
                fetch: (url, options) => {
                    requests.push({url, ...options});
                    return Promise.resolve({ok: true});
                }
            });
    });

    const senders = {
        download_complete: () => notifications.sendDownloadNotification(FILE, 'alice'),
        download_error: () => notifications.sendDownloadErrorNotification(DOWNLOAD, 'alice', 'Upstream unavailable', 'network'),
        task_finished: () => notifications.sendTaskNotification(TASK, false)
    };
    const payloads = {
        download_complete: {
            title: 'Download complete', body: FILE.title + '\nOriginal URL: ' + FILE.url,
            type: 'download_complete', url: APP_URL + '/#/player;uid=file-1', thumbnail: FILE.thumbnailURL
        },
        download_error: {
            title: 'Download error', body: 'Error: Upstream unavailable\nError code: network\n\nOriginal URL: ' + FILE.url,
            type: 'download_error', url: APP_URL + '/#/downloads', thumbnail: null
        },
        task_finished: {
            title: 'Task finished', body: TASK.title,
            type: 'task_finished', url: APP_URL + '/#/tasks', thumbnail: null
        }
    };

    function webhookPayload(expectedURL = WEBHOOK_URL) {
        const matching = requests.filter(request => request.url === expectedURL);
        assert.equal(matching.length, 1, 'one request must reach the configured webhook');
        const request = matching[0];
        assert.equal(request.method, 'POST');
        assert.equal(request.headers['Content-Type'], 'application/json');
        return JSON.parse(request.body);
    }

    for (const type of Object.keys(senders)) {
        it(`posts and persists a ${type} event with its actions and owner`, async function() {
            const before = Date.now() / 1000;
            const notification = await senders[type]();
            assert.deepEqual(webhookPayload(), payloads[type]);
            assert.equal(requests.length, 1);
            assert.deepEqual(records, [notification]);
            assert.match(notification.uid, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
            assert.equal(notification.read, false);
            assert(notification.timestamp >= before && notification.timestamp <= Date.now() / 1000);
            assert.equal(notification.type, type);
            assert.equal(notification.user_uid, type === 'task_finished' ? null : 'alice');
            assert.deepEqual(notification.actions, {
                download_complete: ['play'], download_error: ['view_download_error', 'retry_download'],
                task_finished: ['view_tasks']
            }[type]);
            assert.deepEqual(notification.data, {
                download_complete: {file_uid: FILE.uid, file_title: FILE.title, file_thumbnail: FILE.thumbnailURL, original_url: FILE.url},
                download_error: {download_uid: DOWNLOAD.uid, download_url: DOWNLOAD.url, download_error_message: 'Upstream unavailable', download_error_type: 'network'},
                task_finished: {task_key: TASK.key, task_title: TASK.title, confirmed: false}
            }[type]);
        });

        it(`suppresses ${type} when notifications are disabled or the event is not selected`, async function() {
            settings.ytdl_enable_notifications = false;
            assert.equal(await senders[type](), undefined);
            settings.ytdl_enable_notifications = true;
            settings.ytdl_enable_all_notifications = false;
            settings.ytdl_allowed_notification_types = Object.keys(senders).filter(other => other !== type);
            assert.equal(await senders[type](), undefined);
            assert.deepEqual(requests, []);
            assert.deepEqual(records, []);
            assert.deepEqual(operations, [], 'a suppressed task must not remove an earlier notification');

            settings.ytdl_allowed_notification_types = [type];
            const notification = await senders[type]();
            assert.deepEqual(webhookPayload(), payloads[type]);
            assert.deepEqual(records, [notification]);
        });
    }

    it('keeps in-app notifications when no webhook is configured', async function() {
        settings.ytdl_webhook_url = '';
        const notification = await senders.download_complete();
        assert.deepEqual(requests, []);
        assert.deepEqual(records, [notification]);
    });

    it('replaces only the same task notification and assigns it to the administrator in multi-user mode', async function() {
        settings.ytdl_multi_user_mode = true;
        const old = await senders.task_finished();
        const otherTask = await notifications.sendTaskNotification({key: 'other_task', title: 'Another task'}, true);
        const download = await senders.download_complete();
        operations = [];

        const replacement = await notifications.sendTaskNotification(TASK, true);
        assert.equal(replacement.user_uid, 'admin');
        assert.equal(replacement.data.confirmed, true);
        assert.notEqual(replacement.uid, old.uid);
        assert.deepEqual(operations, ['remove', 'insert']);
        assert.deepEqual(records, [otherTask, download, replacement]);
    });

    it('accepts download failures without an error code', async function() {
        const notification = await notifications.sendDownloadErrorNotification(DOWNLOAD, 'alice', 'Failed');
        assert.equal(notification.data.download_error_type, null);
        assert.equal(webhookPayload().body, 'Error: Failed\nError code: null\n\nOriginal URL: ' + FILE.url);
    });

    describe('custom templates', function() {
        beforeEach(function() {
            settings.ytdl_use_custom_webhook_template = true;
        });

        it('renders event aliases and raw fields without changing stored data or another delivery channel', async function() {
            settings.ytdl_use_ntfy_API = true;
            settings.ytdl_ntfy_topic_url = 'https://ntfy.example.test/topic';
            settings.ytdl_custom_webhook_title_template = '{{ event_name }}: {{video_name}}';
            settings.ytdl_custom_webhook_body_template = [
                '{{event_type}}', '{{event_body}}', '{{video_original_url}}', '{{video_url}}',
                '{{notification_url}}', '{{notification_thumbnail}}', '{{notification_uid}}',
                '{{timestamp}}', '{{file_uid}}', '{{data.file_title}}'
            ].join('\n');

            const notification = await senders.download_complete();
            assert.deepEqual(webhookPayload(), {
                ...payloads.download_complete,
                title: 'Download complete: ' + FILE.title,
                body: [
                    'download_complete', payloads.download_complete.body, FILE.url, FILE.url,
                    payloads.download_complete.url, FILE.thumbnailURL, notification.uid,
                    notification.timestamp, FILE.uid, FILE.title
                ].join('\n')
            });
            assert.deepEqual(records, [notification]);
            assert.equal(records[0].data.file_title, FILE.title);
            assert.equal(requests.length, 2);
            assert.deepEqual(requests.find(request => request.url === settings.ytdl_ntfy_topic_url), {
                url: settings.ytdl_ntfy_topic_url, method: 'POST', body: payloads.download_complete.body,
                headers: {Title: 'Download complete', Tags: 'download_complete',
                    Click: payloads.download_complete.url, Attach: FILE.thumbnailURL}
            });
        });

        it('uses the failed download URL and error aliases', async function() {
            settings.ytdl_custom_webhook_title_template = '{{event_name}}: {{error_type}}';
            settings.ytdl_custom_webhook_body_template = '{{error_message}}|{{video_original_url}}|{{video_url}}|{{data.download_uid}}|{{video_name}}';
            await senders.download_error();
            assert.deepEqual(webhookPayload(), {
                ...payloads.download_error, title: 'Download error: network',
                body: `Upstream unavailable|${FILE.url}|${FILE.url}|download-1|`
            });
        });

        it('renders task names, false and zero without treating them as missing', async function() {
            settings.ytdl_custom_webhook_title_template = '{{task_name}}';
            settings.ytdl_custom_webhook_body_template = '{{data.confirmed}}|{{data.count}}|{{video_name}}|{{error_message}}|{{notification_thumbnail}}';
            const notification = notifications.createNotification('task_finished', [], {
                task_title: TASK.title, confirmed: false, count: 0
            }, null);
            await notifications.sendNotification(notification);
            assert.deepEqual(webhookPayload(), {...payloads.task_finished, title: TASK.title, body: 'false|0|||'});
        });

        it('resolves nested paths and JSON values while missing or non-traversable paths become empty', async function() {
            settings.ytdl_custom_webhook_title_template = '{{data . extra . label}}';
            settings.ytdl_custom_webhook_body_template = [
                '{{data.extra}}', '{{data.tags}}', '{{data.tags.0}}', '{{data.absent}}',
                '{{data.empty.value}}', '{{data.count.value}}', '{{data.extra.label.value}}', '{{data.empty}}'
            ].join('|');
            const notification = notifications.createNotification('task_finished', [], {
                task_title: TASK.title, extra: {label: 'Archive'}, tags: ['one', 'two'], empty: null, count: 0
            }, null);
            const before = structuredClone(notification);
            await notifications.sendNotification(notification);
            assert.deepEqual(webhookPayload(), {
                ...payloads.task_finished, title: 'Archive',
                body: '{"label":"Archive"}|["one","two"]|one|||||'
            });
            assert.deepEqual(notification, before);
            assert.deepEqual(records, [before]);
        });

        it('does not evaluate expressions or recursively substitute event values', async function() {
            settings.ytdl_custom_webhook_title_template = '{{video_name}}';
            settings.ytdl_custom_webhook_body_template = 'literal {{data.count + 1}} / {{missing}}';
            await notifications.sendDownloadNotification({...FILE, title: '{{event_name}}'}, 'alice');
            assert.equal(webhookPayload().title, '{{event_name}}');
            assert.equal(webhookPayload().body, 'literal  / ');
        });

        for (const value of ['', null, 42]) {
            it(`renders an empty title and body for a template value of ${JSON.stringify(value)}`, async function() {
                settings.ytdl_custom_webhook_title_template = value;
                settings.ytdl_custom_webhook_body_template = value;
                await senders.task_finished();
                assert.deepEqual(webhookPayload(), {...payloads.task_finished, title: '', body: ''});
            });
        }

        it('ignores configured templates while custom rendering is disabled', async function() {
            settings.ytdl_use_custom_webhook_template = false;
            settings.ytdl_custom_webhook_title_template = 'Custom';
            settings.ytdl_custom_webhook_body_template = '{{missing}}';
            await senders.download_complete();
            assert.deepEqual(webhookPayload(), payloads.download_complete);
        });
    });

    describe('Apprise routing', function() {
        for (const [configured, expected] of [
            ['apprise://hooks.example.test/team-key', 'http://hooks.example.test/notify/team-key'],
            ['apprises://hooks.example.test/team-key', 'https://hooks.example.test/notify/team-key'],
            [' APPRISES://hooks.example.test/proxy/team-key/ ', 'https://hooks.example.test/proxy/notify/team-key'],
            ['apprise://hooks.example.test/apprise?key=team_key-1&tag=ops', 'http://hooks.example.test/notify/team_key-1?tag=ops'],
            ['apprises://hooks.example.test/?key=team-key&tags=ops', 'https://hooks.example.test/notify/team-key?tags=ops'],
            ['apprise://hooks.example.test', 'http://hooks.example.test/']
        ]) {
            it(`routes ${configured.trim()} to its HTTP notification endpoint`, async function() {
                settings.ytdl_webhook_url = configured;
                await senders.download_complete();
                const expectedTag = new URL(expected).searchParams.get('tag') || new URL(expected).searchParams.get('tags');
                assert.deepEqual(webhookPayload(expected), {
                    ...payloads.download_complete, type: 'success', event_type: 'download_complete', format: 'text',
                    ...(expectedTag ? {tag: 'ops'} : {})
                });
                assert.equal(requests.length, 1);
            });
        }

        for (const endpoint of [
            'https://hooks.example.test/notify', 'https://hooks.example.test/proxy/notify/team-key/',
            'https://hooks.example.test/proxy/apprise/events', 'https://apprise.example.test/events'
        ]) {
            it(`recognizes an existing HTTP endpoint at ${endpoint}`, async function() {
                settings.ytdl_webhook_url = endpoint;
                await senders.task_finished();
                assert.deepEqual(webhookPayload(endpoint), {
                    ...payloads.task_finished, type: 'success', event_type: 'task_finished', format: 'text'
                });
            });
        }

        it('maps failed downloads to failure and gives tag precedence over tags', async function() {
            settings.ytdl_webhook_url = 'https://hooks.example.test/notify/key?tag=urgent&tags=all';
            await senders.download_error();
            assert.deepEqual(webhookPayload(settings.ytdl_webhook_url), {
                ...payloads.download_error, type: 'failure', event_type: 'download_error', format: 'text', tag: 'urgent'
            });
        });

        it('applies custom title and body as Markdown before translating the event type', async function() {
            settings.ytdl_webhook_url = 'apprises://hooks.example.test/key';
            settings.ytdl_use_custom_webhook_template = true;
            settings.ytdl_custom_webhook_title_template = '{{event_type}}: {{video_name}}';
            settings.ytdl_custom_webhook_body_template = '{{data.file_uid}}';
            await senders.download_complete();
            assert.deepEqual(webhookPayload('https://hooks.example.test/notify/key'), {
                ...payloads.download_complete, title: 'download_complete: ' + FILE.title, body: FILE.uid,
                type: 'success', event_type: 'download_complete', format: 'markdown'
            });
        });

        it('preserves ordinary webhook URLs and event types even when a tag is supplied', async function() {
            settings.ytdl_webhook_url = ' https://hooks.example.test/notifications?tag=ops ';
            await senders.download_error();
            assert.deepEqual(webhookPayload(settings.ytdl_webhook_url.trim()), payloads.download_error);
        });
    });
});
