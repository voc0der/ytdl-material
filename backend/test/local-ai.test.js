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

    beforeEach(async function() {
        original = ai.settings();
        calls = [];
        lookup = dns.lookup;
        handler = (req, res) => res.end(JSON.stringify({text: 'A local transcript.'}));
        server = http.createServer(async (req, res) => {
            const buffers = [];
            for await (const chunk of req) buffers.push(chunk);
            calls.push({url: req.url, headers: req.headers, body: Buffer.concat(buffers)});
            res.setHeader('Content-Type', 'application/json');
            handler(req, res);
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        base = `http://127.0.0.1:${server.address().port}`;
        media = useTemporaryMediaRoots();
        settings({enabled: true, provider: 'ollama', base_url: base,
            model: 'local-model', api_key: 'local-secret',
            transcription_provider: 'whispercpp', transcription_url: base,
            transcription_model: '', transcription_api_key: '', language: ''});
        await db_api.removeAllRecords('files');
        await db_api.removeAllRecords('tasks');
        await db_api.insertRecordIntoTable('tasks', {key: 'auto_transcribe', options: {max_files: 10}});
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
    const sidecar = file => `${file.path.slice(0, -4)}.info.json`;

    it('does no network or media work while disabled, even for a scheduled run', async function() {
        settings({enabled: false});
        await transcription.run();
        await assert.rejects(ai.testConnection(), /disabled/);
        assert.strictEqual(calls.length, 0);
    });

    it('tests only the selected Ollama model and refuses cloud-backed models', async function() {
        handler = (req, res) => res.end(JSON.stringify({details: {format: 'gguf'}}));
        assert.deepStrictEqual(await ai.testConnection(), {success: true});
        assert.strictEqual(calls[0].url, '/api/show');
        assert.deepStrictEqual(JSON.parse(calls[0].body), {model: 'local-model'});
        assert.strictEqual(calls[0].headers.authorization, 'Bearer local-secret');
        handler = (req, res) => res.end(JSON.stringify({details: {}, remote_host: 'https://example.org'}));
        await assert.rejects(ai.testConnection(), /Cloud models/);
    });

    it('checks the configured llama.cpp model without running inference', async function() {
        settings({provider: 'llamacpp', model: 'speech'});
        handler = (req, res) => res.end(JSON.stringify({data: [{id: 'speech'}]}));
        assert.deepStrictEqual(await ai.testConnection(), {success: true});
        assert.strictEqual(calls[0].url, '/v1/models');
        settings({model: 'missing'});
        await assert.rejects(ai.testConnection(), /not available/);
    });

    it('blocks public IPs, redirects, credentials in URLs, and public DNS answers', async function() {
        for (const base_url of ['http://8.8.8.8', 'http://[2001:4860:4860::8888]', 'http://user:secret@localhost', 'file:///tmp/model']) {
            assert.throws(() => ai.validateSettings({...ai.settings(), base_url}));
        }
        handler = (req, res) => { res.statusCode = 302; res.setHeader('Location', base + '/redirected'); res.end('{}'); };
        await assert.rejects(ai.testConnection(), /HTTP 302/);
        assert.strictEqual(calls.length, 1);
        dns.lookup = (host, options, callback) => callback(null, [{address: '8.8.8.8', family: 4}]);
        settings({base_url: 'http://local.example:1234'});
        await assert.rejects(ai.testConnection(), /Could not reach/);
        assert.strictEqual(calls.length, 1);
    });

    it('allows a private DNS name and never exposes provider errors or API keys', async function() {
        dns.lookup = (host, options, callback) => callback(null, [{address: '127.0.0.1', family: 4}]);
        settings({base_url: base.replace('127.0.0.1', 'speech.internal')});
        handler = (req, res) => { res.statusCode = 401; res.end(JSON.stringify({error: 'local-secret'})); };
        await assert.rejects(ai.testConnection(), error => /HTTP 401/.test(error.message) && !error.message.includes('local-secret'));
        assert.strictEqual(calls.length, 1);
    });

    it('redacts both credentials and preserves them when saving a redacted config', function() {
        settings({transcription_api_key: 'speech-secret'});
        const redacted = config_api.getRedactedConfigFile();
        assert(!JSON.stringify(redacted).includes('local-secret'));
        assert(!JSON.stringify(redacted).includes('speech-secret'));
        assert(config_api.setConfigFile(redacted));
        assert.strictEqual(ai.settings().api_key, 'local-secret');
        assert.strictEqual(ai.settings().transcription_api_key, 'speech-secret');
    });

    it('extracts audio, merges a transcript into existing metadata, and skips it next time', async function() {
        const file = await addFile();
        await fs.writeJSON(sidecar(file), {id: 'source-id', chapters: [{title: 'Original'}], ytdl_material: {custom: 'keep'}});
        const first = await transcription.run();
        assert.deepStrictEqual(first, {transcribed: 1, skipped: 0, failed: 0});
        const saved = await fs.readJSON(sidecar(file));
        assert.strictEqual(saved.id, 'source-id');
        assert.deepStrictEqual(saved.chapters, [{title: 'Original'}]);
        assert.strictEqual(saved.ytdl_material.custom, 'keep');
        assert.strictEqual(saved.ytdl_material.transcript.text, 'A local transcript.');
        assert.strictEqual(calls[0].url, '/inference');
        assert(calls[0].body.includes(Buffer.from('RIFF')));
        assert(calls[0].body.includes(Buffer.from('name="response_format"')));
        assert.deepStrictEqual(await transcription.run(), {transcribed: 0, skipped: 1, failed: 0});
        assert.strictEqual(calls.length, 1);
        settings({enabled: false});
        assert.strictEqual((await transcription.attachTranscript(file)).transcript.text, 'A local transcript.');
    });

    it('transcribes the audio track of a video file', async function() {
        const file = {uid: 'video', id: 'video', title: 'Video', isAudio: false, url: '', path: path.join(media.video, 'video.mp4')};
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:size=64x64:rate=10:duration=1',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', file.path]);
        await db_api.insertRecordIntoTable('files', {...file});
        assert.strictEqual((await transcription.run()).transcribed, 1);
        assert.strictEqual((await transcription.attachTranscript(file)).transcript.text, 'A local transcript.');
    });

    it('allows speech-only setup without requiring an unrelated text model', async function() {
        settings({model: ''});
        await addFile();
        assert.strictEqual((await transcription.run()).transcribed, 1);
        await assert.rejects(ai.testConnection(), /model name/);
    });

    it('leaves no transcript when a later chunk fails', async function() {
        const file = await addFile('partial', 301);
        await fs.writeJSON(sidecar(file), {id: 'original'});
        handler = (req, res) => {
            if (calls.length > 1) res.statusCode = 503;
            res.end(JSON.stringify({text: 'Only the first part'}));
        };
        await assert.rejects(transcription.run(), /1 file/);
        assert.deepStrictEqual(await fs.readJSON(sidecar(file)), {id: 'original'});
        assert.strictEqual(calls.length, 2);
    });

    it('lets later files progress when an earlier file repeatedly fails', async function() {
        const first = await addFile('bad');
        await addFile('good');
        await fs.writeFile(sidecar(first), 'broken');
        await db_api.updateRecord('tasks', {key: 'auto_transcribe'}, {options: {max_files: 1}});
        await assert.rejects(transcription.run(), /1 file/);
        assert.strictEqual((await transcription.run()).transcribed, 1);
        assert.strictEqual(calls.length, 1);
    });

    it('uses the llama.cpp transcription route and forwards model and language', async function() {
        settings({transcription_provider: 'llamacpp', transcription_model: 'speech-model', language: 'en'});
        await addFile();
        await transcription.run();
        assert.strictEqual(calls[0].url, '/v1/audio/transcriptions');
        assert(calls[0].body.includes(Buffer.from('speech-model')));
        assert(calls[0].body.includes(Buffer.from('name="language"')));
    });

    it('chunks long media and saves ordered offsets only after every chunk succeeds', async function() {
        const file = await addFile('long', 301);
        handler = (req, res) => res.end(JSON.stringify({text: `Part ${calls.length}`}));
        await transcription.run();
        const transcript = (await fs.readJSON(sidecar(file))).ytdl_material.transcript;
        assert.strictEqual(transcript.text, 'Part 1\nPart 2');
        assert.deepStrictEqual(transcript.segments.map(({start, end}) => [start, end]), [[0, 300], [300, 301]]);
        assert(calls.every(call => call.body.length < 10 * 1024 * 1024));
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

    it('rejects invalid speech responses without creating a sidecar', async function() {
        const file = await addFile();
        handler = (req, res) => res.end(JSON.stringify({text: {invented: true}}));
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
        await db_api.updateRecord('tasks', {key: 'auto_transcribe'}, {options: {max_files: 1}});
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
            res.end(JSON.stringify({text: 'Too late'}));
        };
        await assert.rejects(transcription.run(), /1 file/);
        assert(!await fs.pathExists(sidecar(file)));
    });
});
