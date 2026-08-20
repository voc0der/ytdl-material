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

// The leading [ \t]* is not cosmetic: one route in app.js is indented, and an anchored
// pattern without it silently parsed 109 of 110 routes -- leaving the missing one
// unchecked while every assertion here still passed.
// Every express verb, and every quote style, because the point of this file is that a
// new route cannot land without a guard. A pattern that only knows single-quoted
// get/post/put/delete does not check a route written any other way -- it does not even
// know it is there.
const ROUTE_VERBS = 'get|post|put|delete|patch|head|options|all';
const ROUTE_PATTERN = new RegExp(
    `^[ \\t]*app\\.(${ROUTE_VERBS})\\(\\s*['"\`](/api/[^'"\`]*)['"\`]\\s*,?\\s*([^\\n]*)$`, 'gm');

// Counted with a deliberately looser pattern, so a route the parser above cannot see
// shows up as a mismatch rather than as an absence.
const ROUTE_COUNT_PATTERN = new RegExp(`app\\.(?:${ROUTE_VERBS})\\(\\s*['"\`]/api/`, 'g');

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
    '/api/telegramRequest': 'authenticated by Telegram\'s webhook secret header, not by a user session',
    // Not opaque today -- the feed URL carries the ordinary user uid. Tracked separately;
    // making it a revocable per-user token is the same machinery as per-user API tokens.
    '/api/rss': 'feed readers cannot hold a session, and the feed is off unless enabled',
    '/api/checkConcurrentStream': 'playback state for a shared link, which has no user',
    '/api/incrementViewCount': 'playback state for a shared link, which has no user'
};

const GUARDS = ['requireAdmin', 'requirePermission', 'requireAuthenticatedOrShared', 'requireAuthenticated'];

// The only routes a share link may reach. optionalJwt matches these exactly; it used to
// match them as substrings, which also let a share reach /api/getFileFormats and
// /api/getPlaylists.
const SHARED_LINK_ROUTES = ['/api/getFile', '/api/stream', '/api/streamSubtitle', '/api/getPlaylist', '/api/downloadFileFromServer'];

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

    it('parses every route defined in the file', function() {
        // If the parser misses even one, every other assertion here is vacuous for it.
        const declared = (APP_SOURCE.match(ROUTE_COUNT_PATTERN) || []).length;
        assert.strictEqual(routes.length, declared,
            `parsed ${routes.length} routes but ${declared} are declared -- the pattern is missing some`);
        assert(routes.length > 100, `expected over 100 API routes, found ${routes.length}`);
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

    it('puts every guard behind optionalJwt, in that order', function() {
        // The guards read req.user, and optionalJwt is what populates it. Checking only
        // that both names appear would pass for a chain that runs them the wrong way
        // round, so compare where each one sits.
        const misordered = routes.filter(({rest}) => {
            const guard = GUARDS.find(candidate => rest.includes(candidate));
            if (!guard) return false;
            const jwt_position = rest.indexOf('optionalJwt');
            return jwt_position === -1 || jwt_position > rest.indexOf(guard);
        });

        assert.deepStrictEqual(misordered.map(r => r.route), [],
            'a guard placed before optionalJwt sees no user and would refuse everyone');
    });

    it('only lets a share link reach the routes it was issued for', function() {
        for (const route of SHARED_LINK_ROUTES) {
            const definition = routes.find(r => r.route === route);
            assert(definition, `expected ${route} to exist`);
            assert(definition.rest.includes('requireAuthenticatedOrShared'),
                `${route} is reachable by a share link and must say so`);
        }

        // Every other route must refuse a caller who only holds a share.
        const overreaching = routes.filter(({route, rest}) =>
            !SHARED_LINK_ROUTES.includes(route) && rest.includes('requireAuthenticatedOrShared'));

        assert.deepStrictEqual(overreaching.map(r => r.route), [],
            'these routes accept a share link but optionalJwt never validates a share for them');
    });

    it('keeps the server-wide cookie file behind an administrator', function() {
        for (const route of ['/api/uploadCookies', '/api/testCookies']) {
            const definition = routes.find(r => r.route === route);
            assert(definition, `expected ${route} to exist`);
            assert(definition.rest.includes('requireAdmin'), `${route} must be behind requireAdmin`);
        }

        // multer writes the request body to disk as it parses, so the guard has to run first.
        const upload = routes.find(r => r.route === '/api/uploadCookies');
        assert(upload.rest.indexOf('requireAdmin') < upload.rest.indexOf('upload_multer'),
            'requireAdmin must run before multer, or an unauthenticated body is written to disk anyway');
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
