/* eslint-disable no-undef */
const { assert } = require('./test-shared');

const {
    getRateLimitRequestPath,
    isPublicApiRateLimitExemptPath,
    skipApiRateLimit,
    skipAuthRateLimit
} = require('../rate-limit-paths');

/*************************************************
 * These predicates decide whether a request is
 * counted against a rate limiter at all, so a
 * predicate that says yes too readily is the same
 * as having no limiter.
 *
 * They used to be closures inside app.js, reachable
 * only by booting the whole application, so nothing
 * exercised them -- which is how both defects below
 * survived.
 ************************************************/

// express populates originalUrl with the query string attached, which is the whole of the
// first defect.
function requestFor(original_url) {
    return {originalUrl: original_url};
}

describe('Rate limit exemptions', function() {
    describe('The path a decision is made on', function() {
        it('drops the query string', function() {
            assert.strictEqual(getRateLimitRequestPath(requestFor('/api/deleteUser?jwt=abc')), '/api/deleteUser');
        });

        it('drops a fragment as well', function() {
            assert.strictEqual(getRateLimitRequestPath(requestFor('/api/deleteUser#/api/get')), '/api/deleteUser');
        });

        it('reconstructs the path from the mount point when there is no original URL', function() {
            assert.strictEqual(getRateLimitRequestPath({baseUrl: '/api', path: '/deleteUser'}), '/api/deleteUser');
        });
    });

    describe('The query string', function() {
        /*************************************************
         * Every predicate was a substring test against
         * req.originalUrl, and originalUrl carries the
         * query string. Naming an exempt path in any
         * query parameter therefore exempted the request
         * it was attached to, whatever that request was.
         ************************************************/
        it('does not exempt a request from the API limiter', function() {
            for (const exempt_name of ['/api/get', '/api/stream', '/api/rss', '/api/thumbnail/', '/api/versionInfo']) {
                assert.strictEqual(skipApiRateLimit(requestFor(`/api/deleteUser?x=${exempt_name}`)), false,
                    `naming ${exempt_name} in the query string must not exempt /api/deleteUser`);
            }
        });

        it('does not exempt a login attempt from the auth limiter', function() {
            // The one that mattered most: unlimited password guessing.
            assert.strictEqual(skipAuthRateLimit(requestFor('/api/auth/login?x=/api/auth/jwtAuth')), false);
            assert.strictEqual(skipAuthRateLimit(requestFor('/api/auth/login?redirect=/api/auth/adminExists')), false);
        });

        it('does not exempt a request whose query merely mentions a public path', function() {
            assert.strictEqual(skipApiRateLimit(requestFor('/api/setConfig?next=/api/stream/abc')), false);
        });
    });

    describe('Where in the path a match lands', function() {
        it('exempts the paths it is meant to', function() {
            for (const exempt_path of ['/api/getPlaylists', '/api/getFile', '/api/versionInfo',
                '/api/updaterStatus', '/api/checkConcurrentStream', '/api/auth/jwtAuth',
                '/api/auth/adminExists', '/api/stream', '/api/rss', '/api/thumbnail/abc']) {
                assert.strictEqual(skipApiRateLimit(requestFor(exempt_path)), true,
                    `${exempt_path} is fetched constantly and must stay exempt`);
            }
        });

        it('still counts the routes that are not exempt', function() {
            for (const limited_path of ['/api/deleteUser', '/api/setConfig', '/api/restartServer',
                '/api/downloadFile', '/api/auth/login', '/api/updateServer']) {
                assert.strictEqual(skipApiRateLimit(requestFor(limited_path)), false,
                    `${limited_path} mutates something and must be counted`);
            }
        });

        it('matches by prefix rather than anywhere in the path', function() {
            // A substring test says nothing about where it matched -- the same defect that
            // let a share link issued for /api/getFile reach /api/getFileFormats.
            assert.strictEqual(skipApiRateLimit(requestFor('/api/deleteUser/api/get')), false);
            assert.strictEqual(skipAuthRateLimit(requestFor('/api/auth/login/api/auth/jwtAuth')), false);
        });
    });

    describe('The Telegram webhook', function() {
        it('is public but still counted, because it is a write', function() {
            // An unlimited write is a download queue anybody can fill.
            assert.strictEqual(isPublicApiRateLimitExemptPath('/api/telegramRequest'), false);
            assert.strictEqual(skipApiRateLimit(requestFor('/api/telegramRequest')), false);
        });
    });
});
