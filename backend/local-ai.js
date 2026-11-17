// A local AI server, spoken to through the OpenAI-compatible API that llama.cpp, llama-swap,
// Ollama, LM Studio and the like all serve: /models lists what it runs, /chat/completions
// takes text with audio and images. A Whisper server, when one is set, is spoken to through
// the Wyoming protocol, as Home Assistant speaks to its own. Media never leaves the local
// network: both servers have to be on a loopback or private address.
const axios = require('axios');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const config = require('./config');
const logger = require('./logger');
const wyoming = require('./wyoming');
const {parseAddressList, addressInList} = require('./ip-ranges');

const LOCAL_ADDRESSES = parseAddressList('127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,::1,fc00::/7');
const CONFIG_KEYS = ['enabled', 'base_url', 'model', 'api_key', 'vision', 'audio', 'whisper_url'];
// The port Home Assistant's Whisper add-on and the Wyoming Whisper servers listen on.
const WHISPER_PORT = 10300;
// Ollama names models it runs in its cloud like this. They would send media off the network.
const CLOUD_MODEL = /(?:^|[-:])cloud(?:$|[-:])/i;

exports.isEnabled = () => config.getConfigItem('ytdl_ai_enabled') === true;
exports.settings = () => Object.fromEntries(CONFIG_KEYS.map(key => [key, config.getConfigItem(`ytdl_ai_${key}`)]));

/**
 * Where the API lives for the URL someone entered. Both http://host:8080 and
 * http://host:8080/v1 work: /v1 is added when the URL does not end with it.
 */
function apiRoot(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter the AI server URL, such as http://192.168.1.10:8080.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('AI server URLs must use HTTP or HTTPS, without credentials, a query, or a fragment.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !addressInList(LOCAL_ADDRESSES, host)) {
        throw new Error('AI servers must use a loopback or private network address.');
    }
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${/\/v1$/i.test(pathname) ? pathname : `${pathname}/v1`}`;
}
exports.apiRoot = apiRoot;

exports.isCloudModel = (model) => CLOUD_MODEL.test(model);

/**
 * Where the Whisper server is, from tcp://host:port, host:port or a bare host, which gets the
 * Whisper port. Wyoming is plain TCP, so there is no path, query or credentials to give.
 */
function whisperAddress(value) {
    const text = String(value || '').trim();
    let url;
    try { url = new URL(text.includes('://') ? text : `tcp://${text}`); } catch { url = null; }
    if (!url?.hostname) throw new Error('Enter the Whisper server\'s address, such as tcp://192.168.1.20:10300.');
    if (url.protocol !== 'tcp:' || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) {
        throw new Error('Whisper servers are reached over the Wyoming protocol: enter tcp:// and the host and port, such as tcp://192.168.1.20:10300.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !addressInList(LOCAL_ADDRESSES, host)) {
        throw new Error('Whisper servers must use a loopback or private network address.');
    }
    const port = Number(url.port) || WHISPER_PORT;
    return {host, port, label: `${url.hostname}:${port}`};
}
exports.whisperAddress = whisperAddress;

/**
 * The address and key of a server, checked on their own: they are saved before anything is
 * asked of the server, which is only ever asked for what is saved.
 */
exports.validateServer = ({base_url, api_key} = {}) => {
    for (const value of [base_url, api_key]) {
        if (typeof value !== 'string' || value.length > 4096) throw new Error('AI settings must be text values of at most 4096 characters.');
    }
    apiRoot(base_url);
};

