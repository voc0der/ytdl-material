const assert = require('assert');
const jwt = require('jsonwebtoken');

const { startApp } = require('./helpers/app-process');

// Seconds. Short, so the last test can watch a session end.
const LOGIN_EXPIRATION = 8;

/*************************************************
 * How long a session lasts and what ends it sooner,
 * through the real routes: a new password, an
 * administrator's reset, a deleted account, and the
 * limit on guessing the current password.
 *
 * Every request comes from an address of its own,
 * which trust proxy takes from X-Forwarded-For since
 * supertest connects over loopback. That keeps the
 * address-wide allowance on /api/auth out of the
 * way, and shows the limit on wrong current
 * passwords holding across addresses.
 ************************************************/
describe('Sessions on a multi-user server', function() {
    this.timeout(30000);

    let app;
    let requests = 0;
    const passwords = {admin: 'admin-password', alice: 'alice-password', bob: 'bob-password', carol: 'carol-password', dave: 'dave-password'};

    const from = req => {
        requests++;
        return req.set('X-Forwarded-For', `198.51.${Math.floor(requests / 250)}.${requests % 250 + 1}`);
    };
    const post = (route, token, body = {}) => from(app.api.post(route).query(token ? {jwt: token} : {})).send(body);
    const get = (route, token) => from(app.api.get(route).query({jwt: token}));
    const login = async uid => (await post('/api/auth/login', null, {username: uid, password: passwords[uid]}).expect(200)).body.token;
    const change = (token, body) => post('/api/auth/changePassword', token, body);

    // A line logged as a response goes out reaches the server's output a moment after it.
    async function logged(pattern) {
        const give_up = Date.now() + 2000;
        while (!pattern.test(app.output()) && Date.now() < give_up) await new Promise(resolve => setTimeout(resolve, 20));
        assert.match(app.output(), pattern);
    }

    before(async function() {
        app = await startApp({env: {
            ytdl_multi_user_mode: 'true',
            ytdl_trust_proxy: 'loopback',
            ytdl_jwt_expiration: String(LOGIN_EXPIRATION)
        }});
        for (const uid of Object.keys(passwords)) {
            await post('/api/auth/register', null, {userid: uid, username: uid, password: passwords[uid]}).expect(200);
        }
    });

    after(async function() {
        if (app) await app.stop();
    });

    it('ends your other sessions when you change your password, and keeps this one', async function() {
        const here = await login('alice');
        const elsewhere = await login('alice');
        const res = await change(here, {new_password: 'alice-new', current_password: passwords.alice}).expect(200);
        passwords.alice = 'alice-new';

        for (const ended of [here, elsewhere]) await get('/api/getMp4s', ended).expect(401);
        await get('/api/getMp4s', res.body.token).expect(200);
        // A new password is no reason for this session to last any longer than it would have.
        assert.strictEqual(jwt.decode(res.body.token).exp, jwt.decode(here).exp);
    });

    it('makes an administrator prove their own current password too', async function() {
        const admin = await login('admin');
        await change(admin, {new_password: 'admin-new'}).expect(403);
        await change(admin, {new_password: 'admin-new', current_password: 'not-it'}).expect(403);
        await post('/api/auth/login', null, {username: 'admin', password: 'admin-new'}).expect(401);

        const res = await change(admin, {new_password: 'admin-new', current_password: passwords.admin}).expect(200);
        passwords.admin = 'admin-new';
        await get('/api/getMp4s', res.body.token).expect(200);
        await login('admin');
    });

    it('ends all of an account\'s sessions when an administrator resets its password', async function() {
        const alice = await login('alice');
        const res = await change(await login('admin'), {user_uid: 'alice', new_password: 'alice-reset'}).expect(200);
        // Nothing for the administrator's own session: it was not their password.
        assert.deepStrictEqual(res.body, {success: true});
        passwords.alice = 'alice-reset';
        await get('/api/getMp4s', alice).expect(401);
        await login('alice');
    });

    it('stops guessing at the current password after five wrong ones, from any address', async function() {
        const bob = await login('bob');
        const other = await login('bob');
        for (let attempt = 0; attempt < 5; attempt++) {
            await change(bob, {new_password: 'bob-new', current_password: `guess-${attempt}`}).expect(403);
        }
        // Past the allowance even the right one waits, from another session as well.
        for (const session of [bob, other]) {
            const res = await change(session, {new_password: 'bob-new', current_password: passwords.bob}).expect(429);
            assert.deepStrictEqual(res.body, {success: false, error: 'Too many wrong current passwords. Please wait and try again.'});
            assert(Number(res.headers['retry-after']) > 0);
        }
        await login('bob');
        await logged(/Wrong current password given to change the password of "bob" from 198\.51\.\d+\.\d+\./);
        await logged(/Refused to change the password of "bob" from 198\.51\.\d+\.\d+: too many wrong current passwords\./);

        // Nobody else's account is held up, and an administrator can still set bob's.
        await change(await login('carol'), {new_password: 'carol-new', current_password: passwords.carol}).expect(200);
        passwords.carol = 'carol-new';
        await change(await login('admin'), {user_uid: 'bob', new_password: 'bob-reset'}).expect(200);
        passwords.bob = 'bob-reset';
        await login('bob');
    });

    it('forgets the wrong current passwords once the right one is given', async function() {
        let dave = await login('dave');
        for (let attempt = 0; attempt < 4; attempt++) {
            await change(dave, {new_password: 'dave-new', current_password: 'not-it'}).expect(403);
        }
        dave = (await change(dave, {new_password: 'dave-new', current_password: passwords.dave}).expect(200)).body.token;
        passwords.dave = 'dave-new';
        for (let attempt = 0; attempt < 5; attempt++) {
            await change(dave, {new_password: 'dave-newer', current_password: 'not-it'}).expect(403);
        }
        await change(dave, {new_password: 'dave-newer', current_password: passwords.dave}).expect(429);
    });

    it('logs a failed password sign-in with the name and the address', async function() {
        await app.api.post('/api/auth/login').set('X-Forwarded-For', '203.0.113.7')
            .send({username: 'alice', password: 'not-it'}).expect(401);
        await logged(/Failed password sign-in for "alice" from 203\.0\.113\.7\./);

        // A name is quoted, so a line break in it cannot start a line of its own.
        await app.api.post('/api/auth/login').set('X-Forwarded-For', '203.0.113.8')
            .send({username: 'mallory\nForged entry', password: 'not-it'}).expect(401);
        await logged(/Failed password sign-in for "mallory\\nForged entry" from 203\.0\.113\.8\./);
        await logged(/User "mallory\\nForged entry" not found/);
        assert.doesNotMatch(app.output(), /^Forged entry/m);
    });

    it('does not let a deleted account\'s sessions into a new account with its uid', async function() {
        const old = await login('carol');
        const admin = await login('admin');
        await post('/api/deleteUser', admin, {uid: 'carol'}).expect(200);
        await post('/api/auth/register', admin, {userid: 'carol', username: 'carol', password: 'somebody-else'}).expect(200);
        await get('/api/getMp4s', old).expect(401);
        await post('/api/auth/jwtAuth', old).expect(401);
    });

    // Last, because it waits for a session to end.
    it('keeps a session\'s expiry when it is renewed, and ends it then', async function() {
        const token = await login('alice');
        const renewed = (await post('/api/auth/jwtAuth', token).expect(200)).body.token;
        const again = (await post('/api/auth/jwtAuth', renewed).expect(200)).body.token;
        const {auth_time, exp} = jwt.decode(token);
        assert.strictEqual(exp, auth_time + LOGIN_EXPIRATION);
        for (const later of [renewed, again]) {
            assert.strictEqual(jwt.decode(later).auth_time, auth_time);
            assert.strictEqual(jwt.decode(later).exp, exp);
        }

        await new Promise(resolve => setTimeout(resolve, Math.max(0, exp * 1000 - Date.now()) + 200));
        for (const ended of [token, renewed, again]) {
            await get('/api/getMp4s', ended).expect(401);
            await post('/api/auth/jwtAuth', ended).expect(401);
        }
    });
});
