const assert = require('assert');
const net = require('net');
const wyoming = require('../wyoming');

// Frames an event the way the Python wyoming library writes one: the data in a block of its
// own after the header line, announced by data_length, so the reader is not only tested
// against the module's own encoder.
function pythonFrame(type, data, payload) {
    const body = data ? Buffer.from(JSON.stringify(data)) : null;
    const header = {type, version: '1.8.0', ...(body && {data_length: body.length}), ...(payload && {payload_length: payload.length})};
    return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), ...(body ? [body] : []), ...(payload ? [payload] : [])]);
}

describe('Wyoming protocol', function() {
    describe('reading events', function() {
        const readAll = (...chunks) => {
            const reader = new wyoming.EventReader();
            const events = [];
            for (const chunk of chunks) {
                reader.push(chunk);
                for (let event = reader.next(); event; event = reader.next()) events.push(event);
            }
            return events;
        };

        it('reads data after the header line, merged over data in it, and a payload, however the bytes are split', function() {
            const bytes = Buffer.concat([
                pythonFrame('info', {asr: [{name: 'faster-whisper'}]}),
                Buffer.from('{"type":"transcript","data":{"text":"inline","language":"en"},"data_length":17}\n{"text":"merged"}'),
                pythonFrame('audio-chunk', {rate: 16000}, Buffer.from([1, 2, 3, 4]))
            ]);
            const split = [...bytes].map(byte => Buffer.from([byte]));
            for (const chunks of [[bytes], split]) {
                const events = readAll(...chunks);
                assert.deepStrictEqual(events.map(event => event.type), ['info', 'transcript', 'audio-chunk']);
                assert.deepStrictEqual(events[0].data, {asr: [{name: 'faster-whisper'}]});
                assert.deepStrictEqual(events[1].data, {text: 'merged', language: 'en'});
                assert.deepStrictEqual([...events[2].payload], [1, 2, 3, 4]);
            }
        });

        it('refuses what is not the protocol, and events too large to be a transcript or description', function() {
            for (const bytes of ['HTTP/1.1 400 Bad Request\r\n', '["not", "an", "event"]\n', '{"data":{}}\n',
                '{"type":"info","data_length":-1}\n', `{"type":"info","payload_length":${8 * 1024 * 1024}}\n`,
                '{"type":"info","data_length":4}\n[12]', 'x'.repeat(70 * 1024)]) {
                assert.throws(() => readAll(Buffer.from(bytes)), error => error.code === 'EPROTOCOL', bytes.slice(0, 40));
            }
        });

        it('sends data in the header line, which every version of the library reads', function() {
            const encoded = wyoming.encode({type: 'audio-chunk', data: {rate: 16000, width: 2, channels: 1}, payload: Buffer.from([7, 8])});
            const end = encoded.indexOf(0x0a);
            assert.deepStrictEqual(JSON.parse(encoded.subarray(0, end)), {type: 'audio-chunk', data: {rate: 16000, width: 2, channels: 1}, payload_length: 2});
            assert.deepStrictEqual([...encoded.subarray(end + 1)], [7, 8]);
            assert.strictEqual(wyoming.encode({type: 'describe'}).toString(), '{"type":"describe"}\n');
        });
    });

    describe('exchanging events with a server', function() {
        let server, port, respond;

        beforeEach(async function() {
            respond = () => {};
            server = net.createServer(socket => {
                socket.on('error', () => {});
                socket.on('data', () => respond(socket));
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            port = server.address().port;
        });

        afterEach(async function() {
            await new Promise(resolve => server.close(resolve));
        });

        const address = () => ({host: '127.0.0.1', port});

        it('resolves the event wanted, passing over the ones before it', async function() {
            respond = socket => socket.write(Buffer.concat([pythonFrame('transcript-start'), pythonFrame('transcript-chunk', {text: 'Wor'}),
                pythonFrame('transcript', {text: 'Words.'}), pythonFrame('transcript-stop')]));
            const event = await wyoming.exchange(address(), [{type: 'audio-stop'}], 'transcript');
            assert.deepStrictEqual(event.data, {text: 'Words.'});
        });

        it('rejects with the server\'s error, a closed connection, a timeout and an abort', async function() {
            respond = socket => socket.write(pythonFrame('error', {text: 'Model failed to load', code: 'model'}));
            await assert.rejects(wyoming.exchange(address(), [{type: 'describe'}], 'info'), {code: 'EWYOMING', message: 'Model failed to load'});
            respond = socket => socket.end();
            await assert.rejects(wyoming.exchange(address(), [{type: 'describe'}], 'info'), {code: 'ECLOSED'});
            respond = () => {};
            await assert.rejects(wyoming.exchange(address(), [{type: 'describe'}], 'info', {timeout: 50}), {code: 'ETIMEDOUT'});
            const controller = new AbortController();
            const pending = wyoming.exchange(address(), [{type: 'describe'}], 'info', {signal: controller.signal});
            controller.abort(new Error('settings changed'));
            await assert.rejects(pending, /settings changed/);
        });
    });
});
