const assert = require('assert');
const http = require('http');
const {once} = require('events');
const notifications = require('../notifications');
const config = require('../config');
const db = require('../db');
const logger = require('../logger');

describe('Gotify notifications', function() {
    let server;
    let settings;
    let requests;
    let saved;
    let warnings;
    let status;
    let originals;

    const notification = {
        type: 'download_complete',
        data: {file_title: 'A video', original_url: 'https://example.com/watch', file_uid: 'video-id', file_thumbnail: 'https://example.com/image.jpg'}
    };

    beforeEach(async function() {
        requests = [];
        saved = [];
        warnings = [];
        status = 200;
        server = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            requests.push({url: req.url, method: req.method, headers: req.headers, body: JSON.parse(Buffer.concat(chunks))});
            res.writeHead(status, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({id: 1}));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        settings = {
            ytdl_use_gotify_API: true,
            ytdl_gotify_server_url: `http://127.0.0.1:${server.address().port}`,
            ytdl_gotify_app_token: 'test-secret-token'
        };
        originals = {get: config.getConfigItem, insert: db.insertRecordIntoTable, warn: logger.warn};
        config.getConfigItem = key => settings[key];
        db.insertRecordIntoTable = async (table, record) => saved.push({table, record});
        logger.warn = message => warnings.push(message);
    });

    afterEach(async function() {
        config.getConfigItem = originals.get;
        db.insertRecordIntoTable = originals.insert;
        logger.warn = originals.warn;
        await new Promise(resolve => server.close(resolve));
    });

    for (const suffix of ['', '/', '/gotify', '/gotify/']) {
        it(`posts the existing payload and token under a server URL ending in '${suffix}'`, async function() {
            settings.ytdl_gotify_server_url += suffix;
            assert.strictEqual(await notifications.sendNotification(notification), notification);
            assert.strictEqual(requests.length, 1);
            const request = requests[0];
            assert.strictEqual(request.method, 'POST');
            assert.strictEqual(request.url, suffix.includes('gotify') ? '/gotify/message' : '/message');
            assert.strictEqual(request.headers['x-gotify-key'], settings.ytdl_gotify_app_token);
            assert.match(request.headers['content-type'], /application\/json/);
            assert.deepStrictEqual(request.body, {
                title: 'Download complete',
                message: 'A video\nOriginal URL: https://example.com/watch',
                priority: 5,
                extras: {'client::notification': {
                    click: {url: `${require('../utils').getBaseURL()}/#/player;uid=video-id`},
                    bigImageUrl: 'https://example.com/image.jpg'
                }}
            });
            assert.deepStrictEqual(saved, [{table: 'notifications', record: notification}]);
        });
    }

    it('handles HTTP failure without losing the notification or logging the token', async function() {
        status = 401;
        await notifications.sendNotification(notification);
        assert.strictEqual(saved.length, 1);
        assert.deepStrictEqual(warnings, ['Failed to send Gotify notification: 401']);
    });

    it('handles connection failure without an unhandled rejection', async function() {
        await new Promise(resolve => server.close(resolve));
        await notifications.sendNotification(notification);
        assert.strictEqual(saved.length, 1);
        assert.deepStrictEqual(warnings, ['Failed to send Gotify notification: ECONNREFUSED']);
    });

    it('skips Gotify when it is disabled or lacks configuration', async function() {
        for (const key of ['ytdl_use_gotify_API', 'ytdl_gotify_server_url', 'ytdl_gotify_app_token']) {
            const value = settings[key];
            settings[key] = null;
            await notifications.sendNotification(notification);
            settings[key] = value;
        }
        assert.strictEqual(requests.length, 0);
        assert.strictEqual(saved.length, 3);
    });
});
