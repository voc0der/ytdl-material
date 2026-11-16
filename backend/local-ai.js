// A local AI server, spoken to through the OpenAI-compatible API that llama.cpp, llama-swap,
// Ollama, LM Studio and the like all serve: /models lists what it runs, /chat/completions
// takes text with audio and images. Media never leaves the local network: the server has to
// be on a loopback or private address.
const axios = require('axios');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const config = require('./config');
const logger = require('./logger');
const {parseAddressList, addressInList} = require('./ip-ranges');

const LOCAL_ADDRESSES = parseAddressList('127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,::1,fc00::/7');
const CONFIG_KEYS = ['enabled', 'base_url', 'model', 'api_key', 'vision', 'audio'];
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

exports.validateSettings = (settings) => {
    if (!settings || settings.enabled === false || settings.enabled === undefined) return;
    if (settings.enabled !== true) throw new Error('AI enabled must be true or false.');
    for (const key of ['base_url', 'model', 'api_key']) {
        if (typeof settings[key] !== 'string' || settings[key].length > 4096) throw new Error('AI settings must be text values of at most 4096 characters.');
    }
    for (const key of ['vision', 'audio']) {
        if (settings[key] !== undefined && typeof settings[key] !== 'boolean') throw new Error('Vision and Audio must be true or false.');
    }
    apiRoot(settings.base_url);
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
    const code = error.code || error.cause?.code;
    if (code === 'EOUTSIDE') return error.message;
    if (code === 'ECONNREFUSED') return `Nothing is listening at ${url.host}. Check the address and port, and that the server is running.`;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${url.hostname} could not be found. Check the address; in Docker, localhost is the app's own container.`;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return `The AI server at ${url.host} did not answer in time.`;
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${url.host} cannot be reached from the app server.`;
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code || '')) return `The certificate of ${url.host} is not trusted (${code}).`;
    return `Could not reach the AI server at ${url.host}: ${hide(error.message || code || 'unknown error')}`;
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
 * The models a server runs, for choosing one in the settings. Works before the settings are
 * saved, since it is how they are filled in. Cloud models are left out.
 * @returns {Promise<string[]>} model IDs, sorted
 */
exports.listModels = async ({base_url, api_key = ''} = {}) => {
    const result = await exports.request(base_url, '/models', {key: api_key, requireEnabled: false, listing: true});
    if (!Array.isArray(result?.data)) {
        throw new Error(`The server at ${apiRoot(base_url)} did not answer with a list of models. Use the address of an OpenAI-compatible API.`);
    }
    const ids = result.data.map(model => model?.id).filter(id => typeof id === 'string' && id.trim() && !exports.isCloudModel(id));
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
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
