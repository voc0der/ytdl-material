const assert = require('assert');
const auth_api = require('../authentication/auth');
const db_api = require('../db');
const logger = require('../logger');

// What account management refuses, and what it does when the database lets it down.
describe('Account refusals', function() {
    let originals;
    let errors;
    const stub = (object, name, value) => { originals.push([object, name, object[name]]); object[name] = value; };

    beforeEach(function() {
        originals = [];
        errors = [];
        stub(logger, 'error', message => errors.push(message instanceof Error ? message.message : message));
        stub(logger, 'verbose', () => {});
    });

    afterEach(function() {
        for (const [object, name, value] of originals.reverse()) object[name] = value;
    });

    it('refuses to delete a user folder outside the users folder', async function() {
        stub(db_api, 'getRecord', async () => { throw new Error('the database was asked'); });

        assert.strictEqual(await auth_api.deleteUser('../escape'), false);
        assert.deepStrictEqual(errors, ['Refusing to delete user folder with unsafe uid path: ../escape']);
    });

    it('refuses a name another account already has', async function() {
        const inserted = [];
        stub(db_api, 'getRecord', async (table, filter) => filter.name === 'alice' ? { uid: 'someone-else', name: 'alice' } : null);
        stub(db_api, 'insertRecordIntoTable', async (...args) => { inserted.push(args); return true; });

        assert.strictEqual(await auth_api.registerUser('new-uid', 'alice', 'secret'), null);
        assert.deepStrictEqual(inserted, []);
        assert.deepStrictEqual(errors, ['Registration failed: User name is already taken!']);
    });

    it('reports a permission change the database could not make', async function() {
        stub(db_api, 'pullFromRecordsArray', async () => { throw new Error('database gone'); });

        assert.strictEqual(await auth_api.changeUserPermissions('alice', 'sharing', 'yes'), false);
        assert.strictEqual(await auth_api.changeRolePermissions('user', 'sharing', 'yes'), false);
        assert.deepStrictEqual(errors, ['database gone', 'database gone']);
    });

    it('grants nothing to an account without a role, and answers for a role from its own list', async function() {
        stub(db_api, 'getRecord', async (table, filter) => {
            if (table === 'users') return { uid: filter.uid, permission_overrides: [], permissions: [] };
            return table === 'roles' && filter.key === 'user' ? { key: 'user', permissions: ['sharing'] } : null;
        });

        assert.strictEqual(await auth_api.userHasPermission('alice', 'sharing'), false);
        assert.deepStrictEqual(errors, [
            'Cannot resolve permissions: user has no role.',
            'Refusing every permission for alice: their role could not be resolved.'
        ]);
        assert.strictEqual(await auth_api.roleHasPermissions('user', 'sharing'), true);
        assert.strictEqual(await auth_api.roleHasPermissions('user', 'filemanager'), false);
        assert.strictEqual(await auth_api.roleHasPermissions('ghost', 'sharing'), false);
    });
});
