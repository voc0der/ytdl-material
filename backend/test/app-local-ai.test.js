const assert = require('assert');
const http = require('http');
const {startApp} = require('./helpers/app-process');

describe('Local AI routes and permissions', function() {
    this.timeout(30000);
    let app, server, base;
    const tokens = {};
    const as = (user, method, route) => app.api[method](route).query({jwt: tokens[user]});

    before(async function() {
        server = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.headers.authorization !== 'Bearer server-key') {
                res.statusCode = 401;
                return res.end(JSON.stringify({error: 'Unauthorized'}));
            }
            res.end(JSON.stringify({object: 'list', data: [{id: 'gemma'}, {id: 'qwen'}]}));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        app = await startApp({env: {ytdl_multi_user_mode: 'true'}});
        for (const username of ['admin', 'reader']) {
            await app.api.post('/api/auth/register').send({userid: username, username, password: 'test-password'}).expect(200);
            const response = await app.api.post('/api/auth/login').send({username, password: 'test-password'}).expect(200);
            tokens[username] = response.body.token;
        }
    });
    after(async function() {
        if (app) await app.stop();
        if (server) await new Promise(resolve => server.close(resolve));
    });

    it('lets only an administrator save the server and list its models', async function() {
        await app.api.post('/api/setAIServer').send({base_url: base}).expect(401);
        await as('reader', 'post', '/api/setAIServer').send({base_url: base}).expect(403);
        await app.api.post('/api/getAIModels').send({}).expect(401);
        await as('reader', 'post', '/api/getAIModels').send({}).expect(403);
        await as('admin', 'post', '/api/setAIServer').send({base_url: `${base}/v1`, api_key: 'server-key'}).expect(200);
        const saved = (await as('admin', 'get', '/api/config').expect(200)).body.config_file.YtdlMaterial.Advanced.ai;
        assert.deepStrictEqual([saved.base_url, saved.api_key, saved.enabled], [`${base}/v1`, 'server-key', false]);
        const response = await as('admin', 'post', '/api/getAIModels').send({}).expect(200);
        assert.deepStrictEqual(response.body.models, ['gemma', 'qwen']);
    });

    it('asks only the saved server, whatever a request names', async function() {
        const response = await as('admin', 'post', '/api/getAIModels').send({base_url: 'http://127.0.0.1:1'}).expect(200);
        assert.deepStrictEqual(response.body.models, ['gemma', 'qwen']);
    });

    it('says why a server cannot be saved or asked, and saves nothing it refuses', async function() {
        await as('admin', 'post', '/api/setAIServer').send({base_url: base, api_key: 'wrong-key'}).expect(200);
        const refused = await as('admin', 'post', '/api/getAIModels').send({}).expect(400);
        assert.match(refused.body.error, /refused the API key \(HTTP 401\)/);
        const public_address = await as('admin', 'post', '/api/setAIServer').send({base_url: 'http://8.8.8.8'}).expect(400);
        assert.match(public_address.body.error, /loopback or private network address/);
        const missing = await as('admin', 'post', '/api/setAIServer').send({}).expect(400);
        assert.match(missing.body.error, /Enter the AI server URL/);
        const saved = (await as('admin', 'get', '/api/config').expect(200)).body.config_file.YtdlMaterial.Advanced.ai;
        assert.deepStrictEqual([saved.base_url, saved.api_key], [base, 'wrong-key']);
        await as('admin', 'post', '/api/setAIServer').send({base_url: base, api_key: 'server-key'}).expect(200);
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
        assert.deepStrictEqual(config.YtdlMaterial.Advanced.ai, {enabled: false, base_url: base, model: '', api_key: 'server-key', vision: false, audio: false});
        Object.assign(config.YtdlMaterial.Advanced.ai, {enabled: true, model: 'gemma', api_key: 'ai-test-value', audio: true, base_url: 'https://8.8.8.8'});
        const refused = await as('admin', 'post', '/api/setConfig').send({new_config_file: config}).expect(400);
        assert.match(refused.body.error, /loopback or private/);
        config.YtdlMaterial.Advanced.ai.base_url = base;
        await as('reader', 'post', '/api/setConfig').send({new_config_file: config}).expect(403);
        await as('admin', 'post', '/api/setConfig').send({new_config_file: config}).expect(200);
        const tasks = await as('admin', 'post', '/api/getTasks').send({}).expect(200);
        const task = tasks.body.tasks.find(task => task.key === 'auto_transcribe');
        assert(task);
        assert.strictEqual(task.schedule, null);
        assert.deepStrictEqual(task.options, {auto_confirm: false, max_files: 10, audio_style: 'exact', vision_style: 'off'});
    });

    it('redacts the API key for other users and anonymous visitors', async function() {
        const reader = await as('reader', 'get', '/api/config').expect(200);
        const anonymous = await app.api.get('/api/config').expect(200);
        for (const response of [reader, anonymous]) {
            assert(!JSON.stringify(response.body).includes('ai-test-value'));
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
