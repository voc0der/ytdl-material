const { Mutex } = require('async-mutex');

const config_api = require('../config');
const logger = require('../logger');
const ip_ranges = require('../ip-ranges');

const auth_api = require('./auth');
const oidc_api = require('./oidc');

/*************************************************
 * Sign-in by a header that a reverse proxy sets
 * once it has authenticated the visitor itself:
 * Authelia, Authentik, oauth2-proxy and the like,
 * in front of the app as forward auth.
 *
 * The header is a claim of identity with nothing
 * behind it but where it came from, so it is only
 * read from a request whose connection was opened
 * by one of the listed proxies. Anybody else who
 * can reach the app could send it themselves and
 * be whoever they liked.
 *
 * Decided once, at startup. Who is trusted to
 * vouch for identities is not something a running
 * server should change its mind about, and a
 * configuration that cannot be used stops the
 * server from starting rather than leaving it to
 * run half-protected.
 ************************************************/

// RFC 9110 field-name: a token.
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Headers that already mean something to HTTP or to this app, so cannot also name a user.
const RESERVED_HEADER_NAMES = new Set([
    'authorization', 'connection', 'content-length', 'content-type', 'cookie', 'forwarded', 'host',
    'transfer-encoding', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'
]);

const REFUSED_MESSAGE = 'Your reverse proxy did not sign you in. The server log says why.';
const UNUSABLE_ACCOUNT_MESSAGE = 'Your reverse proxy signed you in as an account that cannot be used here. The server log says why.';

// The settings in force, or null while header sign-in is off.
let active_settings = null;

// One sign-in at a time, so that two requests for a new account cannot both create it.
const sign_in_mutex = new Mutex();

