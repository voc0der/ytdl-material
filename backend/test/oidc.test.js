const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const {assert, config_api} = require('./test-shared');
const oidc = require('../authentication/oidc');

const ISSUER = 'https://identity.example.test';
const REDIRECT_URI = 'https://media.example.test/api/auth/oidc/callback';
const CLIENT_ID = 'test-client';
const SUBJECT = 'subject-alice';

describe('OIDC authorization', function() {
    let settings;
    let provider;
    let originalGetConfigItem;
    let originalFetch;
    let originalNow;
    let privateKey;

    before(function() {
        ({privateKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048}));
    });

    beforeEach(async function() {
        originalGetConfigItem = config_api.getConfigItem;
        originalFetch = globalThis.fetch;
        originalNow = Date.now;
        settings = {
            ytdl_oidc_enabled: true,
            ytdl_oidc_issuer_url: ISSUER,
            ytdl_oidc_client_id: CLIENT_ID,
            ytdl_oidc_client_secret: 'test-secret',
            ytdl_oidc_redirect_uri: REDIRECT_URI
        };
        config_api.getConfigItem = key => settings[key];
        provider = {
            requests: [],
            codes: new Map(),
            idClaims: {sub: SUBJECT, preferred_username: 'alice', groups: ['members']},
            userinfo: {sub: SUBJECT, email: 'alice@example.test', groups: ['admins']},
            userinfoStatus: 200,
            tokenError: false
        };

        // Exercise the real client and production module. Only the provider's HTTP
        // responses are simulated; an unexpected request cannot reach the network.
        globalThis.fetch = async (input, options = {}) => {
            const url = new URL(input);
            assert.strictEqual(url.origin, ISSUER);
            provider.requests.push({url, options});
            switch (url.pathname) {
                case '/.well-known/openid-configuration':
                    return Response.json({
                        issuer: ISSUER,
                        authorization_endpoint: ISSUER + '/authorize',
                        token_endpoint: ISSUER + '/token',
                        userinfo_endpoint: ISSUER + '/userinfo',
                        jwks_uri: ISSUER + '/jwks',
                        response_types_supported: ['code'],
                        subject_types_supported: ['public'],
                        id_token_signing_alg_values_supported: ['RS256'],
                        token_endpoint_auth_methods_supported: ['client_secret_post']
                    });
                case '/token': {
                    assert.strictEqual(options.method, 'POST');
                    const body = new URLSearchParams(options.body);
                    assert.strictEqual(body.get('client_id'), CLIENT_ID);
                    assert.strictEqual(body.get('client_secret'), 'test-secret');
                    assert.strictEqual(body.get('redirect_uri'), REDIRECT_URI);
                    assert.strictEqual(body.get('grant_type'), 'authorization_code');
                    const authorization = provider.codes.get(body.get('code'));
                    assert(authorization, 'the callback must exchange the issued code');
                    assert.strictEqual(
                        crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url'),
                        authorization.get('code_challenge'),
                        'the verifier must belong to this authorization request'
                    );
                    if (provider.tokenError) {
                        return Response.json({error: 'invalid_grant'}, {status: 400});
                    }
                    const issuedAt = Math.floor(originalNow() / 1000);
                    const idToken = jwt.sign({
                        iss: ISSUER, aud: CLIENT_ID, iat: issuedAt, exp: issuedAt + 3600,
                        nonce: authorization.get('nonce'), ...provider.idClaims
                    }, privateKey, {algorithm: 'RS256'});
                    return Response.json({
                        access_token: 'test-access-token', token_type: 'Bearer', id_token: idToken
                    });
                }
                case '/userinfo':
                    assert.strictEqual(new Headers(options.headers).get('authorization'), 'Bearer test-access-token');
                    return Response.json(provider.userinfo, {status: provider.userinfoStatus});
                default:
                    assert.fail('Unexpected OIDC request: ' + url.pathname);
            }
        };
        // Reset both initialization and pending transactions between cases.
        settings.ytdl_oidc_enabled = false;
        await oidc.initialize();
        settings.ytdl_oidc_enabled = true;
    });

    afterEach(async function() {
        try {
            settings.ytdl_oidc_enabled = false;
            await oidc.initialize();
        } finally {
            config_api.getConfigItem = originalGetConfigItem;
            globalThis.fetch = originalFetch;
            Date.now = originalNow;
        }
    });

    async function begin(returnTo) {
        const url = new URL(await oidc.createAuthorizationURL(returnTo));
        const code = 'code-' + provider.codes.size;
        provider.codes.set(code, url.searchParams);
        return {url, query: {state: url.searchParams.get('state'), code}};
    }

    const tokenRequests = () => provider.requests.filter(({url}) => url.pathname === '/token');

    it('stays uninitialized without discovering a provider when disabled', async function() {
        settings.ytdl_oidc_enabled = ' FALSE ';
        assert.strictEqual(await oidc.initialize(), true);
        assert.strictEqual(oidc.isEnabled(), false);
        assert.deepStrictEqual(oidc.getStatus(), {enabled: false, initialized: false, auto_register: true});
        assert.deepStrictEqual(provider.requests, []);
        await assert.rejects(oidc.createAuthorizationURL(), /not initialized/);
        await assert.rejects(oidc.consumeAuthorizationCallback({query: {}}), /not initialized/);
    });

    it('normalizes configuration and discovers a provider before reporting ready', async function() {
        settings.ytdl_oidc_enabled = ' TRUE ';
        settings.ytdl_oidc_auto_register = ' false ';
        settings.ytdl_oidc_client_id = ' test-client ';
        settings.ytdl_oidc_client_secret = ' test-secret ';
        settings.ytdl_oidc_issuer_url = ' ' + ISSUER + ' ';
        settings.ytdl_oidc_redirect_uri = ' ' + REDIRECT_URI + ' ';
        assert.strictEqual(await oidc.initialize(), true);
        assert.deepStrictEqual(oidc.getStatus(), {enabled: true, initialized: true, auto_register: false});
        const login = await begin();
        assert.strictEqual(login.url.searchParams.get('client_id'), CLIENT_ID);
        assert.strictEqual(login.url.searchParams.get('scope'), 'openid profile email');
        assert.strictEqual(login.url.searchParams.get('redirect_uri'), REDIRECT_URI);
        await oidc.consumeAuthorizationCallback(login);
    });

    for (const field of ['issuer_url', 'client_id', 'client_secret', 'redirect_uri']) {
        it('rejects missing ' + field + ' before discovery', async function() {
            delete settings['ytdl_oidc_' + field];
            await assert.rejects(oidc.initialize(), /required settings are missing/);
            assert.strictEqual(oidc.getStatus().initialized, false);
            assert.deepStrictEqual(provider.requests, []);
        });
    }

    for (const field of ['issuer_url', 'redirect_uri']) {
        it('rejects malformed or blank ' + field + ' before discovery', async function() {
            for (const value of ['not a URL', '   ']) {
                settings['ytdl_oidc_' + field] = value;
                await assert.rejects(oidc.initialize(), new RegExp('OIDC ' + field));
            }
            assert.deepStrictEqual(provider.requests, []);
        });
    }

    it('does not become ready when discovery fails', async function() {
        globalThis.fetch = async () => { throw new Error('provider unavailable'); };
        await assert.rejects(oidc.initialize());
        assert.strictEqual(oidc.getStatus().initialized, false);
        await assert.rejects(oidc.createAuthorizationURL(), /not initialized/);
    });

    it('binds independent logins to their own state, nonce, PKCE verifier and return path', async function() {
        settings.ytdl_oidc_scope = 'openid profile';
        await oidc.initialize();
        const first = await begin('/subscriptions?sort=name');
        const second = await begin('/home');
        assert.strictEqual(first.url.origin + first.url.pathname, ISSUER + '/authorize');
        assert.strictEqual(first.url.searchParams.get('response_type'), 'code');
        assert.strictEqual(first.url.searchParams.get('code_challenge_method'), 'S256');
        assert.strictEqual(first.url.searchParams.get('scope'), 'openid profile');
        for (const key of ['state', 'nonce', 'code_challenge']) {
            assert(first.url.searchParams.get(key));
            assert.notStrictEqual(first.url.searchParams.get(key), second.url.searchParams.get(key));
        }
        assert.strictEqual(first.url.searchParams.has('client_secret'), false);
        assert.strictEqual(first.url.searchParams.has('code_verifier'), false);
        // Finishing in reverse order must not mix up either browser's transaction.
        assert.strictEqual((await oidc.consumeAuthorizationCallback(second)).return_to, '/home');
        const result = await oidc.consumeAuthorizationCallback(first);
        assert.strictEqual(result.return_to, '/subscriptions?sort=name');
        assert.strictEqual(result.claims.email, 'alice@example.test');
        assert.deepStrictEqual(result.claims.groups, ['members'], 'ID token claims take precedence over userinfo');
        assert.strictEqual(tokenRequests().length, 2);
    });

    it('defaults external and malformed return paths to the home page', async function() {
        await oidc.initialize();
        for (const returnTo of [undefined, null, '', 42, 'home', '//evil.example', 'https://evil.example']) {
            const login = await begin(returnTo);
            assert.strictEqual((await oidc.consumeAuthorizationCallback(login)).return_to, '/home');
        }
        const login = await begin(' /subscriptions ');
        assert.strictEqual((await oidc.consumeAuthorizationCallback(login)).return_to, '/subscriptions');
    });

    it('rejects unknown or absent state without exchanging a code', async function() {
        await oidc.initialize();
        for (const request of [undefined, {}, {query: {}}, {query: {state: null}}, {query: {state: 'unknown'}}]) {
            await assert.rejects(oidc.consumeAuthorizationCallback(request), /missing or invalid state/);
        }
        assert.strictEqual(tokenRequests().length, 0);
    });

    it('consumes a successful callback only once', async function() {
        await oidc.initialize();
        const login = await begin();
        await oidc.consumeAuthorizationCallback(login);
        await assert.rejects(oidc.consumeAuthorizationCallback(login), /missing or invalid state/);
        assert.strictEqual(tokenRequests().length, 1);
    });

    it('allows only one of two concurrent callbacks to exchange the same code', async function() {
        await oidc.initialize();
        const login = await begin();
        const results = await Promise.allSettled([
            oidc.consumeAuthorizationCallback(login), oidc.consumeAuthorizationCallback(login)
        ]);
        assert.strictEqual(results[0].status, 'fulfilled');
        assert.strictEqual(results[1].status, 'rejected');
        assert.match(results[1].reason.message, /missing or invalid state/);
        assert.strictEqual(tokenRequests().length, 1);
    });

    it('consumes a cancelled login without exchanging a code', async function() {
        await oidc.initialize();
        const login = await begin();
        const cancelled = {query: {state: login.query.state, error: 'access_denied'}};
        await assert.rejects(oidc.consumeAuthorizationCallback(cancelled), {error: 'access_denied'});
        await assert.rejects(oidc.consumeAuthorizationCallback(login), /missing or invalid state/);
        assert.strictEqual(tokenRequests().length, 0);
    });

    it('rejects transactions older than ten minutes without exchanging a code', async function() {
        await oidc.initialize();
        const now = originalNow();
        Date.now = () => now;
        const login = await begin();
        Date.now = () => now + 10 * 60 * 1000 + 1;
        await assert.rejects(oidc.consumeAuthorizationCallback(login), /missing or invalid state/);
        assert.strictEqual(tokenRequests().length, 0);
        // Expiring an old transaction must leave newly issued ones usable.
        const fresh = await begin();
        assert.strictEqual((await oidc.consumeAuthorizationCallback(fresh)).return_to, '/home');
    });

    it('revokes pending transactions when OIDC is disabled and re-enabled', async function() {
        await oidc.initialize();
        const login = await begin();
        settings.ytdl_oidc_enabled = false;
        await oidc.initialize();
        settings.ytdl_oidc_enabled = true;
        await oidc.initialize();
        await assert.rejects(oidc.consumeAuthorizationCallback(login), /missing or invalid state/);
        assert.strictEqual(tokenRequests().length, 0);
    });

    it('consumes state even when the provider refuses the authorization code', async function() {
        await oidc.initialize();
        const login = await begin();
        provider.tokenError = true;
        await assert.rejects(oidc.consumeAuthorizationCallback(login), {error: 'invalid_grant'});
        provider.tokenError = false;
        await assert.rejects(oidc.consumeAuthorizationCallback(login), /missing or invalid state/);
        assert.strictEqual(tokenRequests().length, 1);
    });

    for (const [claim, value] of [['nonce', 'wrong-nonce'], ['aud', 'another-client'], ['iss', 'https://other.example.test']]) {
        it('rejects an ID token with a different ' + claim, async function() {
            await oidc.initialize();
            const login = await begin();
            provider.idClaims[claim] = value;
            await assert.rejects(oidc.consumeAuthorizationCallback(login), {code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED'});
            assert.strictEqual(provider.requests.some(({url}) => url.pathname === '/userinfo'), false);
            await assert.rejects(oidc.consumeAuthorizationCallback(login), /missing or invalid state/);
        });
    }

    it('falls back to ID token claims when userinfo is unavailable', async function() {
        await oidc.initialize();
        provider.userinfoStatus = 503;
        const result = await oidc.consumeAuthorizationCallback(await begin());
        assert.strictEqual(result.claims.sub, SUBJECT);
        assert.strictEqual(result.claims.preferred_username, 'alice');
        assert.strictEqual(result.claims.email, undefined);
        assert.deepStrictEqual(result.claims.groups, ['members']);
    });

    it('discards userinfo belonging to a different subject', async function() {
        await oidc.initialize();
        provider.userinfo = {sub: 'someone-else', email: 'wrong@example.test', groups: ['admins']};
        const result = await oidc.consumeAuthorizationCallback(await begin());
        assert.strictEqual(result.claims.sub, SUBJECT);
        assert.strictEqual(result.claims.email, undefined);
        assert.deepStrictEqual(result.claims.groups, ['members']);
    });

    describe('Group restrictions', function() {
        it('allows any claims when no groups are configured', function() {
            assert.strictEqual(oidc.isClaimsAllowed({}), true);
        });

        for (const groups of [[' readers ', 'EDITORS'], 'readers, EDITORS', 'editors']) {
            it('matches nested group claims encoded as ' + JSON.stringify(groups), function() {
                settings.ytdl_oidc_group_claim = 'realm.roles';
                settings.ytdl_oidc_allowed_groups = ' admins, Editors, ';
                assert.strictEqual(oidc.isClaimsAllowed({realm: {roles: groups}}), true);
            });
        }

        it('requires an exact group match and refuses missing or unrelated nested claims', function() {
            settings.ytdl_oidc_group_claim = 'realm.roles';
            settings.ytdl_oidc_allowed_groups = [' admins ', '', 'editors'];
            for (const claims of [null, {}, {realm: null}, {realm: 'editors'},
                {realm: {roles: []}}, {realm: {roles: 'superadmins'}}, {realm: {roles: ' '}}]) {
                assert.strictEqual(oidc.isClaimsAllowed(claims), false);
            }
            assert.deepStrictEqual(oidc.getConfiguration().allowed_groups, ['admins', 'editors']);
        });
    });
});
