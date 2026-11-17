const {assert, fs, os, path, db_api, config_api, useTemporaryMediaRoots} = require('./test-shared');
const http = require('http');
const dns = require('dns');
const {execFileSync} = require('child_process');
const ai = require('../local-ai');
const transcription = require('../ai-transcription');

describe('Local AI', function() {
    this.timeout(20000);
    let server, base, media, handler, calls, lookup, original;
    const settings = values => config_api.setConfigItems(Object.entries(values).map(([key, value]) => ({key: `ytdl_ai_${key}`, value})));
    const options = async values => db_api.updateRecord('tasks', {key: 'auto_transcribe'}, {options: {max_files: 10, audio_style: 'exact', vision_style: 'off', ...values}});
    const reply = (res, content) => res.end(JSON.stringify({choices: [{message: {role: 'assistant', content}}]}));
    const userContent = call => call.json.messages.find(message => message.role === 'user').content;
    const promptOf = call => userContent(call).find(part => part.type === 'text').text;
    const partsOf = (call, type) => userContent(call).filter(part => part.type === type);

    beforeEach(async function() {
        original = ai.settings();
        calls = [];
        lookup = dns.lookup;
        handler = (req, res) => {
            if (req.url.endsWith('/models')) return res.end(JSON.stringify({object: 'list', data: [{id: 'local-model'}]}));
            reply(res, 'A local transcript.');
        };
        server = http.createServer(async (req, res) => {
            const buffers = [];
            for await (const chunk of req) buffers.push(chunk);
            const body = Buffer.concat(buffers);
            let json = null;
            try { json = JSON.parse(body.toString()); } catch { /* Not every request has a body. */ }
            calls.push({method: req.method, url: req.url, headers: req.headers, body, json});
            res.setHeader('Content-Type', 'application/json');
            handler(req, res);
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        base = `http://127.0.0.1:${server.address().port}`;
        media = useTemporaryMediaRoots();
        settings({enabled: true, base_url: base, model: 'local-model', api_key: 'local-secret', vision: false, audio: true});
        await db_api.removeAllRecords('files');
        await db_api.removeAllRecords('tasks');
        await db_api.insertRecordIntoTable('tasks', {key: 'auto_transcribe', options: {max_files: 10, audio_style: 'exact', vision_style: 'off'}});
    });

    afterEach(async function() {
        dns.lookup = lookup;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await db_api.removeAllRecords('files');
        await db_api.removeAllRecords('tasks');
        media?.restore();
        settings(original);
    });

    async function addFile(name = 'clip', duration = 1) {
        const file = {uid: name, id: name, title: 'A clip', isAudio: true, url: '', path: path.join(media.audio, `${name}.wav`)};
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`, '-ar', '16000', file.path]);
        await db_api.insertRecordIntoTable('files', {...file});
        return file;
    }

    async function addVideo(name = 'video', {sound = true, duration = 1} = {}) {
        const file = {uid: name, id: name, title: 'Video', isAudio: false, url: '', path: path.join(media.video, `${name}.mp4`)};
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=blue:size=64x64:rate=10:duration=${duration}`,
            ...(sound ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`, '-c:a', 'aac'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file.path]);
        await db_api.insertRecordIntoTable('files', {...file});
        return file;
    }
    const sidecar = file => `${file.path.slice(0, -4)}.info.json`;

    describe('listing models', function() {
        it('lists the models the saved server runs, from its URL with or without /v1, leaving out cloud models', async function() {
            handler = (req, res) => res.end(JSON.stringify({object: 'list', data: [
                {id: 'zeta'}, {id: 'my-llamacpp/bartowski/gemma'}, {id: 'gpt-oss:120b-cloud'}, {id: 'zeta'}, {id: ''}, {}
            ]}));
            for (const base_url of [base, `${base}/v1`, `${base}/v1/`]) {
                settings({base_url});
                assert.deepStrictEqual(await ai.listModels(), ['my-llamacpp/bartowski/gemma', 'zeta']);
            }
            assert(calls.every(call => call.method === 'GET' && call.url === '/v1/models' && call.headers.authorization === 'Bearer local-secret'));
        });

        it('lists models before AI is turned on, since that is how the settings are filled in', async function() {
            settings({enabled: false, api_key: ''});
            assert.deepStrictEqual(await ai.listModels(), ['local-model']);
            assert.strictEqual(calls[0].headers.authorization, undefined);
        });

        it('says why a server could not list its models, without the API key', async function() {
            const answers = [
                [401, {error: 'bad key local-secret'}, /refused the API key \(HTTP 401\)/],
                [404, {}, /Nothing answered at http:\/\/127\.0\.0\.1:\d+\/v1\/models/],
                [500, {error: {message: 'Model failed to load: out of memory'}}, /HTTP 500: Model failed to load: out of memory/],
                [200, '<html>a web page</html>', /did not answer with a list of models/]
            ];
            for (const [status, body, expected] of answers) {
                handler = (req, res) => { res.statusCode = status; res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
                await assert.rejects(ai.listModels(), error => expected.test(error.message) && !error.message.includes('local-secret'));
            }
            const closed = http.createServer();
            await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
            const port = closed.address().port;
            await new Promise(resolve => closed.close(resolve));
            settings({base_url: `http://127.0.0.1:${port}`});
            await assert.rejects(ai.listModels(), /Nothing is listening at 127\.0\.0\.1:\d+/);
        });

        it('blocks public IPs, redirects, credentials in URLs, and public DNS answers', async function() {
            for (const base_url of ['http://8.8.8.8', 'http://[2001:4860:4860::8888]', 'http://user:secret@localhost', 'file:///tmp/model', 'not a url', '']) {
                assert.throws(() => ai.validateSettings({...ai.settings(), base_url}));
                assert.throws(() => ai.validateServer({base_url, api_key: ''}));
                settings({base_url});
                await assert.rejects(ai.listModels());
            }
            assert.strictEqual(calls.length, 0);
            settings({base_url: base});
            handler = (req, res) => { res.statusCode = 302; res.setHeader('Location', base + '/redirected'); res.end('{}'); };
            await assert.rejects(ai.listModels(), /HTTP 302/);
            assert.strictEqual(calls.length, 1);
            dns.lookup = (host, options, callback) => callback(null, [{address: '8.8.8.8', family: 4}]);
            settings({base_url: 'http://local.example:1234'});
            await assert.rejects(ai.listModels(), /local\.example resolves to an address outside the local network/);
            assert.strictEqual(calls.length, 1);
        });

        it('allows a private DNS name', async function() {
            dns.lookup = (host, options, callback) => callback(null, [{address: '127.0.0.1', family: 4}]);
            settings({base_url: base.replace('127.0.0.1', 'ai.internal')});
            assert.deepStrictEqual(await ai.listModels(), ['local-model']);
        });

        it('checks a server address and key on their own, as they are saved before the server is asked', function() {
            ai.validateServer({base_url: base, api_key: ''});
            ai.validateServer({base_url: `${base}/v1`, api_key: 'key'});
            assert.throws(() => ai.validateServer({base_url: base, api_key: 'k'.repeat(4097)}), /at most 4096/);
            assert.throws(() => ai.validateServer({base_url: base}), /at most 4096/);
        });
    });

    describe('settings', function() {
        it('accepts a server and the model it was chosen from, and refuses cloud models', function() {
            ai.validateSettings(ai.settings());
            assert.throws(() => ai.validateSettings({...ai.settings(), model: 'gpt-oss:120b-cloud'}), /Cloud models/);
            assert.throws(() => ai.validateSettings({...ai.settings(), vision: 'yes'}), /true or false/);
            ai.validateSettings({...ai.settings(), vision: undefined, audio: undefined});
        });

        it('redacts the API key and keeps it when a redacted config is saved', function() {
            const redacted = config_api.getRedactedConfigFile();
            assert(!JSON.stringify(redacted).includes('local-secret'));
            assert(config_api.setConfigFile(redacted));
            assert.strictEqual(ai.settings().api_key, 'local-secret');
        });
    });

    it('passes on why the model failed, such as audio it cannot hear', async function() {
        handler = (req, res) => { res.statusCode = 400; res.end(JSON.stringify({error: {code: 400, message: 'audio input is not supported by this model'}})); };
        await assert.rejects(ai.chat(ai.settings(), [{role: 'user', content: 'hi'}]), /HTTP 400: audio input is not supported by this model/);
    });

    it('drops what a reasoning model thought before its answer', async function() {
        handler = (req, res) => reply(res, '<think>Some reasoning.</think>\nSpoken words.');
        assert.strictEqual(await ai.chat(ai.settings(), [{role: 'user', content: 'hi'}]), 'Spoken words.');
    });

    it('does no network or media work while disabled, even for a scheduled run', async function() {
        settings({enabled: false});
        await addFile();
        assert.strictEqual(await transcription.run(), null);
        assert.strictEqual(calls.length, 0);
    });

    it('sends the audio to the chosen model, merges what it writes into existing metadata, and skips it next time', async function() {
        const file = await addFile();
        await fs.writeJSON(sidecar(file), {id: 'source-id', chapters: [{title: 'Original'}], ytdl_material: {custom: 'keep'}});
        assert.deepStrictEqual(await transcription.run(), {transcribed: 1, skipped: 0, failed: 0});
        const [call] = calls;
        assert.strictEqual(call.url, '/v1/chat/completions');
        assert.strictEqual(call.headers.authorization, 'Bearer local-secret');
        assert.strictEqual(call.json.model, 'local-model');
        const [audio] = partsOf(call, 'input_audio');
        assert.strictEqual(audio.input_audio.format, 'wav');
        assert(Buffer.from(audio.input_audio.data, 'base64').subarray(0, 4).equals(Buffer.from('RIFF')));
        assert.deepStrictEqual(partsOf(call, 'image_url'), []);
        assert.match(promptOf(call), /word for word/);
        const saved = await fs.readJSON(sidecar(file));
        assert.strictEqual(saved.id, 'source-id');
        assert.deepStrictEqual(saved.chapters, [{title: 'Original'}]);
        assert.strictEqual(saved.ytdl_material.custom, 'keep');
        const transcript = saved.ytdl_material.transcript;
        assert.strictEqual(transcript.text, 'A local transcript.');
        assert.deepStrictEqual([transcript.model, transcript.audio_style, transcript.vision_style], ['local-model', 'exact', 'off']);
        assert.deepStrictEqual(await transcription.run(), {transcribed: 0, skipped: 1, failed: 0});
        assert.strictEqual(calls.length, 1);
        settings({enabled: false});
        const attached = (await transcription.attachTranscript(file)).transcript;
        assert.deepStrictEqual([attached.text, attached.model, attached.audio_style, attached.vision_style], ['A local transcript.', 'local-model', 'exact', 'off']);
    });

    it('transcribes the audio track of a video file, without frames while Visual cues are off', async function() {
        settings({vision: true});
        const file = await addVideo();
        assert.strictEqual((await transcription.run()).transcribed, 1);
        assert.deepStrictEqual(partsOf(calls[0], 'image_url'), []);
        assert.strictEqual((await transcription.attachTranscript(file)).transcript.text, 'A local transcript.');
    });

    it('adds frames, and asks for what they show, when Vision is on and Visual cues are chosen', async function() {
        settings({vision: true});
        await options({vision_style: 'detailed'});
        const file = await addVideo();
        await transcription.run();
        const [call] = calls;
        assert.strictEqual(partsOf(call, 'input_audio').length, 1);
        const [frame] = partsOf(call, 'image_url');
        assert.match(frame.image_url.url, /^data:image\/jpeg;base64,\/9j\//);
        assert.match(promptOf(call), /word for word/);
        assert.match(promptOf(call), /changes of scene/);
        const transcript = (await fs.readJSON(sidecar(file))).ytdl_material.transcript;
        assert.deepStrictEqual([transcript.audio_style, transcript.vision_style], ['exact', 'detailed']);
    });

    it('describes a video with no sound from its frames alone', async function() {
        settings({vision: true});
        await options({vision_style: 'brief'});
        const file = await addVideo('silent', {sound: false});
        await transcription.run();
        assert.deepStrictEqual(partsOf(calls[0], 'input_audio'), []);
        assert.strictEqual(partsOf(calls[0], 'image_url').length, 1);
        assert.match(promptOf(calls[0]), /Say in a sentence what the frames show/);
        const transcript = (await fs.readJSON(sidecar(file))).ytdl_material.transcript;
        assert.deepStrictEqual([transcript.audio_style, transcript.vision_style], [null, 'brief']);
    });

    it('writes it up again when the model or a style changes', async function() {
        await addFile();
        await transcription.run();
        await options({audio_style: 'novel'});
        assert.strictEqual((await transcription.run()).transcribed, 1);
        assert.match(promptOf(calls[1]), /passage from a novel/);
        assert.strictEqual(calls[1].json.temperature, 0.7);
        settings({model: 'another-model'});
        assert.strictEqual((await transcription.run()).transcribed, 1);
        assert.strictEqual(calls[2].json.model, 'another-model');
        assert.strictEqual((await transcription.run()).skipped, 1);
    });

    it('refuses to run without a model, with nothing to send it, or with options it does not know', async function() {
        await addFile();
        settings({model: ''});
        await assert.rejects(transcription.run(), /Choose a model/);
        settings({model: 'local-model', audio: false});
        await assert.rejects(transcription.run(), /nothing to send the model/);
        settings({vision: true});
        await assert.rejects(transcription.run(), /nothing to send the model/);
        settings({audio: true});
        await options({audio_style: 'loud'});
        await assert.rejects(transcription.run(), /Choose how Auto-transcribe writes up speech/);
        await options({vision_style: 'everything'});
        await assert.rejects(transcription.run(), /Choose how Auto-transcribe describes visual cues/);
        assert.strictEqual(calls.length, 0);
    });

    it('goes through long media 30 seconds at a time, carrying the text so far into the next stretch', async function() {
        const file = await addFile('long', 61);
        handler = (req, res) => reply(res, `Part ${calls.length}`);
        await transcription.run();
        const transcript = (await fs.readJSON(sidecar(file))).ytdl_material.transcript;
        assert.strictEqual(transcript.text, 'Part 1\n\nPart 2\n\nPart 3');
        assert.deepStrictEqual(transcript.segments.map(({start, end}) => [start, end]), [[0, 30], [30, 60], [60, 61]]);
        assert.doesNotMatch(promptOf(calls[0]), /text so far/);
        assert.match(promptOf(calls[2]), /The text so far ends: "Part 1 Part 2"/);
        assert(calls.every(call => call.body.length < 16 * 1024 * 1024));
    });

    it('leaves no transcript when a later stretch fails', async function() {
        const file = await addFile('partial', 31);
        await fs.writeJSON(sidecar(file), {id: 'original'});
        handler = (req, res) => {
            if (calls.length > 1) res.statusCode = 503;
            reply(res, 'Only the first part');
        };
        await assert.rejects(transcription.run(), /1 file/);
        assert.deepStrictEqual(await fs.readJSON(sidecar(file)), {id: 'original'});
        assert.strictEqual(calls.length, 2);
    });

    it('lets later files progress when an earlier file repeatedly fails', async function() {
        const first = await addFile('bad');
        await addFile('good');
        await fs.writeFile(sidecar(first), 'broken');
        await options({max_files: 1});
        await assert.rejects(transcription.run(), /1 file/);
        assert.strictEqual((await transcription.run()).transcribed, 1);
        assert.strictEqual(calls.length, 1);
    });

    it('does not overwrite malformed sidecars or partial transcripts after a server failure', async function() {
        const broken = await addFile('broken');
        await fs.writeFile(sidecar(broken), 'not json');
        const failed = await addFile('failed');
        handler = (req, res) => { res.statusCode = 503; res.end('{}'); };
        await assert.rejects(transcription.run(), /2 file/);
        assert.strictEqual(await fs.readFile(sidecar(broken), 'utf8'), 'not json');
        assert(!await fs.pathExists(sidecar(failed)));
        assert.strictEqual(calls.length, 1);
    });

    it('rejects replies without text, creating no sidecar', async function() {
        const file = await addFile();
        handler = (req, res) => res.end(JSON.stringify({choices: [{message: {content: {invented: true}}}]}));
        await assert.rejects(transcription.run(), /1 file/);
        assert(!await fs.pathExists(sidecar(file)));
    });

    it('preserves older sidecar names and ignores stale transcripts after media changes', async function() {
        const file = await addFile();
        const legacy = `${file.path}.info.json`;
        await fs.writeJSON(legacy, {id: 'legacy'});
        await transcription.run();
        assert.strictEqual((await fs.readJSON(legacy)).id, 'legacy');
        assert(!await fs.pathExists(sidecar(file)));
        await fs.utimes(file.path, new Date(), new Date(Date.now() + 10000));
        assert(!(await transcription.attachTranscript(file)).transcript);
    });

    it('refuses sidecar symlinks without reading or changing their target', async function() {
        const file = await addFile();
        const external = path.join(os.tmpdir(), `ai-test-${Date.now()}.json`);
        try {
            await fs.writeJSON(external, {secret: 'untouched'});
            await fs.symlink(external, sidecar(file));
            await assert.rejects(transcription.run(), /1 file/);
            assert.deepStrictEqual(await fs.readJSON(external), {secret: 'untouched'});
            assert.strictEqual(calls.length, 0);
        } finally { await fs.remove(external); }
    });

    it('honors run limits and coalesces concurrent task invocations', async function() {
        await addFile('one');
        await addFile('two');
        await options({max_files: 1});
        const first = transcription.run();
        const second = transcription.run();
        assert.strictEqual(first, second);
        assert.strictEqual((await first).transcribed, 1);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual((await transcription.run()).transcribed, 1);
        assert.strictEqual(calls.length, 2);
    });

    it('aborts active inference when disabled and leaves no partial sidecar', async function() {
        const file = await addFile();
        handler = () => settings({enabled: false});
        await assert.rejects(transcription.run(), /settings changed/);
        assert(!await fs.pathExists(sidecar(file)));
        assert.strictEqual(calls.length, 1);
    });

    it('discards results if the library file is deleted during inference', async function() {
        const file = await addFile();
        handler = async (req, res) => {
            await db_api.removeRecord('files', {uid: file.uid});
            reply(res, 'Too late');
        };
        await assert.rejects(transcription.run(), /1 file/);
        assert(!await fs.pathExists(sidecar(file)));
    });
});
