/*************************************************
 * Decides which requests skip a rate limiter.
 *
 * Lives in its own module so it can be exercised
 * directly. These predicates are the only thing
 * between an endpoint and an unlimited number of
 * requests, and while they sat as closures inside
 * app.js the only way to reach them was to boot the
 * whole application -- so nothing did.
 *
 * Two rules hold throughout:
 *
 *   - match on the path, never the URL. req.originalUrl
 *     carries the query string, and every test here is
 *     a prefix test, so '?x=/api/get' on any request at
 *     all used to satisfy one and skip the limiter.
 *     Appending it to /api/auth/login bought unlimited
 *     password attempts.
 *
 *   - match by prefix, never by substring. A substring
 *     test says nothing about where in the path it
 *     matched, which is the same defect that let a
 *     share link for /api/getFile reach
 *     /api/getFileFormats.
 ************************************************/

// Fetched repeatedly to render a single page, so they cannot be limited without breaking
// ordinary browsing.
const PUBLIC_API_PREFIXES = [
    '/api/stream',
    '/api/thumbnail/',
    '/api/rss',
    '/api/telegramRequest'
];

// Read-only browsing and status calls the UI makes constantly. '/api/get' stays a prefix
// covering every listing route, which is what it has always meant.
const API_RATE_LIMIT_EXEMPT_PREFIXES = [
    '/api/auth/jwtAuth',
    '/api/auth/adminExists',
    '/api/get',
    '/api/versionInfo',
    '/api/updaterStatus',
    '/api/checkConcurrentStream'
];

// jwtAuth refreshes a token the caller already holds and adminExists returns a boolean, so
// neither is a place credentials can be guessed. Everything else under /api/auth is.
const AUTH_RATE_LIMIT_EXEMPT_PREFIXES = [
    '/api/auth/jwtAuth',
    '/api/auth/adminExists'
];

function matchesAnyPrefix(request_path, prefixes) {
    return prefixes.some(prefix => request_path === prefix || request_path.startsWith(prefix));
}

/*************************************************
 * The full path of the request, without the query
 * string and without the fragment.
 ************************************************/
function getRateLimitRequestPath(req) {
    const raw_path = req.originalUrl || `${req.baseUrl || ''}${req.path || req.url || ''}`;
    return String(raw_path).split('?')[0].split('#')[0];
}

function isPublicApiPath(request_path = '') {
    return matchesAnyPrefix(request_path, PUBLIC_API_PREFIXES);
}

function isPublicApiRateLimitExemptPath(request_path = '') {
    // The Telegram webhook is public in the same sense as the others, but it is a write,
    // and an unlimited write is a download queue anybody can fill.
    return isPublicApiPath(request_path) && !request_path.startsWith('/api/telegramRequest');
}

function skipAuthRateLimit(req) {
    return matchesAnyPrefix(getRateLimitRequestPath(req), AUTH_RATE_LIMIT_EXEMPT_PREFIXES);
}

function skipApiRateLimit(req) {
    const request_path = getRateLimitRequestPath(req);
    return isPublicApiRateLimitExemptPath(request_path)
        || matchesAnyPrefix(request_path, API_RATE_LIMIT_EXEMPT_PREFIXES);
}

module.exports = {
    getRateLimitRequestPath,
    isPublicApiPath,
    isPublicApiRateLimitExemptPath,
    skipApiRateLimit,
    skipAuthRateLimit,
    PUBLIC_API_PREFIXES,
    API_RATE_LIMIT_EXEMPT_PREFIXES,
    AUTH_RATE_LIMIT_EXEMPT_PREFIXES
};
