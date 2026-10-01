const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const CONSTS = require('../consts');
const { startApp, addSampleMedia, BACKEND } = require('./helpers/app-process');

// Served by its extension, so the bytes only have to be recognizable.
const THUMBNAIL_BYTES = Buffer.from('thumbnail bytes');
const VERSION_INFO = {type: 'docker', tag: 'v0.0.0-test', commit: 'abc1234', date: '2026-01-01'};
const THUMBNAIL_URL = 'https://example.com/thumb.jpg';

// supertest only buffers bodies it knows how to parse, and media is not one of them.
function collectBytes(res, callback) {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
}

// multer names what it is still writing with 32 hex characters.
function strayUploads() {
    return fs.readdirSync(path.join(BACKEND, 'appdata')).filter(name => /^[0-9a-f]{32}$/.test(name)).sort();
}

/*************************************************
 * The real server, booted the way the container
 * boots it, and driven over HTTP.
 *
 * Covers the parts of app.js that sit directly on a
 * dependency -- express and its body parsers,
 * compression, the rate limiters, multer, the API
 * reference, feed, read-last-lines, mime-types and
 * croner -- so that an upgrade which changes how any
 * of them behaves fails here, not on a server.
 ************************************************/
describe('The server as it runs', function() {
    this.timeout(30000);

    let app;
    const files = {};

    before(async function() {
        app = await startApp({
            env: {
                ytdl_enable_documentation_api: 'true',
                ytdl_enable_rss_feed: 'true'
            },
            prepare: async ({root, media}) => {
                // What a finished update leaves for the next start to report.
                await fs.writeFile(path.join(root, 'restart_update.json'), 'internal use only');
                await fs.writeJSON(path.join(root, 'version.json'), VERSION_INFO);
                await addSampleMedia(media.video, {thumbnail: THUMBNAIL_BYTES, info: {thumbnail: THUMBNAIL_URL}});
                await addSampleMedia(media.audio, {type: 'audio'});
            }
        });

        const imported = await app.api.post('/api/runTask').send({task_key: 'missing_db_records'}).expect(200);
        assert.strictEqual(imported.body.success, true);
        files.video = (await app.api.get('/api/getMp4s').expect(200)).body.mp4s[0];
        files.audio = (await app.api.get('/api/getMp3s').expect(200)).body.mp3s[0];
        assert(files.video && files.audio, 'expected the import task to register both samples');
    });

    after(async function() {
        if (app) await app.stop();
    });

    describe('Startup', function() {
        it('reports a finished update, and clears the marker it left', async function() {
            const res = await app.api.get('/api/updaterStatus').expect(200);
            assert.deepStrictEqual(res.body, {updating: false, details: `Update complete! You are now on ${CONSTS.CURRENT_VERSION}`});
            assert(!fs.existsSync(path.join(app.root, 'restart_update.json')));
        });

        it('reports the build it was started from', async function() {
            const res = await app.api.get('/api/versionInfo').expect(200);
            assert.deepStrictEqual(res.body.version_info, VERSION_INFO);
        });

        it('answers health checks', async function() {
            const res = await app.api.get('/healthz').expect(200);
            assert.strictEqual(res.text, 'ok');
        });

        it('reports OIDC as off, with no OIDC login to start', async function() {
            const status = await app.api.get('/api/auth/oidc/status').expect(200);
            assert.strictEqual(status.body.enabled, false);
            await app.api.get('/api/auth/oidc/login').expect(404);
            await app.api.get('/api/auth/oidc/callback').expect(404);
        });
    });

    describe('Request handling', function() {
        it('reads JSON bodies', async function() {
            const res = await app.api.post('/api/createCategory').send({name: 'From JSON'}).expect(200);
            assert.strictEqual(res.body.new_category.name, 'From JSON');
        });

        it('reads form-encoded bodies', async function() {
            const res = await app.api.post('/api/createCategory').type('form').send({name: 'From a form'}).expect(200);
            assert.strictEqual(res.body.new_category.name, 'From a form');
        });

        it('refuses a malformed JSON body and keeps serving', async function() {
            await app.api.post('/api/createCategory').set('Content-Type', 'application/json').send('{not json').expect(400);
            await app.api.get('/healthz').expect(200);
        });

        it('answers an API route that does not exist with a 404', async function() {
            await app.api.post('/api/noSuchRoute').set('Accept', 'application/json').send({}).expect(404);
        });

        it('names the configured origin for cross-origin requests', async function() {
            const res = await app.api.get('/api/versionInfo').expect(200);
            assert.strictEqual(res.headers['access-control-allow-origin'], 'http://example.com');
            assert.match(res.headers['access-control-allow-headers'], /Authorization/);
        });

        it('answers a CORS preflight itself', async function() {
            const res = await app.api.options('/api/deleteFile').expect(200);
            assert.strictEqual(res.text, 'OK');
            assert.strictEqual(res.headers['access-control-allow-origin'], 'http://example.com');
        });
    });

    describe('Compression', function() {
        it('gzips a response when the client accepts it', async function() {
            const res = await app.api.get('/api/config').set('Accept-Encoding', 'gzip').expect(200);
            assert.strictEqual(res.headers['content-encoding'], 'gzip');
            assert.match(res.headers['vary'], /Accept-Encoding/);
            assert.strictEqual(res.body.success, true);
        });

        it('sends it as it is otherwise', async function() {
            const res = await app.api.get('/api/config').set('Accept-Encoding', 'identity').expect(200);
            assert.strictEqual(res.headers['content-encoding'], undefined);
            assert.strictEqual(res.body.success, true);
        });
    });

    describe('Rate limiting', function() {
        it('advertises the limit on the routes it applies to', async function() {
            const res = await app.api.post('/api/createCategory').send({name: 'Counted'}).expect(200);
            assert.strictEqual(res.headers['ratelimit-limit'], '300');
            assert.strictEqual(res.headers['ratelimit-policy'], '300;w=60');
            assert(Number(res.headers['ratelimit-remaining']) < 300);
        });

        it('leaves the read-only routes out', async function() {
            const res = await app.api.get('/api/getMp4s').expect(200);
            assert.strictEqual(res.headers['ratelimit-limit'], undefined);
        });

        it('stops cookie tests after ten in a minute', async function() {
            const responses = [];
            for (let i = 0; i < 11; i++) {
                // Invalid either way, so nothing ever runs yt-dlp.
                responses.push(await app.api.post('/api/testCookies').send(i % 2 ? {url: 'ftp://example.com/'} : {}));
            }

            assert.deepStrictEqual(responses.map(res => res.status), [...Array(10).fill(400), 429]);
            assert.strictEqual(responses[0].body.error, 'Missing URL to test.');
            assert.strictEqual(responses[1].body.error, 'Invalid URL. Only http/https URLs are allowed.');

            const refused = responses[10];
            assert.deepStrictEqual(refused.body, {success: false, error: 'Too many cookie test requests. Please wait a minute and try again.'});
            assert(Number(refused.headers['retry-after']) > 0);
        });
    });

    describe('Cookie uploads', function() {
        const cookies_path = path.join(BACKEND, 'appdata', 'cookies.txt');
        let strays_before;
        let cookies_before;

        before(function() {
            strays_before = strayUploads();
            cookies_before = fs.existsSync(cookies_path) ? fs.readFileSync(cookies_path) : null;
        });

        afterEach(function() {
            assert.deepStrictEqual(strayUploads(), strays_before, 'an upload left a partial file in appdata');
            if (cookies_before) assert(fs.readFileSync(cookies_path).equals(cookies_before), 'cookies.txt changed');
        });

        it('refuses a request with no file', async function() {
            await app.api.post('/api/uploadCookies').expect(400);
        });

        it('refuses a file over the size limit and keeps none of it', async function() {
            const res = await app.api.post('/api/uploadCookies')
                .attach('cookies', Buffer.alloc(2 * 1024 * 1024 + 1, 'a'), 'cookies.txt');
            assert(res.status >= 400, `expected a refusal, got ${res.status}`);
            assert.match(res.text, /too large/i);
        });

        it('refuses a file sent under another field name', async function() {
            const res = await app.api.post('/api/uploadCookies').attach('not_cookies', Buffer.from('x'), 'cookies.txt');
            assert(res.status >= 400, `expected a refusal, got ${res.status}`);
            assert.match(res.text, /unexpected/i);
        });

        it('stores an upload as cookies.txt', async function() {
            // The upload lands in the checkout's own appdata, which may hold somebody's real
            // cookies. Only run where there are none to lose, as in CI.
            if (cookies_before) this.skip();

            const contents = '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tname\tvalue\n';
            try {
                const res = await app.api.post('/api/uploadCookies').attach('cookies', Buffer.from(contents), 'cookies.txt').expect(200);
                assert.deepStrictEqual(res.body, {success: true});
                assert.strictEqual(fs.readFileSync(cookies_path, 'utf8'), contents);
            } finally {
                fs.removeSync(cookies_path);
            }
        });
    });

    describe('API reference', function() {
        it('serves the reference page for the spec', async function() {
            const res = await app.api.get('/docs').expect(200);
            assert.match(res.headers['content-type'], /text\/html/);
            assert(res.text.includes('<title>ytdl-material API Reference</title>'));
            assert(res.text.includes('/openapi.yaml'));
        });

        it('serves the spec as YAML', async function() {
            const res = await app.api.get('/openapi.yaml').buffer(true).parse(collectBytes).expect(200);
            assert.strictEqual(res.headers['content-type'], 'application/yaml');
            assert(res.body.equals(fs.readFileSync(path.join(BACKEND, '..', 'Public API v1.yaml'))));
        });
    });

    describe('Logs', function() {
        const combined_log = () => fs.readFileSync(path.join(app.root, 'appdata', 'logs', 'combined.log'), 'utf8');

        it('returns as many trailing lines as asked for', async function() {
            const res = await app.api.post('/api/logs').send({lines: 3}).expect(200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.logs.split('\n').filter(line => line !== '').length, 3);
            assert(combined_log().includes(res.body.logs));
        });

        it('returns the whole file when no count is given', async function() {
            const res = await app.api.post('/api/logs').send({}).expect(200);
            assert.match(res.body.logs, /started on HTTP PORT/);
        });

        it('clears the logs', async function() {
            const res = await app.api.post('/api/clearAllLogs').send({}).expect(200);
            assert.strictEqual(res.body.success, true);
            assert.doesNotMatch(combined_log(), /started on HTTP PORT/);
        });
    });

    describe('RSS feed', function() {
        let config_file;

        before(async function() {
            config_file = (await app.api.get('/api/config').expect(200)).body.config_file;
        });

        it('lists every file as an RSS 2.0 item', async function() {
            const res = await app.api.get('/api/rss').expect(200);
            assert(res.text.startsWith('<?xml'));
            assert(res.text.includes('<rss version="2.0">'));
            assert.strictEqual(res.text.split('<item>').length - 1, 2);
            assert(res.text.includes(`/#/player;uid=${files.video.uid}`));
            assert(res.text.includes(`/#/player;uid=${files.audio.uid}`));
        });

        it('describes each file by its title, uploader and thumbnail', async function() {
            const res = await app.api.get('/api/rss').expect(200);
            assert(res.text.includes(`<title><![CDATA[${files.video.title}]]></title>`));
            assert(res.text.includes(`<author>${files.video.uploader}</author>`));
            assert(res.text.includes(`<enclosure url="${THUMBNAIL_URL}"`));
        });

        it('is refused while switched off in the settings', async function() {
            const disabled = JSON.parse(JSON.stringify(config_file));
            disabled.YtdlMaterial.Extra.enable_rss_feed = false;
            await app.api.post('/api/setConfig').send({new_config_file: disabled}).expect(200);
            try {
                await app.api.get('/api/rss').expect(403);
            } finally {
                await app.api.post('/api/setConfig').send({new_config_file: config_file}).expect(200);
            }
            await app.api.get('/api/rss').expect(200);
        });
    });

    describe('Settings', function() {
        it('applies a saved config without a restart', async function() {
            const config_file = (await app.api.get('/api/config').expect(200)).body.config_file;
            const moved = JSON.parse(JSON.stringify(config_file));
            moved.YtdlMaterial.Host.url = 'https://media.example.org:8443';

            const saved = await app.api.post('/api/setConfig').send({new_config_file: moved}).expect(200);
            assert.strictEqual(saved.body.success, true);
            try {
                const res = await app.api.get('/api/versionInfo').expect(200);
                assert.strictEqual(res.headers['access-control-allow-origin'], 'https://media.example.org:8443');
                const reread = await app.api.get('/api/config').expect(200);
                assert.strictEqual(reread.body.config_file.YtdlMaterial.Host.url, 'https://media.example.org:8443');
            } finally {
                await app.api.post('/api/setConfig').send({new_config_file: config_file}).expect(200);
            }
        });

        it('refuses a config without its root key', async function() {
            await app.api.post('/api/setConfig').send({new_config_file: {Host: {}}}).expect(400);
        });

        it('says API tokens are for multi-user mode', async function() {
            const res = await app.api.post('/api/generateAPIToken').send({label: 'never issued'}).expect(400);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.error, /multi-user mode/);
            await app.api.post('/api/listAPITokens').send({}).expect(400);
        });
    });

    describe('Streaming', function() {
        it('streams a whole file with its media type', async function() {
            const contents = fs.readFileSync(files.video.path);
            const res = await app.api.get('/api/stream').query({uid: files.video.uid, type: 'video'})
                .buffer(true).parse(collectBytes).expect(200);
            assert.strictEqual(res.headers['content-type'], 'video/mp4');
            assert.strictEqual(res.headers['accept-ranges'], 'bytes');
            assert.strictEqual(Number(res.headers['content-length']), contents.length);
            assert(res.body.equals(contents));
        });

        it('streams the byte range asked for', async function() {
            const contents = fs.readFileSync(files.video.path);
            const res = await app.api.get('/api/stream').query({uid: files.video.uid, type: 'video'})
                .set('Range', 'bytes=10-19').buffer(true).parse(collectBytes).expect(206);
            assert.strictEqual(res.headers['content-range'], `bytes 10-19/${contents.length}`);
            assert(res.body.equals(contents.subarray(10, 20)));
        });

        it('answers HEAD with the headers alone', async function() {
            const res = await app.api.head('/api/stream').query({uid: files.audio.uid, type: 'audio'}).expect(200);
            assert.strictEqual(res.headers['content-type'], 'audio/mpeg');
            assert.strictEqual(Number(res.headers['content-length']), fs.statSync(files.audio.path).size);
        });

        it('says how big the file is when a range is past its end', async function() {
            const size = fs.statSync(files.video.path).size;
            const res = await app.api.get('/api/stream').query({uid: files.video.uid}).set('Range', `bytes=${size + 100}-`).expect(416);
            assert.strictEqual(res.headers['content-range'], `bytes */${size}`);
        });

        it('refuses a request without a uid, or for one that does not exist', async function() {
            await app.api.get('/api/stream').expect(400);
            await app.api.get('/api/stream').query({uid: 'no-such-file'}).expect(404);
        });
    });

    describe('Sending files', function() {
        it('sends a file\'s thumbnail by the file\'s uid', async function() {
            const res = await app.api.get(`/api/thumbnail/${files.video.uid}`).buffer(true).parse(collectBytes).expect(200);
            assert.strictEqual(res.headers['content-type'], 'image/jpeg');
            assert(res.body.equals(THUMBNAIL_BYTES));
            await app.api.get(`/api/thumbnail/${files.audio.uid}`).expect(404);
        });

        it('sends a file for download', async function() {
            const res = await app.api.post('/api/downloadFileFromServer').send({uid: files.audio.uid})
                .buffer(true).parse(collectBytes).expect(200);
            assert.strictEqual(res.headers['content-type'], 'audio/mpeg');
            assert(res.body.equals(fs.readFileSync(files.audio.path)));
            await app.api.post('/api/downloadFileFromServer').send({uid: 'no-such-file'}).expect(404);
        });
    });

    describe('Tasks', function() {
        const getTask = async (task_key) => (await app.api.post('/api/getTask').send({task_key}).expect(200)).body.task;

        it('lists every task, with the next run for the scheduled ones', async function() {
            const {tasks} = (await app.api.post('/api/getTasks').send({}).expect(200)).body;
            const keys = tasks.map(task => task.key);
            for (const key of ['backup_local_db', 'missing_files_check', 'missing_db_records', 'subscriptions_check', 'youtubedl_update_check']) {
                assert(keys.includes(key), `missing task ${key}`);
            }

            // Scheduled by default for the coming midnight.
            const subscriptions_check = tasks.find(task => task.key === 'subscriptions_check');
            const next_run = new Date(subscriptions_check.next_invocation);
            assert(next_run.getTime() > Date.now());
            assert.deepStrictEqual([next_run.getHours(), next_run.getMinutes()], [0, 0]);
            assert.strictEqual(tasks.find(task => task.key === 'missing_db_records').next_invocation, undefined);
        });

        it('schedules a task for a day of the week and a time', async function() {
            await app.api.post('/api/updateTaskSchedule').send({
                task_key: 'missing_files_check',
                new_schedule: {type: 'recurring', data: {dayOfWeek: [3], hour: 4, minute: 30}}
            }).expect(200);

            const next_run = new Date((await getTask('missing_files_check')).next_invocation);
            assert.deepStrictEqual([next_run.getDay(), next_run.getHours(), next_run.getMinutes()], [3, 4, 30]);
            assert(next_run.getTime() > Date.now());
            assert(next_run.getTime() - Date.now() <= 7 * 24 * 60 * 60 * 1000);
        });

        it('schedules a single run for a time', async function() {
            const run_at = new Date(Date.now() + 24 * 60 * 60 * 1000);
            run_at.setMilliseconds(0);
            await app.api.post('/api/updateTaskSchedule').send({
                task_key: 'duplicate_files_check',
                new_schedule: {type: 'timestamp', data: {timestamp: run_at.getTime()}}
            }).expect(200);

            assert.strictEqual((await getTask('duplicate_files_check')).next_invocation, run_at.getTime());
        });

        it('unschedules a task', async function() {
            await app.api.post('/api/updateTaskSchedule').send({task_key: 'missing_files_check', new_schedule: null}).expect(200);
            assert.strictEqual((await getTask('missing_files_check')).schedule, null);
        });

        it('keeps each task\'s options and data, and dismisses its error', async function() {
            await app.api.post('/api/updateTaskOptions').send({task_key: 'delete_old_files', new_options: {threshold_days: 30, auto_confirm: true}}).expect(200);
            await app.api.post('/api/updateTaskData').send({task_key: 'delete_old_files', new_data: {files_to_remove: []}}).expect(200);
            await app.api.post('/api/dismissTaskError').send({task_key: 'delete_old_files'}).expect(200);

            const task = await getTask('delete_old_files');
            assert.deepStrictEqual(task.options, {threshold_days: 30, auto_confirm: true});
            assert.deepStrictEqual(task.data, {files_to_remove: []});
            assert.strictEqual(task.error, null);
        });

        it('backs up the database, lists the backup, and restores it', async function() {
            const ran = await app.api.post('/api/runTask').send({task_key: 'backup_local_db'}).expect(200);
            assert.strictEqual(ran.body.success, true);

            const {db_backups} = (await app.api.post('/api/getDBBackups').send({}).expect(200)).body;
            assert.strictEqual(db_backups.length, 1);
            assert.strictEqual(db_backups[0].source, 'local');
            assert(db_backups[0].size > 0);
            assert(Number.isInteger(db_backups[0].timestamp));

            const restored = await app.api.post('/api/restoreDBBackup').send({file_name: db_backups[0].name}).expect(200);
            assert(restored.body.success);
            const {mp4s} = (await app.api.get('/api/getMp4s').expect(200)).body;
            assert.deepStrictEqual(mp4s.map(file => file.uid), [files.video.uid]);
        });

        it('refuses to restore from outside the backup folder', async function() {
            const res = await app.api.post('/api/restoreDBBackup').send({file_name: '../default.json'}).expect(200);
            assert.strictEqual(res.body.success, false);
        });

        it('recreates the task list when reset', async function() {
            await app.api.post('/api/resetTasks').send({}).expect(200);
            const {tasks} = (await app.api.post('/api/getTasks').send({}).expect(200)).body;
            assert(tasks.some(task => task.key === 'backup_local_db'));
            assert.strictEqual(tasks.find(task => task.key === 'missing_files_check').schedule, null);
        });
    });

    // Last: the server is gone afterwards.
    describe('Restarting', function() {
        it('exits for the process manager to start it again', async function() {
            const res = await app.api.post('/api/restartServer').send({}).expect(200);
            assert.deepStrictEqual(res.body, {success: true});

            const {code} = await app.exited;
            assert.strictEqual(code, 1);
            assert(fs.existsSync(path.join(app.root, 'restart_general.json')));
        });
    });
});
