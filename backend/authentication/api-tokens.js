const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const db_api = require('../db');
const logger = require('../logger');

/*************************************************
 * Per-user API tokens.
 *
 * The Public API key it replaces was one value for
 * the whole server, shipped as a default nobody
 * changed, and it did not say who was calling -- so
 * it could not authorize anything even when it
 * matched.
 *
 * A token here belongs to exactly one account. Full
 * API tokens resolve to that user and let the route
 * guards decide what it may do; RSS tokens resolve
 * only on the feed route. Revoking one does not
 * touch the others, and none can outlive its account.
 ************************************************/

// Long enough that guessing is not a strategy, and prefixed so a leaked one is recognisable
// in a log or a paste and can be searched for.
const TOKEN_PREFIX = 'ytdl_';
const TOKEN_BYTES = 32;
const MAX_TOKENS_PER_USER = 10;
const MAX_LABEL_LENGTH = 64;
const TOKEN_TYPES = Object.freeze({
    API: 'api',
    RSS: 'rss'
});

function hashToken(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function sanitizeLabel(label) {
    if (typeof label !== 'string') return '';
    return label.trim().slice(0, MAX_LABEL_LENGTH);
}

/*************************************************
 * What a caller may see about their own tokens.
 * Never the hash: it is an internal lookup value and
 * callers have no reason to receive it.
 ************************************************/
function presentToken(record) {
    return {
        id: record.id,
        label: record.label || '',
        type: record.type || TOKEN_TYPES.API,
        created: record.created,
        last_used: record.last_used || null
    };
}

exports.listTokensForUser = async (user_uid) => {
    if (!user_uid) return [];
    const records = await db_api.getRecords('api_tokens', {user_uid: user_uid});
    return (records || [])
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map(presentToken);
}

exports.generateTokenForUser = async (user_uid, label = '', type = TOKEN_TYPES.API) => {
    if (!user_uid) return null;
    if (!Object.values(TOKEN_TYPES).includes(type)) return {error: 'Unknown API token type.'};

    const existing = await db_api.getRecords('api_tokens', {user_uid: user_uid});
    if (existing && existing.length >= MAX_TOKENS_PER_USER) {
        logger.error(`Refusing to generate an API token for ${user_uid}: the limit of ${MAX_TOKENS_PER_USER} is reached.`);
        return {error: `You already have ${MAX_TOKENS_PER_USER} tokens. Revoke one first.`};
    }

    const token = `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
    const record = {
        id: uuid(),
        user_uid: user_uid,
        label: sanitizeLabel(label),
        type: type,
        hash: hashToken(token),
        created: Date.now(),
        last_used: null
    };

    await db_api.insertRecordIntoTable('api_tokens', record);
    logger.verbose(`Generated an API token for ${user_uid}.`);

    // The only time the token itself is ever returned.
    return {token: token, ...presentToken(record)};
}

exports.revokeTokenForUser = async (user_uid, token_id) => {
    if (!user_uid || typeof token_id !== 'string' || !token_id) return false;

    /*************************************************
     * Filtered on the owner as well as the id, so
     * naming somebody else's token does nothing.
     *
     * The record is read first because removeRecord
     * reports that the delete ran, not that anything
     * matched -- on the local database it returns
     * true unconditionally. Returning that straight
     * to the caller told them a token had been
     * revoked when it had not, and told one user they
     * had just revoked another user's token.
     ************************************************/
    const record = await db_api.getRecord('api_tokens', {id: token_id, user_uid: user_uid});
    if (!record) return false;

    await db_api.removeRecord('api_tokens', {id: token_id, user_uid: user_uid});
    return true;
}

exports.revokeAllTokensForUser = async (user_uid) => {
    if (!user_uid) return false;
    return !!await db_api.removeAllRecords('api_tokens', {user_uid: user_uid});
}

/*************************************************
 * Resolves a presented token to the user it belongs
 * to, or null.
 *
 * The lookup is by hash, so an attacker who can read
 * the table still has to invert sha256 to get
 * something the server will accept. There is no
 * comparison of secrets here to be timed: the hash
 * is the primary lookup key.
 ************************************************/
exports.resolveToken = async (token, allowed_types = [TOKEN_TYPES.API]) => {
    if (typeof token !== 'string' || !/^ytdl_[A-Za-z0-9_-]{43}$/.test(token)) return null;

    const record = await db_api.getRecord('api_tokens', {hash: hashToken(token)});
    if (!record) return null;

    // Records created before token types existed are ordinary full API tokens. RSS
    // tokens are deliberately narrower: putting one in a feed reader must not turn a
    // leaked feed URL into a credential for every API route the user can reach.
    const record_type = record.type || TOKEN_TYPES.API;
    if (!Array.isArray(allowed_types) || !allowed_types.includes(record_type)) return null;

    const user = await db_api.getRecord('users', {uid: record.user_uid});
    if (!user) {
        // The account is gone but the token outlived it. Clean up rather than leave a
        // credential that resolves to nothing on every request.
        await db_api.removeRecord('api_tokens', {id: record.id});
        return null;
    }

    db_api.updateRecord('api_tokens', {id: record.id}, {last_used: Date.now()})
        .catch(() => logger.warn(`Could not record last use of API token ${record.id}.`));

    return user;
}

exports.TOKEN_PREFIX = TOKEN_PREFIX;
exports.MAX_TOKENS_PER_USER = MAX_TOKENS_PER_USER;
exports.TOKEN_TYPES = TOKEN_TYPES;
