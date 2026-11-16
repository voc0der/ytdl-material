const jwt = require('jsonwebtoken');

const { assert, auth_api, config_api, db_api } = require('./test-shared');

/*************************************************
 * What a session token still says once it has been
 * issued: getUserFromJWT and the passport strategy
 * both ask getUserForSession, so this covers the
 * rule they share. The routes that issue and renew
 * tokens are covered against the real app in
 * app-sessions.test.js.
 ************************************************/
describe('Session tokens', function() {
    const UID = 'session_token_user';
    const original_getConfigItem = config_api.getConfigItem;
    let login_expiration;
    let secret;
    let user;

    const now = () => Math.floor(Date.now() / 1000);
    const sign = payload => jwt.sign(payload, secret);
    const resolve = async token => (await auth_api.getUserFromJWT(token))?.uid ?? null;

    before(function() {
        config_api.getConfigItem = key => key === 'ytdl_jwt_expiration' ? login_expiration : original_getConfigItem(key);
        auth_api.initialize();
        secret = db_api.users_db.get('jwt_secret').value();
    });

    beforeEach(async function() {
        login_expiration = 3600;
        await db_api.removeAllRecords('users', {uid: UID});
        user = await auth_api.registerUser(UID, UID, 'session-token-password');
    });

    after(async function() {
        config_api.getConfigItem = original_getConfigItem;
        await db_api.removeAllRecords('users', {uid: UID});
    });

    it('gives each account an epoch of its own, which its tokens carry', async function() {
        assert.strictEqual(typeof user.session_epoch, 'string');
        const token = auth_api.createJWTForUser(user);
        const claims = jwt.decode(token);
        assert.strictEqual(claims.user, UID);
        assert.strictEqual(claims.epoch, user.session_epoch);
        assert.strictEqual(claims.exp, claims.auth_time + 3600);
        assert(Math.abs(claims.auth_time - now()) <= 1);
        assert.strictEqual(await resolve(token), UID);
    });

    it('keeps the sign-in time of a session it renews, and so its expiry', function() {
        const started = now() - 600;
        const claims = jwt.decode(auth_api.createJWTForUser(user, started));
        assert.strictEqual(claims.auth_time, started);
        assert.strictEqual(claims.exp, started + 3600);
    });

    it('ends a session one login expiration after sign-in, whatever expiry it carries', async function() {
        // Signed by hand with an expiry no renewal would give it: the sign-in time decides.
        const old = sign({user: UID, epoch: user.session_epoch, auth_time: now() - 3600, exp: now() + 600});
        assert.strictEqual(await resolve(old), null);
        const younger = sign({user: UID, epoch: user.session_epoch, auth_time: now() - 3500, exp: now() + 600});
        assert.strictEqual(await resolve(younger), UID);
    });

    it('applies a shorter login expiration to sessions already signed in', async function() {
        const token = auth_api.createJWTForUser(user, now() - 120);
        assert.strictEqual(await resolve(token), UID);
        login_expiration = '60';
        assert.strictEqual(await resolve(token), null);
    });

    it('falls back to a day for a login expiration that is not a number of seconds', function() {
        for (const unusable of [undefined, null, '', 'a week', 0, -5]) {
            login_expiration = unusable;
            const claims = jwt.decode(auth_api.createJWTForUser(user));
            assert.strictEqual(claims.exp - claims.auth_time, 86400, JSON.stringify(unusable));
        }
    });

    it('ends every session on the account when its password changes', async function() {
        // A copy: the local database hands back the record it keeps, which the change edits.
        const epoch = user.session_epoch;
        const token = auth_api.createJWTForUser(user);
        assert.strictEqual(await auth_api.changeUserPassword(UID, 'a-new-password'), true);
        assert.strictEqual(await resolve(token), null);

        const changed = await db_api.getRecord('users', {uid: UID});
        assert.notStrictEqual(changed.session_epoch, epoch);
        assert.strictEqual(await resolve(auth_api.createJWTForUser(changed)), UID);
    });

    it('does not let a deleted account\'s tokens into a new account with its uid', async function() {
        const token = auth_api.createJWTForUser(user);
        await db_api.removeAllRecords('users', {uid: UID});
        assert.strictEqual(await resolve(token), null);

        await auth_api.registerUser(UID, UID, 'somebody-else');
        assert.strictEqual(await resolve(token), null);
    });

    describe('A token from before sign-in times and epochs', function() {
        // What createJWTForUser used to sign: the uid and an expiry, and the iat jsonwebtoken adds.
        const legacy = (overrides = {}) => sign({user: UID, exp: now() + 600, ...overrides});

        it('still works for an account with no epoch either', async function() {
            await db_api.updateRecord('users', {uid: UID}, {session_epoch: null});
            assert.strictEqual(await resolve(legacy()), UID);
        });

        it('counts from when it was issued, so renewing it cannot keep it going', async function() {
            await db_api.updateRecord('users', {uid: UID}, {session_epoch: null});
            assert.strictEqual(await resolve(legacy({iat: now() - 3600})), null);
        });

        it('stops working once the account has an epoch', async function() {
            assert.strictEqual(await resolve(legacy()), null);
        });
    });

    it('refuses a token for another epoch, without a user, or that does not verify', async function() {
        assert.strictEqual(await resolve(sign({user: UID, epoch: 'another', auth_time: now(), exp: now() + 600})), null);
        assert.strictEqual(await resolve(sign({epoch: user.session_epoch, auth_time: now(), exp: now() + 600})), null);
        assert.strictEqual(await resolve(jwt.sign({user: UID, epoch: user.session_epoch, exp: now() + 600}, 'not-the-secret')), null);
        assert.strictEqual(await auth_api.getUserForSession(null), null);
    });
});
