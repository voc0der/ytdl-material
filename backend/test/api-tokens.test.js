/* eslint-disable no-undef */
const express = require('express');
const request = require('supertest');

const { assert, auth_api, config_api, db_api } = require('./test-shared');
const api_tokens_api = require('../authentication/api-tokens');
const { optionalJwt, requireJwtForTokenManagement } = require('../authentication/optional-jwt');

/*************************************************
 * Per-user API tokens: the replacement for the
 * Public API key, which was one value for the whole
 * server, shipped as a default nobody changed, and
 * did not identify the caller.
 *
 * The properties worth pinning are all about what a
 * token is *not* allowed to be: not somebody else's,
 * not recoverable after generation, not readable out
 * of the database, and not outliving its account.
 ************************************************/

const OWNER = 'token_owner';
const OTHER = 'token_other';

function appUsing() {
    const app = express();
    app.use(express.json());
    app.use(auth_api.passport.initialize());
    app.use(optionalJwt);
    app.all('/api/whoami', (req, res) => res.send({uid: req.user ? req.user.uid : null}));
    app.all('/api/rss', (req, res) => res.send({uid: req.user ? req.user.uid : null}));
    app.all('/api/manage-token', requireJwtForTokenManagement, (req, res) => res.sendStatus(204));
    return app;
}

