/* eslint-disable no-undef */
const express = require('express');
const request = require('supertest');

const { assert, auth_api, config_api, db_api } = require('./test-shared');
const { optionalJwt, resolveJwtIfPresent } = require('../authentication/optional-jwt');

/*************************************************
 * optionalJwt is what every guard depends on: it
 * decides whether req.user exists at all. It used
 * to live as a closure inside app.js, so the only
 * way to reach it was to boot the whole
 * application -- and consequently nothing did.
 *
 * That gap hid a real bug. A repair to the
 * registration route read req.user on a path where
 * optionalJwt skipped Passport entirely, so the
 * repair never once executed, and the guard tests
 * could not see it because they fabricate req.user
 * themselves.
 ************************************************/
function appUsing(route_path) {
    const app = express();
    app.use(express.json());
    app.use(auth_api.passport.initialize());
    app.use(optionalJwt);
    app.all(route_path, (req, res) => res.send({
        uid: req.user ? req.user.uid : null,
        can_watch: !!req.can_watch
    }));
    return app;
}

function appResolving(route_path) {
    const app = express();
    app.use(express.json());
    app.use(auth_api.passport.initialize());
    app.use(resolveJwtIfPresent);
    app.all(route_path, (req, res) => res.send({
        uid: req.user ? req.user.uid : null,
        authenticated: !!(req.isAuthenticated && req.isAuthenticated())
    }));
    return app;
}

