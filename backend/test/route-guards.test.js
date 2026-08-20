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

    /*************************************************
     * The spec is the contract generated clients are
     * built from, so a wrong security declaration is
     * a real defect: it makes a client send a token
     * where none is wanted, or omit one where it is
     * required.
     *
     * The earlier version of this check only looked at
     * which scheme *names* the spec referenced, which
     * passed happily while login, registration, the
     * RSS feed and every shared-playback route all
     * declared a JWT as mandatory, and while eight
     * guarded task and backup operations declared no
     * security at all.
     ************************************************/
    describe('against the published specification', function() {
        const HTTP_VERBS = new Set(ROUTE_VERBS.split('|'));

        // Parsed inside each test rather than in the describe body. A spec that will not
        // parse is exactly the failure these tests exist to report, and doing it out here
        // would abort the whole file at load time instead.
        function loadSpec() {
            const yaml = require('js-yaml');
            return yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'Public API v1.yaml'), 'utf8'));
        }

        function documentedOperations(spec) {
            const operations = [];
            for (const [route, path_item] of Object.entries(spec.paths)) {
                for (const [verb, operation] of Object.entries(path_item)) {
                    if (HTTP_VERBS.has(verb)) operations.push({route, verb, operation});
                }
            }
            return operations;
        }

        // security: [] and a requirement list containing {} both mean "a caller with no
        // credentials gets an answer". The difference is whether a token is meaningful at
        // all, which is why both spellings appear in the spec.
        function allowsAnonymous(operation) {
            if (!Array.isArray(operation.security)) return false;
            if (operation.security.length === 0) return true;
            return operation.security.some(requirement => Object.keys(requirement).length === 0);
        }

        it('documents only routes the server actually serves', function() {
            const spec = loadSpec();
            const defined_routes = new Set(routes.map(r => r.route));
            const phantom = Object.keys(spec.paths).filter(route => !defined_routes.has(route));

            assert.deepStrictEqual(phantom, [],
                'these are documented but not implemented -- a generated client would call them and get a 404');
        });

        it('gives every documented operation an explicit security declaration', function() {
            const undeclared = documentedOperations(loadSpec())
                .filter(({operation}) => !Array.isArray(operation.security))
                .map(({verb, route}) => `${verb.toUpperCase()} ${route}`);

            assert.deepStrictEqual(undeclared, [],
                'an operation with no security key inherits the document default, which is "none"');
        });

        it('requires a token on every route the server guards', function() {
            const understated = documentedOperations(loadSpec()).filter(({route, operation}) => {
                if (Object.prototype.hasOwnProperty.call(INTENTIONALLY_UNAUTHENTICATED, route)) return false;
                if (SHARED_LINK_ROUTES.includes(route)) return false;
                return allowsAnonymous(operation);
            });

            assert.deepStrictEqual(understated.map(o => `${o.verb.toUpperCase()} ${o.route}`), [],
                'these routes are guarded but the spec says a caller needs no credentials');
        });

        it('does not demand a token on the routes that answer without one', function() {
            const overstated = documentedOperations(loadSpec()).filter(({route, operation}) => {
                const is_public = Object.prototype.hasOwnProperty.call(INTENTIONALLY_UNAUTHENTICATED, route);
                const is_shared = SHARED_LINK_ROUTES.includes(route);
                if (!is_public && !is_shared) return false;
                return !allowsAnonymous(operation);
            });

            assert.deepStrictEqual(overstated.map(o => `${o.verb.toUpperCase()} ${o.route}`), [],
                'these routes answer an anonymous caller -- a share link, a login, or single-user '
                + 'mode -- and the spec must not declare a token as mandatory');
        });

        it('names only schemes the specification defines', function() {
            const spec = loadSpec();
            const defined = new Set(Object.keys(spec.components.securitySchemes));
            const undefined_schemes = new Set();
            for (const {operation} of documentedOperations(spec)) {
                for (const requirement of operation.security || []) {
                    Object.keys(requirement).filter(name => !defined.has(name)).forEach(name => undefined_schemes.add(name));
                }
            }

            assert.deepStrictEqual([...undefined_schemes], []);
        });
    });

    it('keeps user and server management restricted to administrators', function() {
        const must_be_admin = [
            '/api/setConfig', '/api/restartServer', '/api/transferDB', '/api/restoreDBBackup',
            '/api/getUsers', '/api/getRoles', '/api/updateUser', '/api/deleteUser',
            '/api/changeUserPermissions', '/api/changeRolePermissions',
            '/api/updateServer', '/api/logs', '/api/clearAllLogs'
        ];

        for (const route of must_be_admin) {
            const definition = routes.find(r => r.route === route);
            assert(definition, `expected ${route} to exist`);
            assert(definition.rest.includes('requireAdmin'), `${route} must be behind requireAdmin`);
        }
    });

    it('keeps API-token management behind a browser JWT', function() {
        for (const route of ['/api/listAPITokens', '/api/generateAPIToken', '/api/revokeAPIToken']) {
            const definition = routes.find(r => r.route === route);
            assert(definition, `expected ${route} to exist`);
            assert(definition.rest.includes('requireAuthenticated'));
            assert(definition.rest.includes('requireJwtForTokenManagement'));
        }
    });

    it('scopes an RSS feed from the credential, never a requested uid', function() {
        const route_start = APP_SOURCE.indexOf("app.get('/api/rss'");
        const route_end = APP_SOURCE.indexOf('// web server', route_start);
        const handler = APP_SOURCE.slice(route_start, route_end);

        assert(route_start >= 0 && route_end > route_start, 'expected to find the RSS handler');
        assert(handler.includes('req.user.uid'), 'the RSS handler must use its authenticated owner');
        assert(!handler.includes('req.query.uuid'), 'a caller must not be able to select another owner');
    });
});