exports.validateSettings = (settings) => {
    if (!settings || settings.enabled === false || settings.enabled === undefined) return;
    if (settings.enabled !== true) throw new Error('AI enabled must be true or false.');
    for (const key of ['base_url', 'model', 'api_key']) {
        if (typeof settings[key] !== 'string' || settings[key].length > 4096) throw new Error('AI settings must be text values of at most 4096 characters.');
    }
    for (const key of ['vision', 'audio']) {
        if (settings[key] !== undefined && typeof settings[key] !== 'boolean') throw new Error('Vision and Audio must be true or false.');
    }
    const whisper_url = settings.whisper_url ?? '';
    if (typeof whisper_url !== 'string' || whisper_url.length > 4096) throw new Error('AI settings must be text values of at most 4096 characters.');
    // A Whisper server can be all there is, writing Exact transcripts on its own.
    if (settings.base_url.trim() || !whisper_url.trim()) apiRoot(settings.base_url);
    if (whisper_url.trim()) whisperAddress(whisper_url);
    if (exports.isCloudModel(settings.model)) throw new Error('Choose a model that runs on your server. Cloud models are not supported.');
};

// Resolve at connection time and give the socket only checked addresses. Redirects and
// environment proxies are disabled too, so a private hostname cannot route media to a
// public service. Docker service names and private DNS work without a hostname allowlist.
function localLookup(hostname, options, callback) {
    dns.lookup(hostname, {all: true}, (error, addresses) => {
        if (error) return callback(error);
        if (!addresses.length || addresses.some(entry => !addressInList(LOCAL_ADDRESSES, entry.address))) {
            const outside = new Error(`${hostname} resolves to an address outside the local network. AI servers must be on a loopback or private network address.`);
            outside.code = 'EOUTSIDE';
            return callback(outside);
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
    });
}

// What the server said went wrong, when it said it in a way worth passing on.
function serverReason(data) {
    let reason = null;
    if (typeof data === 'string') reason = data.trim().startsWith('<') ? null : data;
    else if (data && typeof data === 'object') {
        const error = data.error;
        reason = (error && typeof error === 'object' ? error.message : error) || data.message || data.detail || null;
    }
    if (typeof reason !== 'string' || !reason.trim()) return null;
    const trimmed = reason.trim().replace(/\s+/g, ' ');
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

// Why a connection to a server failed, by its error code, or null for a code with nothing
// better to say about it than its own message.
function describeConnectionFailure(error, host, hostname, server) {
    const code = error.code || error.cause?.code;
    if (code === 'EOUTSIDE') return error.message;
    if (code === 'ECONNREFUSED') return `Nothing is listening at ${host}. Check the address and port, and that the server is running.`;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${hostname} could not be found. Check the address; in Docker, localhost is the app's own container.`;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return `The ${server} at ${host} did not answer in time.`;
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${host} cannot be reached from the app server.`;
    return null;
}

/**
 * Say why a request failed, for the log and the settings page. Never the request or the
 * axios config: either can carry the API key. A server's own message is passed on, with the
 * key taken out in case it was echoed.
 */
function describeFailure(error, url, key, {listing = false} = {}) {
    const where = `${url.origin}${url.pathname}`;
    const hide = text => (key ? String(text).split(key).join('***') : String(text));
    if (error.response) {
        const status = error.response.status;
        const reason = serverReason(error.response.data);
        if (status === 401 || status === 403) return `The AI server at ${url.host} refused the API key (HTTP ${status}).`;
        if (status === 404 && listing) {
            return `Nothing answered at ${where} (HTTP 404). Use the address of an OpenAI-compatible API, such as http://192.168.1.10:8080 or http://192.168.1.10:8080/v1.`;
        }
        return `The AI server at ${where} answered HTTP ${status}${reason ? `: ${hide(reason)}` : '.'}`;
    }
    const connection = describeConnectionFailure(error, url.host, url.hostname, 'AI server');
    if (connection) return connection;
    const code = error.code || error.cause?.code;
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code || '')) return `The certificate of ${url.host} is not trusted (${code}).`;
    return `Could not reach the AI server at ${url.host}: ${hide(error.message || code || 'unknown error')}`;
}

