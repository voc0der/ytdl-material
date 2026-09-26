const {assert, auth_api, db_api} = require('./test-shared');

describe('OIDC account mapping', function() {
    const UID = 'oidc_test_alice';
    const SUBJECT = 'oidc-test-subject';
    const claims = overrides => ({sub: SUBJECT, preferred_username: UID, ...overrides});
    let createdUIDs;
    let originalInsert;
    let originalUpdate;

    beforeEach(function() {
        createdUIDs = new Set([UID]);
        originalInsert = db_api.insertRecordIntoTable;
        originalUpdate = db_api.updateRecord;
    });

    afterEach(async function() {
        db_api.insertRecordIntoTable = originalInsert;
        db_api.updateRecord = originalUpdate;
        for (const uid of createdUIDs) await db_api.removeAllRecords('users', {uid});
    });

    async function seed(overrides = {}) {
        const user = {
            uid: UID, name: UID, auth_method: 'oidc', oidc_subject: SUBJECT,
            role: 'user', permissions: [], permission_overrides: [], ...overrides
        };
        createdUIDs.add(user.uid);
        await db_api.insertRecordIntoTable('users', user);
        return user;
    }

    it('registers an ordinary account without a password and persists its subject and groups', async function() {
        const user = await auth_api.upsertOIDCUser(claims({groups: [' members ', 'editors', '']}));
        assert(user);
        assert.strictEqual(user.uid, UID);
        assert.strictEqual(user.name, UID);
        assert.strictEqual(user.auth_method, 'oidc');
        assert.strictEqual(user.passhash, null);
        assert.strictEqual(user.role, 'user');
        assert.strictEqual(user.oidc_subject, SUBJECT);
        assert.deepStrictEqual(user.oidc_groups, ['members', 'editors']);
        assert.deepStrictEqual(user.permissions, []);
        assert.deepStrictEqual(user.permission_overrides, []);
        assert.deepStrictEqual(await db_api.getRecord('users', {uid: UID}), user);
    });

    it('uses configured nested identity, display name, group and admin claims', async function() {
        const user = await auth_api.upsertOIDCUser({
            sub: SUBJECT,
            profile: {login: UID, display: 'Alice Example'},
            realm: {groups: ' readers, editors, ', roles: ['operators']}
        }, {
            username_claim: 'profile.login', display_name_claim: 'profile.display',
            groups_claim: 'realm.groups', admin_claim: 'realm.roles', admin_value: ' Operators '
        });
        assert.strictEqual(user.uid, UID);
        assert.strictEqual(user.name, 'Alice Example');
        assert.strictEqual(user.role, 'admin');
        assert.deepStrictEqual(user.oidc_groups, ['readers', 'editors']);
    });

    for (const [field, value] of [
        ['preferred_username', UID], ['username', UID], ['email', 'oidc_test@example.test'], ['sub', SUBJECT]
    ]) {
        it('falls back to ' + field + ' when the configured username claim is missing', async function() {
            createdUIDs.add(value);
            const user = await auth_api.upsertOIDCUser({sub: SUBJECT, [field]: value}, {username_claim: 'profile.login'});
            assert.strictEqual(user.uid, value);
            assert.strictEqual(user.name, value);
        });
    }

    it('rejects missing identities and usernames that could escape the user directory', async function() {
        for (const invalid of [null, {}, {preferred_username: {}},
            ...['.', '..', '../alice', 'alice/bob', 'alice\\bob', 'alice\0bob'].map(preferred_username => claims({preferred_username}))]) {
            assert.strictEqual(await auth_api.upsertOIDCUser(invalid), null);
        }
        assert.deepStrictEqual(await db_api.getRecords('users', {oidc_subject: SUBJECT}), []);
    });

    it('does not register an unknown account when automatic registration is disabled', async function() {
        assert.strictEqual(await auth_api.upsertOIDCUser(claims(), {auto_register: false}), null);
        assert.deepStrictEqual(await db_api.getRecords('users', {uid: UID}), []);
    });

    it('keeps the original uid when a known subject changes its username', async function() {
        createdUIDs.add('oidc_test_renamed');
        await seed({name: 'Old display name', permissions: ['sharing'], permission_overrides: ['sharing']});
        const user = await auth_api.upsertOIDCUser(claims({preferred_username: 'oidc_test_renamed'}), {auto_register: false});
        assert.strictEqual(user.uid, UID, 'media ownership must survive a provider-side rename');
        assert.strictEqual(user.name, 'oidc_test_renamed');
        assert.strictEqual(user.oidc_subject, SUBJECT);
        assert.deepStrictEqual(user.permissions, ['sharing']);
        assert.deepStrictEqual(user.permission_overrides, ['sharing']);
        assert.deepStrictEqual(await db_api.getRecords('users', {uid: 'oidc_test_renamed'}), []);
    });

    for (const match of ['uid', 'name']) {
        it('refuses a different subject colliding with an existing ' + match, async function() {
            const existing = await seed({
                uid: match === 'uid' ? UID : 'oidc_test_other',
                oidc_subject: 'another-subject', role: 'admin'
            });
            const before = await db_api.getRecord('users', {uid: existing.uid});
            assert.strictEqual(await auth_api.upsertOIDCUser(claims()), null);
            assert.deepStrictEqual(await db_api.getRecord('users', {uid: existing.uid}), before);
            assert.deepStrictEqual(await db_api.getRecords('users', {oidc_subject: SUBJECT}), []);
        });
    }

    it('refreshes groups and removes administrator status when the admin claim disappears', async function() {
        const first = await auth_api.upsertOIDCUser(claims({groups: 'members, ADMIN'}));
        assert.strictEqual(first.role, 'admin');
        const updated = await auth_api.upsertOIDCUser(claims({groups: ['members']}));
        assert.strictEqual(updated.uid, first.uid);
        assert.strictEqual(updated.role, 'user');
        assert.deepStrictEqual(updated.oidc_groups, ['members']);
        const withoutGroups = await auth_api.upsertOIDCUser(claims());
        assert.strictEqual(withoutGroups.role, 'user');
        assert.deepStrictEqual(withoutGroups.oidc_groups, []);
    });

    it('does not grant administrator status for a group that only contains the admin text', async function() {
        const user = await auth_api.upsertOIDCUser(claims({groups: ['superadmin', 'admin-readonly']}));
        assert.strictEqual(user.role, 'user');
    });

    it('fails login when the database refuses to create an account', async function() {
        let attempted = false;
        db_api.insertRecordIntoTable = async (table, user) => {
            assert.strictEqual(table, 'users');
            assert.strictEqual(user.uid, UID);
            attempted = true;
            return false;
        };
        assert.strictEqual(await auth_api.upsertOIDCUser(claims()), null);
        assert.strictEqual(attempted, true);
        assert.deepStrictEqual(await db_api.getRecords('users', {uid: UID}), []);
    });

    it('fails login when the database refuses to update an existing account', async function() {
        await seed();
        const before = await db_api.getRecord('users', {uid: UID});
        let attempted = false;
        db_api.updateRecord = async (table, filter) => {
            assert.strictEqual(table, 'users');
            assert.deepStrictEqual(filter, {uid: UID});
            attempted = true;
            return false;
        };
        assert.strictEqual(await auth_api.upsertOIDCUser(claims({groups: ['admin']})), null);
        assert.strictEqual(attempted, true);
        assert.deepStrictEqual(await db_api.getRecord('users', {uid: UID}), before);
    });
});
