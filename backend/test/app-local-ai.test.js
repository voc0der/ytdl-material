const assert = require('assert');
const {startApp} = require('./helpers/app-process');

describe('Local AI routes and permissions', function() {
    this.timeout(30000);
    let app;
    const tokens = {};
    const as = (user, method, route) => app.api[method](route).query({jwt: tokens[user]});

    before(async function() {
        app = await startApp({env: {ytdl_multi_user_mode: 'true'}});
        for (const username of ['admin', 'reader']) {
            await app.api.post('/api/auth/register').send({userid: username, username, password: 'test-password'}).expect(200);
            const response = await app.api.post('/api/auth/login').send({username, password: 'test-password'}).expect(200);
            tokens[username] = response.body.token;
        }
    });
    after(async function() { if (app) await app.stop(); });

    it('requires an administrator to test the connection', async function() {
        await app.api.post('/api/testAIConnection').send({}).expect(401);
        await as('reader', 'post', '/api/testAIConnection').send({}).expect(403);
        const response = await as('admin', 'post', '/api/testAIConnection').send({}).expect(400);
        assert.match(response.body.error, /disabled/);
    });

    it('defaults to disabled and refuses direct task execution', async function() {
        const tasks = await as('admin', 'post', '/api/getTasks').send({}).expect(200);
        assert(!tasks.body.tasks.some(task => task.key === 'auto_transcribe'));
        const response = await as('admin', 'post', '/api/runTask').send({task_key: 'auto_transcribe'}).expect(200);
        assert.strictEqual(response.body.success, false);
    });

    it('validates saved settings and exposes the unscheduled task only after opt-in', async function() {
        const response = await as('admin', 'get', '/api/config').expect(200);
        const config = response.body.config_file;
        config.YtdlMaterial.Advanced.ai.enabled = true;
        config.YtdlMaterial.Advanced.ai.model = 'local-model';
        config.YtdlMaterial.Advanced.ai.api_key = 'ai-test-value';
        config.YtdlMaterial.Advanced.ai.transcription_api_key = 'speech-test-value';
        config.YtdlMaterial.Advanced.ai.base_url = 'https://8.8.8.8';
        await as('admin', 'post', '/api/setConfig').send({new_config_file: config}).expect(400);
        config.YtdlMaterial.Advanced.ai.base_url = 'http://127.0.0.1:11434';
        await as('reader', 'post', '/api/setConfig').send({new_config_file: config}).expect(403);
        await as('admin', 'post', '/api/setConfig').send({new_config_file: config}).expect(200);
        const tasks = await as('admin', 'post', '/api/getTasks').send({}).expect(200);
        const task = tasks.body.tasks.find(task => task.key === 'auto_transcribe');
        assert(task);
        assert.strictEqual(task.schedule, null);
        assert.strictEqual(task.options.max_files, 10);
    });

    it('redacts AI credentials for other users and anonymous visitors', async function() {
        const reader = await as('reader', 'get', '/api/config').expect(200);
        const anonymous = await app.api.get('/api/config').expect(200);
        for (const response of [reader, anonymous]) {
            assert(!JSON.stringify(response.body).includes('ai-test-value'));
            assert(!JSON.stringify(response.body).includes('speech-test-value'));
        }
    });

    it('removes AI tasks from the list immediately when disabled again', async function() {
        const response = await as('admin', 'get', '/api/config').expect(200);
        const config = response.body.config_file;
        config.YtdlMaterial.Advanced.ai.enabled = false;
        await as('admin', 'post', '/api/setConfig').send({new_config_file: config}).expect(200);
        const tasks = await as('admin', 'post', '/api/getTasks').send({}).expect(200);
        assert(!tasks.body.tasks.some(task => task.key === 'auto_transcribe'));
    });
});
