const express = require('express');
const request = require('supertest');

const { assert, config_api, db_api } = require('./test-shared');
const library_sharing = require('../authentication/library-sharing');
const { resolveLibraryOwner, libraryOwnerUid } = library_sharing;

// Mounted on a bare express app with a stand-in for the user optionalJwt would have
// attached, the way the permission guards are tested. The route answers with whose
// library it would have read from.
function appReadingLibraryAs(user) {
    const app = express();
    app.use((req, res, next) => {
        if (user) req.user = user;
        next();
    });
    app.get('/read', resolveLibraryOwner, (req, res) => res.send({owner: libraryOwnerUid(req)}));
    return app;
}

describe('Library sharing', function() {
    const original_getConfigItem = config_api.getConfigItem;
    let multi_user_mode = true;

    const VIEWER = {uid: 'library_viewer', name: 'Viewer'};
    const SHARER = {uid: 'library_sharer', name: 'Bob'};
    const PRIVATE = {uid: 'library_private', name: 'Private'};
    const ALL_USERS = [VIEWER, SHARER, PRIVATE];

    before(function() {
        config_api.getConfigItem = (key) => key === 'ytdl_multi_user_mode' ? multi_user_mode : original_getConfigItem(key);
    });

    after(async function() {
        config_api.getConfigItem = original_getConfigItem;
        for (const user of ALL_USERS) await db_api.removeAllRecords('users', {uid: user.uid});
    });

    beforeEach(async function() {
        multi_user_mode = true;
        for (const user of ALL_USERS) {
            await db_api.removeAllRecords('users', {uid: user.uid});
            await db_api.insertRecordIntoTable('users', {...user, passhash: 'not-a-real-hash', role: 'user'});
        }
        await library_sharing.setLibrarySharing(SHARER.uid, true);
    });

    describe('resolveLibraryOwner', function() {
        it('reads the caller\'s own library when no library is named', async function() {
            const res = await request(appReadingLibraryAs(VIEWER)).get('/read').expect(200);
            assert.strictEqual(res.body.owner, VIEWER.uid);
        });

        it('reads the caller\'s own library when they name it', async function() {
            const res = await request(appReadingLibraryAs(VIEWER)).get('/read').query({library: VIEWER.uid}).expect(200);
            assert.strictEqual(res.body.owner, VIEWER.uid);
        });

        it('reads a library its owner shares', async function() {
            const res = await request(appReadingLibraryAs(VIEWER)).get('/read').query({library: SHARER.uid}).expect(200);
            assert.strictEqual(res.body.owner, SHARER.uid);
        });

        it('refuses a library its owner does not share', async function() {
            const res = await request(appReadingLibraryAs(VIEWER)).get('/read').query({library: PRIVATE.uid}).expect(403);
            assert.strictEqual(res.body.success, false);
        });

        it('stops reading a library once its owner stops sharing it', async function() {
            await library_sharing.setLibrarySharing(SHARER.uid, false);
            await request(appReadingLibraryAs(VIEWER)).get('/read').query({library: SHARER.uid}).expect(403);
        });

        it('gives an unknown owner the same answer as a private one', async function() {
            // Otherwise the parameter would say which uids exist.
            await request(appReadingLibraryAs(VIEWER)).get('/read').query({library: 'library_nobody'}).expect(403);
        });

        it('refuses a caller who is not signed in', async function() {
            // A share link gets through optionalJwt with no user; it is not a way in here.
            await request(appReadingLibraryAs(null)).get('/read').query({library: SHARER.uid}).expect(401);
        });

        it('refuses more than one library at once', async function() {
            await request(appReadingLibraryAs(VIEWER)).get(`/read?library=${SHARER.uid}&library=${VIEWER.uid}`).expect(400);
        });

        it('ignores the parameter in single-user mode, which has one library', async function() {
            multi_user_mode = false;
            const res = await request(appReadingLibraryAs(null)).get('/read').query({library: PRIVATE.uid}).expect(200);
            assert.strictEqual(res.body.owner, null);
        });
    });

    describe('getSharedLibraries', function() {
        it('lists the other accounts that share, by uid and name only', async function() {
            const libraries = await library_sharing.getSharedLibraries(VIEWER.uid);
            const ours = libraries.filter(library => ALL_USERS.some(user => user.uid === library.uid));

            assert.deepStrictEqual(ours, [{uid: SHARER.uid, name: SHARER.name}]);
        });

        it('leaves out the caller\'s own library', async function() {
            const libraries = await library_sharing.getSharedLibraries(SHARER.uid);
            assert(!libraries.some(library => library.uid === SHARER.uid));
        });

        it('lists nothing in single-user mode', async function() {
            multi_user_mode = false;
            assert.deepStrictEqual(await library_sharing.getSharedLibraries(null), []);
        });
    });

    describe('setLibrarySharing', function() {
        it('turns sharing on and off', async function() {
            await library_sharing.setLibrarySharing(PRIVATE.uid, true);
            assert.strictEqual((await db_api.getRecord('users', {uid: PRIVATE.uid})).library_shared, true);

            await library_sharing.setLibrarySharing(PRIVATE.uid, false);
            assert.strictEqual((await db_api.getRecord('users', {uid: PRIVATE.uid})).library_shared, false);
        });

        it('does not create a record for an account that does not exist', async function() {
            assert.strictEqual(await library_sharing.setLibrarySharing('library_nobody', true), false);
            assert(!await db_api.getRecord('users', {uid: 'library_nobody'}));
        });
    });
});