// Why a Whisper server could not be asked, for the log, the settings page and the task.
function describeWhisperFailure(error, address) {
    const where = address.label;
    if (error.code === 'EWYOMING') return `The Whisper server at ${where} answered with an error: ${error.message}`;
    if (error.code === 'EPROTOCOL') return `${where} did not answer in the Wyoming protocol. Use the address of a Wyoming server, such as Home Assistant's Whisper on port ${WHISPER_PORT}.`;
    if (error.code === 'ECLOSED') return `The Whisper server at ${where} closed the connection without answering.`;
    // Home Assistant's add-on only listens to the add-on network until a port is set for it.
    if ((error.code || error.cause?.code) === 'ECONNREFUSED') {
        return `Nothing is listening at ${where}. Check the address and port, and that the server is running. Home Assistant's Whisper add-on needs a port set under Network in its configuration first.`;
    }
    return describeConnectionFailure(error, where, address.host, 'Whisper server')
        || `Could not reach the Whisper server at ${where}: ${error.message || error.code || 'unknown error'}`;
}

exports.request = async (base_url, endpoint, {data, key = '', signal, timeout = 15000, requireEnabled = true, listing = false} = {}) => {
    if (requireEnabled && !exports.isEnabled()) throw new Error('AI integration is disabled.');
    const url = new URL(`${apiRoot(base_url)}${endpoint}`);
    const method = data === undefined ? 'GET' : 'POST';
    const httpAgent = new http.Agent({lookup: localLookup});
    const httpsAgent = new https.Agent({lookup: localLookup});
    const started = Date.now();
    try {
        const response = await axios.request({
            url: url.toString(), method, data,
            headers: key ? {Authorization: `Bearer ${key}`} : {},
            httpAgent, httpsAgent, proxy: false, maxRedirects: 0, timeout, signal,
            maxContentLength: 4 * 1024 * 1024, maxBodyLength: 16 * 1024 * 1024,
            responseType: 'json'
        });
        logger.debug(`Local AI: ${method} ${url.origin}${url.pathname} answered HTTP ${response.status} in ${Date.now() - started} ms.`);
        return response.data;
    } catch (error) {
        if (signal?.aborted) throw new Error('AI work stopped because its settings changed.', {cause: error});
        const message = describeFailure(error, url, key, {listing});
        logger.debug(`Local AI: ${method} ${url.origin}${url.pathname} failed after ${Date.now() - started} ms: ${message}`);
        throw new Error(message, {cause: error});
    } finally {
        httpAgent.destroy();
        httpsAgent.destroy();
    }
};

/**
 * The models the saved server runs, for choosing one in the settings. Works before AI is
 * turned on, since it is how the settings are filled in. Cloud models are left out.
 * @returns {Promise<string[]>} model IDs, sorted
 */
exports.listModels = async () => {
    const {base_url, api_key} = exports.settings();
    const result = await exports.request(base_url, '/models', {key: api_key || '', requireEnabled: false, listing: true});
    if (!Array.isArray(result?.data)) {
        throw new Error(`The server at ${apiRoot(base_url)} did not answer with a list of models. Use the address of an OpenAI-compatible API.`);
    }
    const ids = result.data.map(model => model?.id).filter(id => typeof id === 'string' && id.trim() && !exports.isCloudModel(id));
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
};

async function whisperRequest(whisper_url, events, wanted, {signal, timeout, requireEnabled = true}) {
    if (requireEnabled && !exports.isEnabled()) throw new Error('AI integration is disabled.');
    const address = whisperAddress(whisper_url);
    const started = Date.now();
    try {
        const answer = await wyoming.exchange({host: address.host, port: address.port, lookup: localLookup}, events, wanted, {signal, timeout});
        logger.debug(`Whisper: ${events[0].type} at ${address.label} answered in ${Date.now() - started} ms.`);
        return answer;
    } catch (error) {
        if (signal?.aborted) throw new Error('AI work stopped because its settings changed.', {cause: error});
        const message = describeWhisperFailure(error, address);
        logger.debug(`Whisper: ${events[0].type} at ${address.label} failed after ${Date.now() - started} ms: ${message}`);
        throw new Error(message, {cause: error});
    }
}

