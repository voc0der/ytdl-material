// The Wyoming protocol, which Home Assistant's voice services speak over plain TCP, Whisper
// among them. Each event is one line of JSON naming its type, followed by as many bytes of
// extra JSON data and of binary payload, such as audio, as that line announces. This module
// only speaks the protocol: which servers it may reach is decided by whoever calls it.
const net = require('net');

// A header line, and the data and payload after it, are refused past these. A description
// lists every language a model knows, which comes to a few kilobytes; a transcript of half a
// minute is smaller still.
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;

const protocolError = message => Object.assign(new Error(message), {code: 'EPROTOCOL'});
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isLength = value => value === undefined || (Number.isSafeInteger(value) && value >= 0 && value <= MAX_EVENT_BYTES);

/** An event as it goes over the wire: its data in the header line, then its payload. */
function encode({type, data, payload}) {
    const header = {type};
    if (data) header.data = data;
    if (payload?.length) header.payload_length = payload.length;
    const line = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8');
    return payload?.length ? Buffer.concat([line, payload]) : line;
}
exports.encode = encode;

/**
 * Takes events out of what a connection receives, however it arrives split up. Extra data is
 * merged over the data in the header line, as the protocol has it.
 */
class EventReader {
    constructor() {
        this.buffer = Buffer.alloc(0);
        this.header = null;
    }

    push(chunk) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    }

    /** The next whole event, or null until more has arrived. */
    next() {
        if (!this.header) {
            const end = this.buffer.indexOf(0x0a);
            if (end < 0) {
                if (this.buffer.length > MAX_HEADER_BYTES) throw protocolError('The header line is too long.');
                return null;
            }
            let header;
            try { header = JSON.parse(this.buffer.subarray(0, end).toString('utf8')); } catch { header = null; }
            if (!isObject(header) || typeof header.type !== 'string') throw protocolError('A header line is not a Wyoming event.');
            if (!isLength(header.data_length) || !isLength(header.payload_length)
                || (header.data_length ?? 0) + (header.payload_length ?? 0) > MAX_EVENT_BYTES) {
                throw protocolError('An event is too large.');
            }
            this.buffer = this.buffer.subarray(end + 1);
            this.header = header;
        }
        const data_length = this.header.data_length ?? 0;
        const payload_length = this.header.payload_length ?? 0;
        if (this.buffer.length < data_length + payload_length) return null;
        let data = isObject(this.header.data) ? this.header.data : {};
        if (data_length) {
            let extra;
            try { extra = JSON.parse(this.buffer.subarray(0, data_length).toString('utf8')); } catch { extra = null; }
            if (!isObject(extra)) throw protocolError('The data of an event is not a JSON object.');
            data = {...data, ...extra};
        }
        const event = {type: this.header.type, data, payload: this.buffer.subarray(data_length, data_length + payload_length)};
        this.buffer = this.buffer.subarray(data_length + payload_length);
        this.header = null;
        return event;
    }
}
exports.EventReader = EventReader;

/**
 * Sends events to a server over a connection of their own, and resolves the first event it
 * answers with of the type wanted, after which the connection is closed. Speech-to-text
 * servers close it themselves once they have answered, so a connection is not reused.
 *
 * Rejects with the server's own error event (code EWYOMING), a reply that is not the protocol
 * (EPROTOCOL), the connection closing first (ECLOSED), no answer within the timeout
 * (ETIMEDOUT), or the socket's own error. `lookup` resolves the host, as for net.connect.
 */
exports.exchange = ({host, port, lookup}, events, wanted, {signal, timeout = 15000} = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const reader = new EventReader();
    const socket = net.connect({host, port, lookup});
    let settled = false;
    const finish = (error, event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        socket.destroy();
        if (error) reject(error);
        else resolve(event);
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(Object.assign(new Error('No answer in time.'), {code: 'ETIMEDOUT'})), timeout);
    signal?.addEventListener('abort', abort, {once: true});

    socket.once('connect', () => socket.write(Buffer.concat(events.map(encode))));
    socket.on('data', chunk => {
        try {
            reader.push(chunk);
            for (let event = reader.next(); event; event = reader.next()) {
                if (event.type === 'error') {
                    const text = typeof event.data.text === 'string' && event.data.text.trim() ? event.data.text.trim() : 'an unspecified error';
                    return finish(Object.assign(new Error(text), {code: 'EWYOMING'}));
                }
                if (event.type === wanted) return finish(null, event);
            }
        } catch (error) {
            finish(error);
        }
    });
    // On rather than once: a second error after the first would otherwise go unhandled.
    socket.on('error', error => finish(error));
    socket.once('close', () => finish(Object.assign(new Error('The connection closed.'), {code: 'ECLOSED'})));
});
