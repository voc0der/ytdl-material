const {assert, fs, os, path, db_api, config_api, useTemporaryMediaRoots} = require('./test-shared');
const http = require('http');
const net = require('net');
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

        it('takes a Whisper server alone, or with an AI server, only on the local network', function() {
            ai.validateSettings({...ai.settings(), base_url: '', model: '', whisper_url: 'tcp://192.168.1.20:10300'});
            ai.validateSettings({...ai.settings(), whisper_url: 'homeassistant.local'});
            assert.throws(() => ai.validateSettings({...ai.settings(), base_url: '', whisper_url: ''}), /Enter the AI server URL/);
            for (const whisper_url of ['tcp://8.8.8.8:10300', 'tcp://[2001:4860:4860::8888]', 'http://192.168.1.20:10300', 'tcp://192.168.1.20/path', 'tcp://user:secret@192.168.1.20', 'x'.repeat(4097)]) {
                assert.throws(() => ai.validateSettings({...ai.settings(), whisper_url}), whisper_url.slice(0, 40));
            }
            assert.deepStrictEqual(ai.whisperAddress('192.168.1.20'), {host: '192.168.1.20', port: 10300, label: '192.168.1.20:10300'});
            assert.deepStrictEqual(ai.whisperAddress('tcp://[fd00::20]:10301/'), {host: 'fd00::20', port: 10301, label: '[fd00::20]:10301'});
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

    describe('one file on its own', function() {
        const until = async condition => { while (!condition()) await new Promise(resolve => setTimeout(resolve, 10)); };
        // Holds every model request until released.
        function hold() {
            let release;
            const held = new Promise(resolve => { release = resolve; });
            handler = async (req, res) => { await held; reply(res, 'Held.'); };
            return release;
        }

        it('writes it again whatever is saved, saying how far it has got and how it went', async function() {
            const file = await addFile('long', 61);
            const seen = [];
            handler = (req, res) => {
                seen.push(transcription.getStatus(file.uid));
                reply(res, `Part ${calls.length}`);
            };
            await (await transcription.transcribe(file)).finished;
            assert.deepStrictEqual(seen.map(({status, percent}) => [status, percent]), [['transcribing', 0], ['transcribing', 49], ['transcribing', 98]]);
            assert.deepStrictEqual(transcription.getStatus(file.uid), {status: 'complete', percent: 100, error: null});
            assert.strictEqual((await fs.readJSON(sidecar(file))).ytdl_material.transcript.text, 'Part 1\n\nPart 2\n\nPart 3');
            // Made the same way, so the task leaves it alone, but asking again is asking for it again.
            assert.strictEqual((await transcription.run()).skipped, 1);
            await (await transcription.transcribe(file)).finished;
            assert.strictEqual(calls.length, 6);
            assert.strictEqual((await fs.readJSON(sidecar(file))).ytdl_material.transcript.text, 'Part 4\n\nPart 5\n\nPart 6');
        });

        it('refuses, before anything is sent, while AI is off, while the file is being transcribed, and with settings that cannot work', async function() {
            const file = await addFile();
            const release = hold();
            const started = await transcription.transcribe(file);
            await assert.rejects(transcription.transcribe(file), /This file is already being transcribed/);
            // The task leaves it to that.
            assert.deepStrictEqual(await transcription.run(), {transcribed: 0, skipped: 1, failed: 0});
            release();
            await started.finished;
            assert.strictEqual(calls.length, 1);
            settings({model: ''});
            await assert.rejects(transcription.transcribe(file), /Choose a model/);
            assert.strictEqual(transcription.getStatus(file.uid), null);
            settings({model: 'local-model', enabled: false});
            await assert.rejects(transcription.transcribe(file), /AI integration is disabled/);
            assert.strictEqual(calls.length, 1);
        });

        it('transcribes only a few files on their own at once', async function() {
            const files = [];
            for (const name of ['one', 'two', 'three', 'four']) files.push(await addFile(name));
            const release = hold();
            const started = [];
            for (const file of files.slice(0, 3)) started.push(await transcription.transcribe(file));
            await assert.rejects(transcription.transcribe(files[3]), /Too many files are being transcribed at once/);
            release();
            await Promise.all(started.map(({finished}) => finished));
            await (await transcription.transcribe(files[3])).finished;
            assert.strictEqual(transcription.getStatus(files[3].uid).status, 'complete');
        });

        it('says why a file has nothing to send', async function() {
            const silent = await addVideo('silent', {sound: false});
            await (await transcription.transcribe(silent)).finished;
            assert.deepStrictEqual(transcription.getStatus(silent.uid), {status: 'failed', percent: 0,
                error: 'This file has no sound. To describe what it shows instead, turn on Vision in Settings → Advanced and choose Visual cues in Auto-transcribe\'s options.'});
            settings({audio: false, vision: true});
            await options({vision_style: 'brief'});
            const audio = await addFile();
            await (await transcription.transcribe(audio)).finished;
            assert.match(transcription.getStatus(audio.uid).error, /^Nothing can hear this file's sound, and it has no picture to describe\./);
            assert.strictEqual(calls.length, 0);
        });

        it('stops when AI settings change, keeping no transcript', async function() {
            const file = await addFile();
            handler = () => settings({model: 'another-model'});
            await (await transcription.transcribe(file)).finished;
            assert.deepStrictEqual(transcription.getStatus(file.uid), {status: 'failed', percent: 0, error: 'Transcription stopped because AI settings changed.'});
            assert(!await fs.pathExists(sidecar(file)));
        });

        it('says a file the task is on is being transcribed, and does not start it again', async function() {
            const file = await addFile();
            const release = hold();
            const run = transcription.run();
            await until(() => calls.length === 1);
            assert.deepStrictEqual(transcription.getStatus(file.uid), {status: 'transcribing', percent: 0, error: null});
            await assert.rejects(transcription.transcribe(file), /This file is already being transcribed/);
            release();
            assert.strictEqual((await run).transcribed, 1);
            // The task keeps no word of how each file went.
            assert.strictEqual(transcription.getStatus(file.uid), null);
        });
    });

    describe('with a Whisper server', function() {
        let whisper, sockets, connections, answer;
        // Frames an event the way the Python wyoming library does, with its data in a block
        // of its own after the header line.
        const frame = (type, data) => {
            const body = Buffer.from(JSON.stringify(data));
            return Buffer.concat([Buffer.from(`${JSON.stringify({type, version: '1.11.0', data_length: body.length})}\n`), body]);
        };
        const info = (model = 'tiny-int8') => ({asr: [{name: 'faster-whisper', installed: true, models: [{name: model, installed: true, languages: ['en']}]}]});
        const answerWith = (text, model) => (event, socket) => {
            if (event.type === 'describe') socket.write(frame('info', info(model)));
            if (event.type === 'audio-stop') socket.end(frame('transcript', {text}));
        };

        beforeEach(async function() {
            sockets = new Set();
            // The events each connection sent, in order.
            connections = [];
            answer = answerWith(' Words Whisper heard. ');
            whisper = net.createServer(socket => {
                const events = [];
                let buffer = Buffer.alloc(0);
                sockets.add(socket);
                connections.push(events);
                socket.on('error', () => {});
                socket.on('close', () => sockets.delete(socket));
                socket.on('data', chunk => {
                    buffer = Buffer.concat([buffer, chunk]);
                    for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
                        const header = JSON.parse(buffer.subarray(0, end));
                        const data_end = end + 1 + (header.data_length ?? 0);
                        const payload_end = data_end + (header.payload_length ?? 0);
                        if (buffer.length < payload_end) return;
                        const extra = header.data_length ? JSON.parse(buffer.subarray(end + 1, data_end)) : {};
                        const event = {type: header.type, data: {...header.data, ...extra}, payload: buffer.subarray(data_end, payload_end)};
                        buffer = buffer.subarray(payload_end);
                        events.push(event);
                        answer(event, socket);
                    }
                });
            });
            await new Promise(resolve => whisper.listen(0, '127.0.0.1', resolve));
            settings({whisper_url: `tcp://127.0.0.1:${whisper.address().port}`});
        });

        afterEach(async function() {
            for (const socket of sockets) socket.destroy();
            await new Promise(resolve => whisper.close(resolve));
        });

        async function addSilence(name = 'quiet') {
            const file = {uid: name, id: name, title: 'Silence', isAudio: true, url: '', path: path.join(media.audio, `${name}.wav`)};
            execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', file.path]);
            await db_api.insertRecordIntoTable('files', {...file});
            return file;
        }

        it('says what the Whisper server runs, and refuses one that does no speech-to-text', async function() {
            assert.deepStrictEqual(await ai.describeWhisper(ai.settings()), {name: 'faster-whisper tiny-int8'});
            assert.deepStrictEqual(connections[0].map(event => event.type), ['describe']);
            answer = (event, socket) => socket.write(frame('info', {asr: [{name: 'vosk', installed: true, models: [{name: 'vosk-model-small-en-us', installed: true}]}]}));
            assert.deepStrictEqual(await ai.describeWhisper(ai.settings()), {name: 'vosk-model-small-en-us'});
            answer = (event, socket) => socket.write(frame('info', {asr: [], tts: [{name: 'piper', installed: true, voices: []}]}));
            await assert.rejects(ai.describeWhisper(ai.settings()),
                /The Wyoming server at 127\.0\.0\.1:\d+ does no speech-to-text; it runs piper\. Home Assistant's Whisper is usually on port 10300\./);
        });

        it('writes Exact transcripts with Whisper alone, with no model or AI server', async function() {
            settings({base_url: '', model: '', audio: false});
            const file = await addFile();
            assert.deepStrictEqual(await transcription.run(), {transcribed: 1, skipped: 0, failed: 0});
            assert.strictEqual(calls.length, 0);
            const [describe, request] = connections;
            assert.deepStrictEqual(describe.map(event => event.type), ['describe']);
            assert.deepStrictEqual(request.map(event => event.type), ['transcribe', 'audio-start', 'audio-chunk', 'audio-stop']);
            assert.deepStrictEqual(request[0].data, {});
            assert.deepStrictEqual(request[1].data, {rate: 16000, width: 2, channels: 1, timestamp: 0});
            // A second of 16 kHz 16-bit PCM, without a WAV header.
            assert.strictEqual(request[2].payload.length, 32000);
            assert.notStrictEqual(request[2].payload.subarray(0, 4).toString('latin1'), 'RIFF');
            assert.deepStrictEqual(request[3].data, {timestamp: 1000});
            const transcript = (await fs.readJSON(sidecar(file))).ytdl_material.transcript;
            assert.strictEqual(transcript.text, 'Words Whisper heard.');
            assert.deepStrictEqual([transcript.model, transcript.whisper_model, transcript.audio_style, transcript.vision_style],
                [null, 'faster-whisper tiny-int8', 'exact', 'off']);
            assert.deepStrictEqual(await transcription.run(), {transcribed: 0, skipped: 1, failed: 0});
            const attached = (await transcription.attachTranscript(file)).transcript;
            assert.deepStrictEqual([attached.text, attached.model, attached.whisper_model], ['Words Whisper heard.', null, 'faster-whisper tiny-int8']);
        });

        it('writes one file on its own with Whisper, asking what it runs first', async function() {
            settings({base_url: '', model: '', audio: false});
            const file = await addFile();
            answer = answerWith('Words heard on request.');
            await (await transcription.transcribe(file)).finished;
            assert.deepStrictEqual(connections.map(events => events[0].type), ['describe', 'transcribe']);
            const transcript = (await fs.readJSON(sidecar(file))).ytdl_material.transcript;
            assert.deepStrictEqual([transcript.text, transcript.model, transcript.whisper_model], ['Words heard on request.', null, 'faster-whisper tiny-int8']);
        });

        it('has the model write up Whisper\'s words in other styles, hearing the sound itself only for Descriptive', async function() {
            const file = await addFile();
            await options({audio_style: 'brief'});
            await transcription.run();
            assert.deepStrictEqual(partsOf(calls[0], 'input_audio'), []);
            assert.match(promptOf(calls[0]), /Speech recognition wrote down what is said in this stretch: "Words Whisper heard\."/);
            assert.match(promptOf(calls[0]), /Sum up what is said in one or two sentences/);
            const transcript = (await fs.readJSON(sidecar(file))).ytdl_material.transcript;
            assert.deepStrictEqual([transcript.text, transcript.model, transcript.whisper_model], ['A local transcript.', 'local-model', 'faster-whisper tiny-int8']);

            await options({audio_style: 'descriptive'});
            assert.strictEqual((await transcription.run()).transcribed, 1);
            const sound = Buffer.from(partsOf(calls[1], 'input_audio')[0].input_audio.data, 'base64');
            assert.deepStrictEqual([sound.subarray(0, 4).toString(), sound.subarray(8, 16).toString(), sound.readUInt32LE(24), sound.readUInt32LE(40)],
                ['RIFF', 'WAVEfmt ', 16000, sound.length - 44]);
            assert.match(promptOf(calls[1]), /describe other sounds in the audio that matter/);
        });

        it('has the model add what the frames show to Whisper\'s words for Exact', async function() {
            settings({vision: true});
            await options({vision_style: 'detailed'});
            const file = await addVideo();
            await transcription.run();
            const [call] = calls;
            assert.deepStrictEqual(partsOf(call, 'input_audio'), []);
            assert.strictEqual(partsOf(call, 'image_url').length, 1);
            assert.match(promptOf(call), /"Words Whisper heard\."\nWrite out what is said exactly as speech recognition wrote it down\./);
            assert.match(promptOf(call), /changes of scene/);
            const transcript = (await fs.readJSON(sidecar(file))).ytdl_material.transcript;
            assert.deepStrictEqual([transcript.model, transcript.whisper_model, transcript.audio_style, transcript.vision_style],
                ['local-model', 'faster-whisper tiny-int8', 'exact', 'detailed']);
        });

        it('does not send Whisper a silent stretch, nor the model one with nothing to write up', async function() {
            const file = await addSilence();
            assert.strictEqual((await transcription.run()).transcribed, 1);
            await options({audio_style: 'novel'});
            assert.strictEqual((await transcription.run()).transcribed, 1);
            assert.deepStrictEqual(connections.map(events => events[0].type), ['describe', 'describe']);
            assert.strictEqual(calls.length, 0);
            assert.strictEqual((await fs.readJSON(sidecar(file))).ytdl_material.transcript.text, '');
        });

        it('refuses Descriptive without a model that can hear, and other styles without a model, before asking anything', async function() {
            await addFile();
            settings({audio: false});
            await options({audio_style: 'descriptive'});
            await assert.rejects(transcription.run(), /Descriptive also describes sounds that are not words/);
            settings({model: ''});
            await options({audio_style: 'brief'});
            await assert.rejects(transcription.run(), /or choose Exact in Auto-transcribe's options/);
            settings({vision: true});
            await options({audio_style: 'exact', vision_style: 'brief'});
            await assert.rejects(transcription.run(), /Choose a model/);
            assert.strictEqual(calls.length, 0);
            assert.strictEqual(connections.length, 0);
        });

        it('fails the run, saying why, when the Whisper server cannot be reached or is not one', async function() {
            await addFile();
            const closed = net.createServer();
            await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
            const port = closed.address().port;
            await new Promise(resolve => closed.close(resolve));
            settings({whisper_url: `tcp://127.0.0.1:${port}`});
            await assert.rejects(transcription.run(), /Nothing is listening at 127\.0\.0\.1:\d+\. .*Whisper add-on needs a port set under Network/);
            settings({whisper_url: base.replace('http://', 'tcp://')});
            await assert.rejects(transcription.run(), /127\.0\.0\.1:\d+ did not answer in the Wyoming protocol\. Use the address of a Wyoming server/);
            settings({whisper_url: `tcp://127.0.0.1:${whisper.address().port}`});
            answer = (event, socket) => socket.end();
            await assert.rejects(transcription.run(), /closed the connection without answering/);
            assert(!(await db_api.getRecords('files')).some(file => file.transcription_failed_at));
        });

        it('fails a file whose audio the Whisper server refuses, keeping no transcript', async function() {
            const file = await addFile();
            answer = (event, socket) => {
                if (event.type === 'describe') socket.write(frame('info', info()));
                if (event.type === 'audio-stop') socket.write(frame('error', {text: 'Model failed to load'}));
            };
            await assert.rejects(transcription.run(), /1 file/);
            assert(!await fs.pathExists(sidecar(file)));
            assert((await db_api.getRecord('files', {uid: file.uid})).transcription_failed_at);
            await assert.rejects(ai.transcribeSpeech(ai.settings(), Buffer.alloc(3200)),
                /The Whisper server at 127\.0\.0\.1:\d+ answered with an error: Model failed to load/);
        });

        it('writes it up again when the Whisper server runs another model', async function() {
            await addFile();
            await transcription.run();
            answer = answerWith('Better words.', 'small-int8');
            assert.strictEqual((await transcription.run()).transcribed, 1);
            assert.strictEqual((await transcription.run()).skipped, 1);
        });

        it('stops listening when AI settings change, keeping no transcript', async function() {
            const file = await addFile();
            answer = (event, socket) => {
                if (event.type === 'describe') socket.write(frame('info', info()));
                if (event.type === 'audio-stop') settings({enabled: false});
            };
            await assert.rejects(transcription.run(), /settings changed/);
            assert(!await fs.pathExists(sidecar(file)));
        });

        it('keeps the Whisper server to the local network, whatever its name resolves to', async function() {
            for (const whisper_url of ['tcp://8.8.8.8:10300', 'http://127.0.0.1:10300', 'tcp://127.0.0.1/path']) {
                settings({whisper_url});
                await assert.rejects(ai.describeWhisper(ai.settings()));
            }
            dns.lookup = (host, options, callback) => callback(null, [{address: '8.8.8.8', family: 4}]);
            settings({whisper_url: 'tcp://whisper.example:10300'});
            await assert.rejects(ai.describeWhisper(ai.settings()), /whisper\.example resolves to an address outside the local network/);
            assert.strictEqual(connections.length, 0);
            dns.lookup = (host, options, callback) => callback(null, [{address: '127.0.0.1', family: 4}]);
            settings({whisper_url: `tcp://whisper.internal:${whisper.address().port}`});
            assert.deepStrictEqual(await ai.describeWhisper(ai.settings()), {name: 'faster-whisper tiny-int8'});
        });
    });
});
