const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.resolve(__dirname, '../notifications.js');
const requireNotificationDependency = createRequire(filename);
const loadNotifications = vm.compileFunction(fs.readFileSync(filename, 'utf8'),
    ['exports', 'require', 'globalThis'], {filename});

// The same instances notifications.js gets, so each can be stopped at the point where it
// would go out over the network, with everything before that point running for real.
const {DefaultRestOptions} = requireNotificationDependency('@discordjs/rest');
const axios = requireNotificationDependency('axios');

const APP_URL = 'https://media.example.test/base';
const FILE = {uid: 'file-1', title: 'A clip', url: 'https://source.example.test/watch?id=1', thumbnailURL: 'https://images.example.test/1.jpg'};
const DOWNLOAD = {uid: 'download-1', url: FILE.url};
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/123456789/webhook-token';
const DOWNLOAD_BODY = `${FILE.title}\nOriginal URL: ${FILE.url}`;
const PLAYER_URL = `${APP_URL}/#/player;uid=${FILE.uid}`;

async function until(condition, what) {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

/*************************************************
 * The chat services a notification goes out to,
 * each sent through the library that talks to it:
 * discord.js's REST client, builders and core for
 * Discord, axios for Telegram, and fetch for Slack
 * and ntfy. These are what a version bump of any of
 * those libraries could quietly break, since a
 * failed send is only ever logged.
 ************************************************/
describe('Notification services', function() {
    let notifications;
    let settings;
    let fetches;
    let discord_requests;
    let axios_requests;
    let axios_response;
    let config_listener;
    let logged;
    let original_make_request;
    let original_adapter;

    function load() {
        const dependencies = {
            './config': {
                getConfigItem: key => settings[key],
                setConfigItem: (key, value) => {
                    settings[key] = value;
                    return true;
                },
                config_updated: {subscribe(listener) { config_listener = listener; }}
            },
            './db': {
                insertRecordIntoTable: async () => true,
                removeAllRecords: async () => true
            },
            './utils': {
                getBaseURL: () => APP_URL,
                getPublicAssetURL: asset => `${APP_URL}/${asset}`
            },
            './logger': {
                verbose() {}, debug() {}, info() {},
                warn: message => logged.push(message),
                error: message => logged.push(message)
            }
        };
        notifications = {};
        loadNotifications(notifications,
            name => dependencies[name] || requireNotificationDependency(name), {
                fetch: (url, options) => {
                    fetches.push({url, ...options});
                    return Promise.resolve({ok: true});
                }
            });
    }

    beforeEach(function() {
        settings = {
            ytdl_enable_notifications: true,
            ytdl_enable_all_notifications: true,
            ytdl_allowed_notification_types: []
        };
        fetches = [];
        discord_requests = [];
        axios_requests = [];
        logged = [];
        config_listener = null;
        axios_response = config => ({data: {ok: true, result: true}, status: 200, statusText: 'OK', headers: {}, config, request: {}});

        original_make_request = DefaultRestOptions.makeRequest;
        DefaultRestOptions.makeRequest = async (url, init) => {
            discord_requests.push({url, init});
            return new Response(null, {status: 204});
        };
        original_adapter = axios.defaults.adapter;
        axios.defaults.adapter = async config => {
            axios_requests.push(config);
            return axios_response(config);
        };
    });

    afterEach(function() {
        DefaultRestOptions.makeRequest = original_make_request;
        axios.defaults.adapter = original_adapter;
    });

    describe('Discord', function() {
        beforeEach(function() {
            settings.ytdl_discord_webhook_url = DISCORD_WEBHOOK;
            load();
        });

        it('executes the webhook with the event as an embed', async function() {
            await notifications.sendDownloadNotification(FILE, null);
            await until(() => discord_requests.length === 1, 'the Discord request');

            const [{url, init}] = discord_requests;
            assert.equal(url, 'https://discord.com/api/v10/webhooks/123456789/webhook-token');
            assert.equal(init.method, 'POST');
            const headers = new Headers(init.headers);
            assert.equal(headers.get('content-type'), 'application/json');
            // A webhook's token is in its URL; it must not also send a bot credential.
            assert.equal(headers.get('authorization'), null);
            assert.deepEqual(JSON.parse(init.body), {
                content: DOWNLOAD_BODY,
                username: 'ytdl-material',
                avatar_url: `${APP_URL}/assets/images/logo_128px.png`,
                embeds: [{
                    title: 'Download complete',
                    color: 0x00FFFF,
                    url: PLAYER_URL,
                    description: 'ID: download_complete',
                    thumbnail: {url: FILE.thumbnailURL}
                }]
            });
        });

        it('marks an error in red, with no thumbnail', async function() {
            await notifications.sendDownloadErrorNotification(DOWNLOAD, null, 'Upstream unavailable', 'network');
            await until(() => discord_requests.length === 1, 'the Discord request');

            const [embed] = JSON.parse(discord_requests[0].init.body).embeds;
            assert.equal(embed.color, 0xFC2003);
            assert.equal(embed.title, 'Download error');
            assert.equal(embed.thumbnail, undefined);
        });
    });

    describe('Slack', function() {
        it('posts the event as blocks, with the thumbnail as an image', async function() {
            settings.ytdl_slack_webhook_url = 'https://hooks.slack.example.test/services/T/B/X';
            load();
            await notifications.sendDownloadNotification(FILE, null);

            assert.equal(fetches.length, 1);
            const [request] = fetches;
            assert.equal(request.url, 'https://hooks.slack.example.test/services/T/B/X');
            assert.equal(request.method, 'POST');
            assert.equal(request.headers['Content-Type'], 'application/json');
            assert.deepEqual(JSON.parse(request.body).blocks, [
                {type: 'section', text: {type: 'mrkdwn', text: '*Download complete*'}},
                {type: 'section', text: {type: 'plain_text', text: DOWNLOAD_BODY}},
                {type: 'image', image_url: FILE.thumbnailURL, alt_text: 'notification_thumbnail'},
                {type: 'section', text: {type: 'mrkdwn', text: `<${PLAYER_URL}|${PLAYER_URL}>`}},
                {type: 'context', elements: [{type: 'mrkdwn', text: '*ID:* download_complete'}]}
            ]);
        });
    });

    describe('ntfy', function() {
        beforeEach(function() {
            settings.ytdl_use_ntfy_API = true;
            settings.ytdl_ntfy_topic_url = 'https://ntfy.example.test/downloads';
            load();
        });

        it('publishes the body, with the rest of the event as headers', async function() {
            await notifications.sendDownloadNotification(FILE, null);

            assert.equal(fetches.length, 1);
            assert.deepEqual(fetches[0], {
                url: 'https://ntfy.example.test/downloads',
                method: 'POST',
                body: DOWNLOAD_BODY,
                headers: {Title: 'Download complete', Tags: 'download_complete', Click: PLAYER_URL, Attach: FILE.thumbnailURL}
            });
        });

        it('is not sent without a topic', async function() {
            settings.ytdl_ntfy_topic_url = '';
            await notifications.sendDownloadNotification(FILE, null);
            assert.deepEqual(fetches, []);
        });
    });

    /*************************************************
     * Switched on the way Settings does it, after the
     * module has loaded. Starting with Telegram
     * already on in the saved config is a separate
     * case: setupTelegramBot runs before
     * ensureTelegramWebhookSecret is defined, and the
     * rejection stops the server.
     ************************************************/
    describe('Telegram', function() {
        const telegram = method => axios_requests.filter(request => request.url.endsWith(`/${method}`));

        async function enableTelegram(extra_settings = {}) {
            load();
            Object.assign(settings, {
                ytdl_use_telegram_API: true,
                ytdl_telegram_bot_token: '123:bot-token',
                ytdl_telegram_chat_id: '42'
            }, extra_settings);
            const registered = telegram('setWebhook').length;
            config_listener({key: 'ytdl_use_telegram_API'});
            await until(() => telegram('setWebhook').length === registered + 1, 'setWebhook');
        }

        it('registers its webhook with a new secret when the bot is set up', async function() {
            await enableTelegram();

            const [request] = telegram('setWebhook');
            assert.equal(request.url, 'https://api.telegram.org/bot123:bot-token/setWebhook');
            assert.equal(request.method, 'post');
            assert.equal(request.timeout, 15000);
            const body = JSON.parse(request.data);
            assert.equal(body.url, `${APP_URL}/api/telegramRequest`);
            assert.match(body.secret_token, /^[0-9a-f]{32}$/);
            assert.equal(settings.ytdl_telegram_webhook_secret, body.secret_token);
        });

        it('keeps the secret it has, and registers a proxy in its place when one is set', async function() {
            await enableTelegram({
                ytdl_telegram_webhook_secret: 'kept-secret',
                ytdl_telegram_webhook_proxy: 'https://proxy.example.test/telegram'
            });

            assert.deepEqual(JSON.parse(telegram('setWebhook')[0].data), {url: 'https://proxy.example.test/telegram', secret_token: 'kept-secret'});
        });

        it('sends the thumbnail, then the message', async function() {
            await enableTelegram();
            await notifications.sendDownloadNotification(FILE, null);
            await until(() => telegram('sendMessage').length === 1, 'sendMessage');

            assert.deepEqual(axios_requests.map(request => request.url.split('/').pop()), ['setWebhook', 'sendPhoto', 'sendMessage']);
            assert.deepEqual(JSON.parse(telegram('sendPhoto')[0].data), {chat_id: '42', photo: FILE.thumbnailURL});
            assert.deepEqual(JSON.parse(telegram('sendMessage')[0].data), {
                chat_id: '42',
                text: `<b>Download complete</b>\n\n${DOWNLOAD_BODY}\n<a href="${PLAYER_URL}">${PLAYER_URL}</a>`,
                parse_mode: 'HTML'
            });
        });

        it('logs the reason Telegram gives for refusing, and carries on', async function() {
            await enableTelegram();
            axios_response = config => {
                throw new axios.AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config, {}, {
                    status: 400, statusText: 'Bad Request', headers: {}, config,
                    data: {ok: false, description: 'Bad Request: chat not found'}
                });
            };
            await notifications.sendTelegramNotification({title: 'Task finished', body: 'Backup DB', url: `${APP_URL}/#/tasks`, thumbnail: null});

            assert(logged.includes('Telegram API sendMessage failed: Bad Request: chat not found'), logged.join('\n'));
            assert.equal(telegram('sendPhoto').length, 0);
        });

        it('sets the bot up again when its token changes, and only then', async function() {
            await enableTelegram();

            config_listener({key: 'ytdl_default_downloader'});
            config_listener({key: 'ytdl_telegram_bot_token'});
            await until(() => telegram('setWebhook').length === 2, 'the second setWebhook');
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(telegram('setWebhook').length, 2);
        });

        it('sends nothing without a bot, or without a chat', async function() {
            load();
            await notifications.sendTelegramNotification({title: 'Task finished', body: 'Backup DB', url: APP_URL});
            assert(logged.includes('Telegram bot not found!'));

            await enableTelegram({ytdl_telegram_chat_id: ''});
            await notifications.sendTelegramNotification({title: 'Task finished', body: 'Backup DB', url: APP_URL});
            assert(logged.includes('Telegram chat ID required!'));
            assert.deepEqual(axios_requests.map(request => request.url.split('/').pop()), ['setWebhook']);
        });
    });
});
