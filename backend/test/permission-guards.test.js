/* eslint-disable no-undef */
const express = require('express');
const request = require('supertest');

const { assert, auth_api, config_api, db_api } = require('./test-shared');
const { requireAdmin, requirePermission, requireAuthenticated, requireAuthenticatedOrShared } = require('../authentication/permissions');

// The guards are middleware, so they are exercised as middleware: mounted on a bare
// express app with a stand-in for the user optionalJwt would have attached. Requiring the
// real app.js is not an option -- it boots the whole application, socket and all.
function appGuardedBy(guard, user, {can_watch = false} = {}) {
    const app = express();
    app.use((req, res, next) => {
        if (user) req.user = user;
        if (can_watch) req.can_watch = true;
        next();
    });
    app.get('/guarded', guard, (req, res) => res.send({reached: true}));
    return app;
}

describe('Permission guards', function() {
    const original_getConfigItem = config_api.getConfigItem;
    let multi_user_mode = true;

    const ROLE_KEY = 'guard_test_role';
    const ADMIN = {uid: 'guard_admin', name: 'guard_admin', role: 'admin', permissions: [], permission_overrides: []};
    const MEMBER = {uid: 'guard_member', name: 'guard_member', role: ROLE_KEY, permissions: [], permission_overrides: []};

    before(async function() {
        config_api.getConfigItem = (key) => key === 'ytdl_multi_user_mode' ? multi_user_mode : original_getConfigItem(key);

        await db_api.removeAllRecords('roles', {key: ROLE_KEY});
        await db_api.insertRecordIntoTable('roles', {key: ROLE_KEY, permissions: ['filemanager']});
        // The admin role is seeded by setupRoles in the real app; make sure it exists here.
        if (!await db_api.getRecord('roles', {key: 'admin'})) {
            await db_api.insertRecordIntoTable('roles', {key: 'admin', permissions: ['filemanager', 'settings', 'subscriptions', 'sharing', 'advanced_download', 'downloads_manager', 'tasks_manager']});
        }
        for (const user of [ADMIN, MEMBER]) {
            await db_api.removeAllRecords('users', {uid: user.uid});
            await db_api.insertRecordIntoTable('users', {...user});
        }
    });

    after(async function() {
        config_api.getConfigItem = original_getConfigItem;
        await db_api.removeAllRecords('roles', {key: ROLE_KEY});
        for (const user of [ADMIN, MEMBER]) await db_api.removeAllRecords('users', {uid: user.uid});
    });

    beforeEach(function() {
        multi_user_mode = true;
    });

    describe('requireAdmin', function() {
        it('lets an administrator through', async function() {
            await request(appGuardedBy(requireAdmin, ADMIN)).get('/guarded').expect(200);
        });

        it('refuses an ordinary user', async function() {
            const res = await request(appGuardedBy(requireAdmin, MEMBER)).get('/guarded').expect(403);

            assert.strictEqual(res.body.success, false);
            assert(res.body.error, 'a refusal should say why');
        });

        it('refuses an anonymous caller with 401 rather than 403', async function() {
            // The distinction matters to a client deciding whether to prompt for login.
            await request(appGuardedBy(requireAdmin, null)).get('/guarded').expect(401);
        });

        it('does not apply in single-user mode, where there are no accounts', async function() {
            multi_user_mode = false;

            await request(appGuardedBy(requireAdmin, null)).get('/guarded').expect(200);
        });
    });

    describe('requirePermission', function() {
        it('lets a user with the permission through', async function() {
            await request(appGuardedBy(requirePermission('filemanager'), MEMBER)).get('/guarded').expect(200);
        });

        it('refuses a user without the permission', async function() {
            const res = await request(appGuardedBy(requirePermission('tasks_manager'), MEMBER)).get('/guarded').expect(403);

            assert(res.body.error.includes('tasks_manager'), 'the refusal should name the permission');
        });

        it('refuses an anonymous caller', async function() {
            await request(appGuardedBy(requirePermission('filemanager'), null)).get('/guarded').expect(401);
        });

        it('does not apply in single-user mode', async function() {
            multi_user_mode = false;

            await request(appGuardedBy(requirePermission('tasks_manager'), null)).get('/guarded').expect(200);
        });

        it('lets an administrator through on the strength of the admin role', async function() {
            await request(appGuardedBy(requirePermission('tasks_manager'), ADMIN)).get('/guarded').expect(200);
        });

        it('honours a negative override on an administrator', async function() {
            // Admins are not special-cased, so an explicit "no" means no. If this ever
            // starts passing, someone has added an admin bypass.
            await db_api.updateRecord('users', {uid: ADMIN.uid}, {permissions: [], permission_overrides: ['tasks_manager']});

            try {
                await request(appGuardedBy(requirePermission('tasks_manager'), ADMIN)).get('/guarded').expect(403);
            } finally {
                await db_api.updateRecord('users', {uid: ADMIN.uid}, {permission_overrides: []});
            }
        });
    });

    describe('requireAuthenticated', function() {
        it('lets an ordinary authenticated user through', async function() {
            await request(appGuardedBy(requireAuthenticated, MEMBER)).get('/guarded').expect(200);
        });

        it('refuses a caller with no user', async function() {
            await request(appGuardedBy(requireAuthenticated, null)).get('/guarded').expect(401);
        });

        // The reason this guard stopped being a no-op: optionalJwt lets a share-link
        // caller through with can_watch and no user at all, and a guard that returned
        // next() unconditionally let that caller reach every route wearing it.
        it('refuses a caller who only holds a share link', async function() {
            await request(appGuardedBy(requireAuthenticated, null, {can_watch: true})).get('/guarded').expect(401);
        });

        it('does nothing in single-user mode', async function() {
            multi_user_mode = false;
            try {
                await request(appGuardedBy(requireAuthenticated, null)).get('/guarded').expect(200);
            } finally {
                multi_user_mode = true;
            }
        });
    });

    describe('requireAuthenticatedOrShared', function() {
        it('lets an authenticated user through', async function() {
            await request(appGuardedBy(requireAuthenticatedOrShared, MEMBER)).get('/guarded').expect(200);
        });

        it('lets a share-link caller through', async function() {
            await request(appGuardedBy(requireAuthenticatedOrShared, null, {can_watch: true})).get('/guarded').expect(200);
        });

        it('refuses a caller who has neither', async function() {
            await request(appGuardedBy(requireAuthenticatedOrShared, null)).get('/guarded').expect(401);
        });
    });
});
