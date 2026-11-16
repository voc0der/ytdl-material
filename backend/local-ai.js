const axios = require('axios');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const config = require('./config');
const {parseAddressList, addressInList} = require('./ip-ranges');

const LOCAL_ADDRESSES = parseAddressList('127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,::1,fc00::/7');
const CONFIG_KEYS = ['enabled', 'provider', 'base_url', 'model', 'api_key',
    'transcription_provider', 'transcription_url', 'transcription_model', 'transcription_api_key', 'language'];

exports.isEnabled = () => config.getConfigItem('ytdl_ai_enabled') === true;
exports.settings = () => Object.fromEntries(CONFIG_KEYS.map(key => [key, config.getConfigItem(`ytdl_ai_${key}`)]));

function parseBaseURL(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Enter a valid local AI server URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('AI server URLs must use HTTP or HTTPS, without credentials, a query, or a fragment.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !addressInList(LOCAL_ADDRESSES, host)) {
        throw new Error('AI servers must use a loopback or private network address.');
    }
    return url.toString().replace(/\/+$/, '');
}

exports.validateSettings = (settings) => {
    if (!settings || settings.enabled === false || settings.enabled === undefined) return;
    if (settings.enabled !== true) throw new Error('AI enabled must be a boolean.');
    if (!['ollama', 'llamacpp'].includes(settings.provider)) throw new Error('Choose Ollama or llama.cpp.');
    for (const key of CONFIG_KEYS.filter(key => key !== 'enabled')) {
        if (typeof settings[key] !== 'string' || settings[key].length > 4096) throw new Error('AI settings must be text values of at most 4096 characters.');
    }
    parseBaseURL(settings.base_url);
    if (!['disabled', 'llamacpp', 'whispercpp'].includes(settings.transcription_provider)) {
        throw new Error('Choose a local speech recognition server or disable transcription.');
    }
    if (settings.transcription_provider !== 'disabled') parseBaseURL(settings.transcription_url);
    if (settings.language && !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(settings.language)) {
        throw new Error('Use a language code such as en, or leave it blank for automatic detection.');
    }
};

// Resolve at connection time and give the socket only checked addresses. Redirects and
// environment proxies are disabled too, so a private hostname cannot route audio to a
// public service. Docker service names and private DNS work without a hostname allowlist.
function localLookup(hostname, options, callback) {
    dns.lookup(hostname, {all: true}, (error, addresses) => {
        if (error) return callback(error);
        if (!addresses.length || addresses.some(entry => !addressInList(LOCAL_ADDRESSES, entry.address))) {
            return callback(new Error('AI servers must resolve only to loopback or private network addresses.'));
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
    });
}

exports.request = async (base, endpoint, {data, key = '', signal, timeout = 15000} = {}) => {
    if (!exports.isEnabled()) throw new Error('AI integration is disabled.');
    const url = `${parseBaseURL(base)}${endpoint}`;
    const httpAgent = new http.Agent({lookup: localLookup});
    const httpsAgent = new https.Agent({lookup: localLookup});
    try {
        const response = await axios.request({
            url, method: data === undefined ? 'GET' : 'POST', data,
            headers: key ? {Authorization: `Bearer ${key}`} : {},
            httpAgent, httpsAgent, proxy: false, maxRedirects: 0, timeout, signal,
            maxContentLength: 4 * 1024 * 1024, maxBodyLength: 12 * 1024 * 1024,
            responseType: 'json'
        });
        return response.data;
    } catch (error) {
        if (signal?.aborted) throw new Error('AI work stopped because its settings changed.', {cause: error});
        // Never include a provider response or axios config: either can contain credentials.
        if (error.response) throw new Error(`Local AI server returned HTTP ${error.response.status}. Check its model and endpoint.`, {cause: error});
        throw new Error('Could not reach the local AI server. Check its address, network, and timeout.', {cause: error});
    } finally {
        httpAgent.destroy();
        httpsAgent.destroy();
    }
};

exports.testConnection = async () => {
    const settings = exports.settings();
    if (!exports.isEnabled()) throw new Error('AI integration is disabled.');
    exports.validateSettings(settings);
    if (settings.provider === 'ollama') {
        if (!settings.model.trim()) throw new Error('Enter a local Ollama model name before testing the connection.');
        const result = await exports.request(settings.base_url, '/api/show', {
            data: {model: settings.model}, key: settings.api_key
        });
        if (result?.remote_model || result?.remote_host || /(?:^|[-:])cloud(?:$|[-:])/i.test(settings.model)) {
            throw new Error('Select a locally installed Ollama model. Cloud models are not supported.');
        }
        if (!result?.details || result.error) throw new Error('The server did not return a local Ollama model.');
    } else {
        const result = await exports.request(settings.base_url, '/v1/models', {key: settings.api_key});
        if (!Array.isArray(result?.data) || !result.data.some(model => model.id && (!settings.model || model.id === settings.model))) {
            throw new Error('The configured model is not available on the llama.cpp server.');
        }
    }
    return {success: true};
};

exports.transcribe = async (audio, settings, signal) => {
    if (!['llamacpp', 'whispercpp'].includes(settings.transcription_provider)) {
        throw new Error('Configure a local speech recognition server in Settings → Advanced.');
    }
    const form = new FormData();
    form.append('file', new Blob([audio], {type: 'audio/wav'}), 'audio.wav');
    form.append('response_format', 'json');
    if (settings.transcription_model) form.append('model', settings.transcription_model);
    if (settings.language) form.append('language', settings.language);
    const endpoint = settings.transcription_provider === 'whispercpp' ? '/inference' : '/v1/audio/transcriptions';
    const result = await exports.request(settings.transcription_url, endpoint, {
        data: form, key: settings.transcription_api_key, signal, timeout: 10 * 60 * 1000
    });
    if (typeof result?.text !== 'string' || result.error) throw new Error('Speech recognition returned an invalid transcript.');
    return result.text.trim();
};
