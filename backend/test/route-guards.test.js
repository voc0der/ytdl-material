/* eslint-disable no-undef */
const fs = require('fs');
const path = require('path');

const { assert } = require('./test-shared');

/*************************************************
 * Reads app.js as source rather than mounting it:
 * requiring app.js boots the whole application,
 * including a listening socket and the startup
 * subscription check.
 *
 * The failure this is guarding against is someone
 * adding a route and forgetting the guard, which is
 * a property of the source, so reading the source
 * is the honest way to check it.
 ************************************************/
const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const ROUTE_PATTERN = /^app\.(get|post|put|delete)\('(\/api\/[^']*)'\s*,?\s*([^\n]*)$/gm;

// Routes that deliberately answer callers who have not authenticated. Each needs a reason,
// because "it was already like that" is how the list grows.
const INTENTIONALLY_UNAUTHENTICATED = {
    '/api/config': 'the login page cannot render without the auth method; secrets are redacted for anonymous callers',
    '/api/versionInfo': 'version string only, shown in the footer before login',
    '/api/auth/login': 'this is how you authenticate',
    '/api/auth/jwtAuth': 'this is how you authenticate',
    '/api/auth/register': 'open registration is a supported configuration; the route itself decides whether it is on',
    '/api/auth/adminExists': 'the first-run setup screen asks this before an account exists',
    '/api/auth/oidc/status': 'the login page asks whether to show an OIDC button',
    '/api/auth/oidc/login': 'the OIDC redirect, by definition pre-authentication',
    '/api/auth/oidc/callback': 'the OIDC redirect target, by definition pre-authentication',
    '/api/telegramRequest': 'authenticated by the Telegram bot token, not by a user',
    '/api/rss': 'feed readers cannot hold a session; access is scoped by the opaque feed URL',
    '/api/checkConcurrentStream': 'playback state for a shared link, which has no user',
    '/api/incrementViewCount': 'playback state for a shared link, which has no user',
    '/api/uploadCookies': 'guarded by its own multer + rate limiter chain',
    '/api/testCookies': 'guarded by its own rate limiter chain'
};

const GUARDS = ['requireAdmin', 'requirePermission', 'anyAuthenticatedUser'];

function parseRoutes() {
    const routes = [];
    let match;
    ROUTE_PATTERN.lastIndex = 0;
    while ((match = ROUTE_PATTERN.exec(APP_SOURCE)) !== null) {
        routes.push({verb: match[1], route: match[2], rest: match[3]});
    }
    return routes;
}

describe('API route guards', function() {
    const routes = parseRoutes();

    it('finds the routes at all', function() {
        // If this drops sharply, the pattern above stopped matching and every other
        // assertion in this file silently became vacuous.
        assert(routes.length > 100, `expected to parse over 100 API routes, found ${routes.length}`);
    });

    it('gives every route either a guard or a documented reason to have none', function() {
        const ungoverned = routes.filter(({route, rest}) => {
            if (Object.prototype.hasOwnProperty.call(INTENTIONALLY_UNAUTHENTICATED, route)) return false;
            return !GUARDS.some(guard => rest.includes(guard));
        });

        assert.deepStrictEqual(ungoverned.map(r => `${r.verb.toUpperCase()} ${r.route}`), [],
            'these routes have no authorization guard. Add one, or add the route to '
            + 'INTENTIONALLY_UNAUTHENTICATED with the reason it is safe without one.');
    });

    it('does not leave stale entries in the unauthenticated list', function() {
        const defined_routes = new Set(routes.map(r => r.route));
        const stale = Object.keys(INTENTIONALLY_UNAUTHENTICATED).filter(route => !defined_routes.has(route));

        assert.deepStrictEqual(stale, [], 'these routes no longer exist and should be removed from the list');
    });

    it('puts every guard behind optionalJwt', function() {
        // The guards read req.user, which optionalJwt is what populates.
        const misordered = routes.filter(({rest}) =>
            GUARDS.some(guard => rest.includes(guard)) && !rest.includes('optionalJwt'));

        assert.deepStrictEqual(misordered.map(r => r.route), [],
            'a guard placed before optionalJwt sees no user and would refuse everyone');
    });

    it('keeps user and server management restricted to administrators', function() {
        const must_be_admin = [
            '/api/setConfig', '/api/restartServer', '/api/transferDB', '/api/restoreDBBackup',
            '/api/getUsers', '/api/getRoles', '/api/updateUser', '/api/deleteUser',
            '/api/changeUserPermissions', '/api/changeRolePermissions', '/api/generateNewAPIKey',
            '/api/updateServer', '/api/logs', '/api/clearAllLogs'
        ];

        for (const route of must_be_admin) {
            const definition = routes.find(r => r.route === route);
            assert(definition, `expected ${route} to exist`);
            assert(definition.rest.includes('requireAdmin'), `${route} must be behind requireAdmin`);
        }
    });
});