describe('Per-user API tokens', function() {
    const original_getConfigItem = config_api.getConfigItem;

    before(async function() {
        config_api.getConfigItem = (key) =>
            key === 'ytdl_multi_user_mode' ? true : original_getConfigItem(key);
        for (const uid of [OWNER, OTHER]) {
            await db_api.removeRecord('users', {uid: uid});
            await db_api.insertRecordIntoTable('users', {uid: uid, name: uid, role: 'user'});
        }
    });

    after(async function() {
        config_api.getConfigItem = original_getConfigItem;
        for (const uid of [OWNER, OTHER]) {
            await api_tokens_api.revokeAllTokensForUser(uid);
            await db_api.removeRecord('users', {uid: uid});
        }
    });

    beforeEach(async function() {
        await api_tokens_api.revokeAllTokensForUser(OWNER);
        await api_tokens_api.revokeAllTokensForUser(OTHER);
    });

    describe('Generation', function() {
        it('returns the token once and never again', async function() {
            const generated = await api_tokens_api.generateTokenForUser(OWNER, 'backup script');
            assert(generated.token, 'generation must return the token itself');

            const listed = await api_tokens_api.listTokensForUser(OWNER);
            assert.strictEqual(listed.length, 1);
            assert.strictEqual(listed[0].token, undefined, 'listing must never hand the token back');
            assert.strictEqual(listed[0].label, 'backup script');
        });

        it('does not store the token itself', async function() {
            const generated = await api_tokens_api.generateTokenForUser(OWNER, 'stored');
            const stored = await db_api.getRecords('api_tokens', {user_uid: OWNER});

            assert.strictEqual(stored.length, 1);
            assert.strictEqual(stored[0].token, undefined);
            assert.notStrictEqual(stored[0].hash, generated.token,
                'a database read must not yield a working credential');
            assert(!JSON.stringify(stored[0]).includes(generated.token));
        });

        it('caps how many one account may hold', async function() {
            for (let i = 0; i < api_tokens_api.MAX_TOKENS_PER_USER; i++) {
                assert((await api_tokens_api.generateTokenForUser(OWNER, `t${i}`)).token);
            }

            const refused = await api_tokens_api.generateTokenForUser(OWNER, 'one too many');
            assert(refused.error, 'the limit must refuse rather than grow without bound');
            assert.strictEqual(refused.token, undefined);
        });

        it('refuses an unknown token type', async function() {
            const refused = await api_tokens_api.generateTokenForUser(OWNER, 'bad', 'administrator');
            assert(refused.error);
            assert.deepStrictEqual(await api_tokens_api.listTokensForUser(OWNER), []);
        });
    });

    describe('Resolution', function() {
        it('resolves to the account it was generated for', async function() {
            const {token} = await api_tokens_api.generateTokenForUser(OWNER, 'mine');
            const user = await api_tokens_api.resolveToken(token);

            assert(user);
            assert.strictEqual(user.uid, OWNER);
        });

        it('refuses anything that is not a token', async function() {
            for (const bad of [null, undefined, '', 'not-a-token', 'ytdl_', 'ytdl_wrong', 42, {}]) {
                assert.strictEqual(await api_tokens_api.resolveToken(bad), null);
            }
        });

        it('records when it was last used', async function() {
            const {token, id} = await api_tokens_api.generateTokenForUser(OWNER, 'used');
            assert.strictEqual((await api_tokens_api.listTokensForUser(OWNER))[0].last_used, null);

            await api_tokens_api.resolveToken(token);
            // The write is deliberately not awaited by resolveToken, so give it a turn.
            await new Promise(resolve => setTimeout(resolve, 50));

            const updated = (await api_tokens_api.listTokensForUser(OWNER)).find(t => t.id === id);
            assert(updated.last_used, 'a token nobody can see the age of cannot be pruned safely');
        });

        it('keeps an RSS token from authenticating the rest of the API', async function() {
            const {token} = await api_tokens_api.generateTokenForUser(
                OWNER, 'feed', api_tokens_api.TOKEN_TYPES.RSS);

            assert.strictEqual(await api_tokens_api.resolveToken(token), null);
            const user = await api_tokens_api.resolveToken(token, [api_tokens_api.TOKEN_TYPES.RSS]);
            assert.strictEqual(user.uid, OWNER);
        });
    });

    describe('Revocation', function() {
        it('stops the token working', async function() {
            const {token, id} = await api_tokens_api.generateTokenForUser(OWNER, 'doomed');
            assert(await api_tokens_api.resolveToken(token));

            assert.strictEqual(await api_tokens_api.revokeTokenForUser(OWNER, id), true);
            assert.strictEqual(await api_tokens_api.resolveToken(token), null);
        });

        it('refuses to revoke a token belonging to somebody else', async function() {
            const {token, id} = await api_tokens_api.generateTokenForUser(OWNER, 'not yours');

            assert.strictEqual(await api_tokens_api.revokeTokenForUser(OTHER, id), false);
            assert(await api_tokens_api.resolveToken(token), 'the token must still work');
        });

        it('does not let a token outlive its account', async function() {
            const {token} = await api_tokens_api.generateTokenForUser(OWNER, 'orphan');
            await db_api.removeRecord('users', {uid: OWNER});

            assert.strictEqual(await api_tokens_api.resolveToken(token), null);
            assert.deepStrictEqual(await db_api.getRecords('api_tokens', {user_uid: OWNER}), [],
                'the orphaned record should be cleaned up rather than left resolving to nothing');

            await db_api.insertRecordIntoTable('users', {uid: OWNER, name: OWNER, role: 'user'});
        });
    });

    describe('Through the middleware', function() {
        it('authenticates a request in the query string', async function() {
            const {token} = await api_tokens_api.generateTokenForUser(OWNER, 'query');

            const res = await request(appUsing()).get(`/api/whoami?apiToken=${encodeURIComponent(token)}`).expect(200);

            assert.strictEqual(res.body.uid, OWNER);
        });

        it('authenticates a request in a header, so it stays out of access logs', async function() {
            const {token} = await api_tokens_api.generateTokenForUser(OWNER, 'header');

            const res = await request(appUsing()).get('/api/whoami').set('x-api-token', token).expect(200);

            assert.strictEqual(res.body.uid, OWNER);
        });

        it('accepts an RSS token only on the RSS route', async function() {
            const {token} = await api_tokens_api.generateTokenForUser(
                OWNER, 'feed', api_tokens_api.TOKEN_TYPES.RSS);

            await request(appUsing()).get('/api/whoami').set('x-api-token', token).expect(401);
            const res = await request(appUsing()).get('/api/rss').set('x-api-token', token).expect(200);
            assert.strictEqual(res.body.uid, OWNER);
        });

        it('does not let one API token mint or manage another', async function() {
            const {token} = await api_tokens_api.generateTokenForUser(OWNER, 'limited lifetime');

            await request(appUsing()).get('/api/manage-token').set('x-api-token', token).expect(403);
        });

        it('refuses a bad token rather than falling through as anonymous', async function() {
            // Falling through would hand the request to a route that then has to decide what
            // an unauthenticated caller may do -- which is the mistake the guards exist to stop.
            await request(appUsing()).get('/api/whoami?apiToken=ytdl_nonsense').expect(401);
        });

        it('still refuses a request with no credential at all', async function() {
            await request(appUsing()).get('/api/whoami').expect(401);
        });

        it('refuses a revoked token', async function() {
            const {token, id} = await api_tokens_api.generateTokenForUser(OWNER, 'revoked');
            await api_tokens_api.revokeTokenForUser(OWNER, id);

            await request(appUsing()).get(`/api/whoami?apiToken=${encodeURIComponent(token)}`).expect(401);
        });
    });
});