describe('optionalJwt', function() {
    const original_getConfigItem = config_api.getConfigItem;
    let multi_user_mode = true;

    const CALLER = 'optional_jwt_caller';
    let token = null;

    before(async function() {
        config_api.getConfigItem = (key) =>
            key === 'ytdl_multi_user_mode' ? multi_user_mode : original_getConfigItem(key);

        // Sets up the JWT strategy and the server secret both sides of this need.
        auth_api.initialize();

        await db_api.removeAllRecords('users', {uid: CALLER});
        await auth_api.registerUser(CALLER, CALLER, 'optional-jwt-password');
        token = auth_api.createJWTForUser(CALLER);
    });

    after(async function() {
        config_api.getConfigItem = original_getConfigItem;
        await db_api.removeAllRecords('users', {uid: CALLER});
    });

    describe('An ordinary API path', function() {
        it('refuses a caller with no token', async function() {
            await request(appUsing('/api/getFile')).post('/api/getFile').expect(401);
        });

        it('resolves a valid token to a user', async function() {
            const res = await request(appUsing('/api/getFile'))
                .post('/api/getFile').query({jwt: token}).expect(200);

            assert.strictEqual(res.body.uid, CALLER);
        });

        it('refuses a token that does not verify', async function() {
            await request(appUsing('/api/getFile'))
                .post('/api/getFile').query({jwt: 'not-a-real-token'}).expect(401);
        });
    });

    describe('A public auth path', function() {
        // The bug this file exists for. Registration is open to strangers, but it is also
        // how an administrator adds an account -- the same endpoint with a token attached.
        it('resolves a token when one is offered', async function() {
            const res = await request(appUsing('/api/auth/register'))
                .post('/api/auth/register').query({jwt: token}).expect(200);

            assert.strictEqual(res.body.uid, CALLER,
                'a token on a public auth path must still identify the caller');
        });

        it('lets an anonymous caller through', async function() {
            const res = await request(appUsing('/api/auth/register'))
                .post('/api/auth/register').expect(200);

            assert.strictEqual(res.body.uid, null);
        });

        it('treats a bad token as anonymous rather than refusing', async function() {
            // Registration must keep working for strangers even if a stale token is sent.
            const res = await request(appUsing('/api/auth/register'))
                .post('/api/auth/register').query({jwt: 'not-a-real-token'}).expect(200);

            assert.strictEqual(res.body.uid, null);
        });
    });

    describe('Share links', function() {
        const SHARED_FILE = 'optional_jwt_shared_file';

        beforeEach(async function() {
            await db_api.removeAllRecords('files', {uid: SHARED_FILE});
            await db_api.insertRecordIntoTable('files', {
                uid: SHARED_FILE, user_uid: CALLER, sharingEnabled: true
            });
        });

        after(async function() {
            await db_api.removeAllRecords('files', {uid: SHARED_FILE});
        });

        it('lets a valid share through with can_watch and no user', async function() {
            const res = await request(appUsing('/api/stream'))
                .get('/api/stream').query({uuid: CALLER, uid: SHARED_FILE}).expect(200);

            assert.strictEqual(res.body.can_watch, true);
            assert.strictEqual(res.body.uid, null);
        });

        it('refuses a share for a file that is not shared', async function() {
            await db_api.updateRecord('files', {uid: SHARED_FILE}, {sharingEnabled: false});

            await request(appUsing('/api/stream'))
                .get('/api/stream').query({uuid: CALLER, uid: SHARED_FILE}).expect(401);
        });

        // '/api/getFile' was matched as a substring, so a share link also satisfied
        // '/api/getFileFormats' -- and '/api/getPlaylist' satisfied '/api/getPlaylists'.
        it('does not treat getFileFormats as a shareable path', async function() {
            await request(appUsing('/api/getFileFormats'))
                .post('/api/getFileFormats').query({uuid: CALLER, uid: SHARED_FILE}).expect(401);
        });

        /*************************************************
         * A shared playlist used to authorize the
         * playlist and nothing else -- optionalJwt
         * checked that the playlist was shared, then
         * /api/stream happily served any file uid
         * belonging to the same user.
         ************************************************/
        describe('A shared playlist', function() {
            const PLAYLIST_ID = 'optional_jwt_shared_playlist';
            const MEMBER_FILE = 'optional_jwt_playlist_member';
            const PRIVATE_FILE = 'optional_jwt_private_file';

            beforeEach(async function() {
                for (const uid of [MEMBER_FILE, PRIVATE_FILE]) {
                    await db_api.removeAllRecords('files', {uid: uid});
                    await db_api.insertRecordIntoTable('files', {
                        uid: uid, user_uid: CALLER, sharingEnabled: false
                    });
                }
                await db_api.removeAllRecords('playlists', {id: PLAYLIST_ID});
                await db_api.insertRecordIntoTable('playlists', {
                    id: PLAYLIST_ID, user_uid: CALLER, sharingEnabled: true, uids: [MEMBER_FILE]
                });
            });

            after(async function() {
                await db_api.removeAllRecords('playlists', {id: PLAYLIST_ID});
                for (const uid of [MEMBER_FILE, PRIVATE_FILE]) {
                    await db_api.removeAllRecords('files', {uid: uid});
                }
            });

            it('authorizes a file that is in it', async function() {
                const res = await request(appUsing('/api/stream'))
                    .get('/api/stream')
                    .query({uuid: CALLER, playlist_id: PLAYLIST_ID, uid: MEMBER_FILE})
                    .expect(200);

                assert.strictEqual(res.body.can_watch, true);
            });

            it('refuses a file that is not in it', async function() {
                await request(appUsing('/api/stream'))
                    .get('/api/stream')
                    .query({uuid: CALLER, playlist_id: PLAYLIST_ID, uid: PRIVATE_FILE})
                    .expect(401);
            });

            it('refuses that file\'s subtitles too', async function() {
                await request(appUsing('/api/streamSubtitle'))
                    .get('/api/streamSubtitle')
                    .query({uuid: CALLER, playlist_id: PLAYLIST_ID, uid: PRIVATE_FILE})
                    .expect(401);
            });

            it('still authorizes a request for the playlist itself', async function() {
                // No uid means the caller is asking for the playlist, which is the share.
                const res = await request(appUsing('/api/getPlaylist'))
                    .post('/api/getPlaylist')
                    .query({uuid: CALLER, playlist_id: PLAYLIST_ID})
                    .expect(200);

                assert.strictEqual(res.body.can_watch, true);
            });
        });

        it('does not treat getPlaylists as a shareable path', async function() {
            await request(appUsing('/api/getPlaylists'))
                .post('/api/getPlaylists').query({uuid: CALLER, uid: SHARED_FILE}).expect(401);
        });
    });

    /*************************************************
     * A route with no jwt middleware at all sees
     * req.isAuthenticated() as false for everybody,
     * logged-in users included -- passport populates
     * req.user only where something ran the strategy.
     * incrementViewCount was written that way and
     * then taught to refuse callers it could not
     * identify, which was every one of them.
     ************************************************/
    describe('resolveJwtIfPresent', function() {
        it('identifies a caller who offers a token', async function() {
            const res = await request(appResolving('/api/incrementViewCount'))
                .post('/api/incrementViewCount').query({jwt: token}).expect(200);

            assert.strictEqual(res.body.uid, CALLER);
            assert.strictEqual(res.body.authenticated, true);
        });

        it('lets an anonymous caller through rather than refusing', async function() {
            // A share link carries no token, and playback state has to keep working.
            const res = await request(appResolving('/api/incrementViewCount'))
                .post('/api/incrementViewCount').expect(200);

            assert.strictEqual(res.body.uid, null);
        });

        it('treats a bad token as anonymous rather than refusing', async function() {
            const res = await request(appResolving('/api/incrementViewCount'))
                .post('/api/incrementViewCount').query({jwt: 'not-a-real-token'}).expect(200);

            assert.strictEqual(res.body.uid, null);
        });
    });

    describe('Single-user mode', function() {
        it('asks nothing of anybody', async function() {
            multi_user_mode = false;
            try {
                const res = await request(appUsing('/api/getFile')).post('/api/getFile').expect(200);
                assert.strictEqual(res.body.uid, null);
            } finally {
                multi_user_mode = true;
            }
        });
    });
});