// Names from a server, kept to one short line for the settings page and the transcript.
const shortName = name => (typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 100) : '');

/**
 * What the saved Whisper server runs, such as "faster-whisper small-int8", from the
 * description every Wyoming server gives of itself. Works before AI is turned on, like
 * listing models. Refuses a server that does no speech-to-text, such as the Piper voice
 * Home Assistant runs one port down.
 * @returns {Promise<{name: string}>}
 */
exports.describeWhisper = async ({whisper_url}, {signal, requireEnabled = true} = {}) => {
    const {data} = await whisperRequest(whisper_url, [{type: 'describe'}], 'info', {signal, timeout: 15000, requireEnabled});
    const installed = list => (Array.isArray(list) ? list : []).filter(entry => entry && typeof entry === 'object' && entry.installed !== false);
    const [program] = installed(data.asr);
    if (!program) {
        const others = [...new Set(Object.values(data).flat().map(service => shortName(service?.name)).filter(Boolean))].slice(0, 3);
        throw new Error(`The Wyoming server at ${whisperAddress(whisper_url).label} does no speech-to-text${others.length ? `; it runs ${others.join(', ')}` : ''}.`
            + ` Home Assistant's Whisper is usually on port ${WHISPER_PORT}.`);
    }
    const names = [shortName(program.name), shortName(installed(program.models).find(model => shortName(model.name))?.name)].filter(Boolean);
    // A model named after its program, as some are, is not named twice.
    const name = names.length === 2 && names[1].toLowerCase().includes(names[0].toLowerCase()) ? names[1] : names.join(' ');
    return {name: name || 'Whisper'};
};

// How the audio for Whisper is laid out: 16 kHz, 16-bit, mono, which is what it listens to.
const PCM = {rate: 16000, width: 2, channels: 1};
const PCM_SECOND = PCM.rate * PCM.width * PCM.channels;

/**
 * What the saved Whisper server hears in a stretch of audio, as 16 kHz mono 16-bit PCM. It is
 * sent the way Home Assistant sends a voice command, in one-second chunks, and transcribed in
 * the language the server is set to. Sending one would choose it here, and Home Assistant's
 * add-on downloads another model for a language it was not set up for.
 */
exports.transcribeSpeech = async ({whisper_url}, pcm, {signal} = {}) => {
    const milliseconds = bytes => Math.round(bytes / PCM_SECOND * 1000);
    const events = [{type: 'transcribe', data: {}}, {type: 'audio-start', data: {...PCM, timestamp: 0}}];
    for (let offset = 0; offset < pcm.length; offset += PCM_SECOND) {
        events.push({type: 'audio-chunk', data: {...PCM, timestamp: milliseconds(offset)}, payload: pcm.subarray(offset, offset + PCM_SECOND)});
    }
    events.push({type: 'audio-stop', data: {timestamp: milliseconds(pcm.length)}});
    // As long as a chat completion gets: a server can load its model first.
    const {data} = await whisperRequest(whisper_url, events, 'transcript', {signal, timeout: 10 * 60 * 1000});
    if (typeof data.text !== 'string') throw new Error(`The Whisper server at ${whisperAddress(whisper_url).label} answered without any text.`);
    return data.text.trim();
};

/**
 * One chat completion from the configured model. The content may hold input_audio and
 * image_url parts as well as text. Resolves the reply's text, without any thinking a
 * reasoning model wrote before it.
 */
exports.chat = async (settings, messages, {signal, temperature = 0.2, max_tokens = 1024} = {}) => {
    const result = await exports.request(settings.base_url, '/chat/completions', {
        data: {model: settings.model, messages, temperature, max_tokens, stream: false},
        // Long enough for a server to load the model first, which llama-swap and Ollama do.
        key: settings.api_key, signal, timeout: 10 * 60 * 1000
    });
    const text = result?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error(`${settings.model} answered without any text.`);
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
};