function parseBool(input, fallback = false) {
    if (typeof input === 'boolean') return input;
    if (typeof input === 'string') {
        const normalized = input.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return fallback;
}

function parseCSV(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.map(value => String(value).trim()).filter(value => value.length > 0);
    return String(input).split(',').map(value => value.trim()).filter(value => value.length > 0);
}

function getConfiguredSettings() {
    return {
        enabled: parseBool(config_api.getConfigItem('ytdl_header_auth_enabled'), false),
        trusted_proxies: String(config_api.getConfigItem('ytdl_header_auth_trusted_proxies') || ''),
        user_header: String(config_api.getConfigItem('ytdl_header_auth_user_header') || '').trim() || 'Remote-User',
        auto_register: parseBool(config_api.getConfigItem('ytdl_header_auth_auto_register'), true),
        admin_users: parseCSV(config_api.getConfigItem('ytdl_header_auth_admin_users'))
    };
}

/*************************************************
 * Why a server cannot run with header sign-in on,
 * or null when it can.
 *
 * OIDC and LDAP are refused outright rather than
 * left to coexist with it: each is another answer
 * to who somebody is, and a server should only
 * have one.
 ************************************************/
function findConflict({multi_user_mode, oidc_enabled, auth_method}) {
    if (!multi_user_mode) {
        return 'Header sign-in needs multi-user mode (ytdl_multi_user_mode).';
    }
    if (oidc_enabled) {
        return 'Header sign-in cannot be enabled together with OIDC (ytdl_oidc_enabled). Turn one of them off.';
    }
    if (auth_method === 'ldap') {
        return 'Header sign-in cannot be enabled together with LDAP (ytdl_auth_method). Set the auth method back to internal, or turn header sign-in off.';
    }
    return null;
}

exports.findConflict = findConflict;

/*************************************************
 * The same check, against a config that has not
 * been saved yet: what the settings page sends. A
 * save it refuses is one that would otherwise stop
 * the server at its next start.
 ************************************************/
exports.findConflictInConfig = (config_root) => {
    const users = (config_root && config_root['Users']) || {};
    const advanced = (config_root && config_root['Advanced']) || {};
    return findConflict({
        multi_user_mode: !!advanced['multi_user_mode'],
        oidc_enabled: parseBool(users['oidc'] && users['oidc']['enabled'], false),
        auth_method: users['auth_method']
    });
}

exports.isConfiguredOn = (header_auth_section) => {
    return !!header_auth_section && parseBool(header_auth_section['enabled'], false);
}

function parseTrustedProxies(value) {
    const trusted = ip_ranges.parseAddressList(value);
    if (trusted.invalid.length > 0) {
        throw new Error(`ytdl_header_auth_trusted_proxies has entries that are not IP addresses or CIDR ranges: `
            + `${trusted.invalid.join(', ')}. Host names are not accepted.`);
    }
    if (trusted.entries.length === 0) {
        throw new Error('ytdl_header_auth_trusted_proxies is empty. List the address of the proxy that sets the header.');
    }
    const everything = trusted.entries.filter(entry => entry.prefix === 0);
    if (everything.length > 0) {
        throw new Error(`ytdl_header_auth_trusted_proxies cannot contain ${everything.map(entry => entry.text).join(', ')}: `
            + 'that trusts every address, so anybody could send the header.');
    }
    return trusted;
}

function checkHeaderName(header_name) {
    if (!HEADER_NAME_PATTERN.test(header_name)) {
        throw new Error(`ytdl_header_auth_user_header ${JSON.stringify(header_name)} is not a valid header name.`);
    }
    if (RESERVED_HEADER_NAMES.has(header_name.toLowerCase())) {
        throw new Error(`ytdl_header_auth_user_header cannot be ${header_name}: that header already means something else.`);
    }
}

/*************************************************
 * Reads and checks the settings. Throws when they
 * cannot be used, which startup turns into a
 * refusal to start.
 ************************************************/
exports.initialize = () => {
    active_settings = null;

    const settings = getConfiguredSettings();
    if (!settings.enabled) return false;

    const conflict = findConflict({
        multi_user_mode: !!config_api.getConfigItem('ytdl_multi_user_mode'),
        oidc_enabled: oidc_api.isEnabled(),
        auth_method: config_api.getConfigItem('ytdl_auth_method')
    });
    if (conflict) throw new Error(conflict);

    const trusted = parseTrustedProxies(settings.trusted_proxies);
    checkHeaderName(settings.user_header);

    active_settings = {
        ...settings,
        header_key: settings.user_header.toLowerCase(),
        trusted: trusted
    };

    logger.info(`Header sign-in enabled: reading ${settings.user_header} from ${trusted.entries.map(entry => entry.text).join(', ')}.`);
    if (settings.admin_users.length === 0) {
        logger.warn('Header sign-in: ytdl_header_auth_admin_users is empty, so nobody who signs in through the proxy will be an administrator.');
    }
    return true;
}

// Whether header sign-in is on, as the server started. Saving the settings never changes it.
exports.isEnabled = () => {
    return !!active_settings;
}

function getPeer(req) {
    return ip_ranges.normalizeAddress(req && req.socket ? req.socket.remoteAddress : null);
}

// Every copy of the header, kept apart. Node would otherwise join repeats with a comma.
function getHeaderValues(req) {
    const values = req && req.headersDistinct ? req.headersDistinct[active_settings.header_key] : null;
    return Array.isArray(values) ? values : [];
}

/*************************************************
 * The user name a request carries, if the request
 * is entitled to carry one.
 *
 * Only the socket's own peer is consulted: the
 * machine that actually opened the connection.
 * req.ip is no use here. With trust proxy set it
 * comes out of X-Forwarded-For, which whoever
 * opened the connection wrote.
 *
 * A header that arrives twice is refused rather
 * than half-believed. That is what a proxy does
 * when it adds its own value to one the client
 * sent, instead of replacing it.
 ************************************************/
function readIdentity(req) {
    const peer = getPeer(req);
    if (!peer || !ip_ranges.addressInList(active_settings.trusted, peer)) return {problem: 'untrusted', peer: peer};

    const values = getHeaderValues(req);
    const present = values.filter(value => value !== '');
    if (present.length === 0) return {problem: 'missing', peer: peer};
    if (values.length > 1) return {problem: 'repeated', peer: peer};
    return {uid: present[0], peer: peer};
}

/*************************************************
 * Signs in whoever the proxy says the request is
 * from. Answers {user} or {status, error}.
 ************************************************/
exports.signIn = async (req) => {
    if (!active_settings) return {status: 404, error: 'Header sign-in is disabled.'};

    const header = active_settings.user_header;
    const identity = readIdentity(req);
    if (identity.problem === 'untrusted') {
        logger.warn(`Header sign-in refused: the request came from ${identity.peer || 'an unknown address'}, `
            + 'which is not in ytdl_header_auth_trusted_proxies.');
        return {status: 401, error: REFUSED_MESSAGE};
    }
    if (identity.problem === 'missing') {
        logger.warn(`Header sign-in refused: the proxy at ${identity.peer} did not send ${header}.`);
        return {status: 401, error: REFUSED_MESSAGE};
    }
    if (identity.problem === 'repeated') {
        logger.warn(`Header sign-in refused: the request from ${identity.peer} carried ${header} more than once. `
            + 'The proxy has to replace the header, not add to one the client sent.');
        return {status: 401, error: REFUSED_MESSAGE};
    }

    const user = await sign_in_mutex.runExclusive(() => auth_api.upsertHeaderUser(identity.uid, {
        auto_register: active_settings.auto_register,
        admin_users: active_settings.admin_users
    }));
    if (!user) return {status: 403, error: UNUSABLE_ACCOUNT_MESSAGE};
    return {user: user};
}

/*************************************************
 * What the settings page shows: the settings in
 * force, and what the server made of the request
 * asking -- the address it came from, whether that
 * address is trusted, and what the header said.
 * Somebody setting this up needs those three, and
 * nothing else can tell them.
 ************************************************/
exports.getStatus = (req) => {
    if (!active_settings) return {enabled: false};

    const peer = getPeer(req);
    return {
        enabled: true,
        user_header: active_settings.user_header,
        trusted_proxies: active_settings.trusted.entries.map(entry => entry.text),
        auto_register: active_settings.auto_register,
        admin_users: active_settings.admin_users,
        request: {
            peer: peer,
            trusted: !!peer && ip_ranges.addressInList(active_settings.trusted, peer),
            values: getHeaderValues(req)
        }
    };
}
