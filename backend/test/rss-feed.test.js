const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const { startApp } = require('./helpers/app-process');

const FILES = [
    {uid: 'alice-video', user_uid: 'alice', title: 'First clip', registered: 1000, isAudio: false, favorite: true, category: {uid: 'cat-one'}},
    {uid: 'alice-audio', user_uid: 'alice', title: '100% café & music + #1', registered: 2000, isAudio: true, sub_id: 'subscription & one', category: {uid: 'cat-two'}},
    {uid: 'alice-latest', user_uid: 'alice', title: 'Latest clip', registered: 3000, isAudio: false, sub_id: 'subscription & one', category: {uid: 'cat-two'}},
    {uid: 'bob-video', user_uid: 'bob', title: 'Private Bob clip', registered: 4000, isAudio: false, favorite: true, category: {uid: 'cat-one'}},
    {uid: 'unowned-video', user_uid: null, title: 'Unowned clip', registered: 5000, isAudio: false}
];

// Check the items the reader actually receives, including their order. These fixture
// UIDs contain no XML characters, and each item has one link to its player.
function itemUIDs(response) {
    assert.match(response.headers['content-type'], /^application\/rss\+xml/);
    return [...response.text.matchAll(/<item>[\s\S]*?<link>[^<]*;uid=([^<]+)<\/link>/g)].map(match => match[1]);
}

describe('Private RSS feeds through the server', function() {
    this.timeout(30000);

    let app;
    const sessions = {};
    const feeds = {};
    const as = (user, route) => app.api.post(route).query({jwt: sessions[user]});
    const readFeed = (route = '/api/rss', token = feeds.alice.token) =>
        app.api.get(route).set('Authorization', `Bearer ${token}`);

    before(async function() {
        app = await startApp({
            env: {ytdl_multi_user_mode: 'true', ytdl_enable_rss_feed: 'true'},
            prepare: async ({root}) => {
                await fs.outputJSON(path.join(root, 'appdata', 'db.json'), {
                    simplified_db_migration_complete: true,
                    new_db_system_migration_complete: true
                });
                await fs.outputJSON(path.join(root, 'appdata', 'local_db.json'), {
                    files: FILES.map(file => ({
                        ...file,
                        description: 'A saved item',
                        uploader: 'Example author',
                        url: `https://example.com/clips/${file.uid}`
                    }))
                });
            }
        });
        for (const user of ['admin', 'alice', 'bob']) {
            await app.api.post('/api/auth/register').send({userid: user, username: user, password: `${user}-password`}).expect(200);
            const login = await app.api.post('/api/auth/login').send({username: user, password: `${user}-password`}).expect(200);
            sessions[user] = login.body.token;
            feeds[user] = (await as(user, '/api/generateAPIToken').send({label: 'Feed reader', type: 'rss'}).expect(200)).body;
            assert(feeds[user].token);
        }
    });

    after(async function() {
        if (app) await app.stop();
    });

    it('lists only the token owner’s library, newest first', async function() {
        assert.deepStrictEqual(itemUIDs(await readFeed().expect(200)), ['alice-latest', 'alice-audio', 'alice-video']);
        assert.deepStrictEqual(itemUIDs(await readFeed('/api/rss', feeds.bob.token).expect(200)), ['bob-video']);
        assert.deepStrictEqual(itemUIDs(await readFeed('/api/rss', feeds.admin.token).expect(200)), []);
    });

    it('accepts the trailing slash used by previously generated URLs', async function() {
        assert.deepStrictEqual(itemUIDs(await readFeed('/api/rss/').expect(200)), ['alice-latest', 'alice-audio', 'alice-video']);
    });

    it('matches the feed route case-insensitively like the server router', async function() {
        assert.deepStrictEqual(itemUIDs(await readFeed('/API/RSS/').expect(200)), ['alice-latest', 'alice-audio', 'alice-video']);
    });

    it('does not let query parameters switch accounts', async function() {
        const response = await readFeed().query({uuid: 'bob', user_uid: 'bob', library: 'bob'}).expect(200);
        assert.deepStrictEqual(itemUIDs(response), ['alice-latest', 'alice-audio', 'alice-video']);
    });

    it('requires the credential in the Authorization header', async function() {
        await app.api.get('/api/rss').expect(401);
        await app.api.get('/api/rss').query({apiToken: feeds.alice.token, token: feeds.alice.token, uuid: 'alice'}).expect(401);
        await readFeed('/api/rss', 'ytdl_invalid').expect(401);
    });

    it('never accepts an RSS token for another API route', async function() {
        for (const route of ['/api/getMp4s', '/api/getMp4s/']) {
            await readFeed(route).expect(401);
        }
        await app.api.post('/api/generateAPIToken').set('Authorization', `Bearer ${feeds.alice.token}`)
            .send({label: 'Replacement'}).expect(401);
    });

    it('preserves encoded text from the dialog, including percent signs and Unicode', async function() {
        const response = await readFeed().query({text_search: encodeURIComponent('100% café & music + #1')}).expect(200);
        assert.deepStrictEqual(itemUIDs(response), ['alice-audio']);
    });

    it('filters by media type, favorites and subscription', async function() {
        assert.deepStrictEqual(itemUIDs(await readFeed().query({file_type_filter: 'audio_only'}).expect(200)), ['alice-audio']);
        assert.deepStrictEqual(itemUIDs(await readFeed().query({file_type_filter: 'video_only'}).expect(200)), ['alice-latest', 'alice-video']);
        assert.deepStrictEqual(itemUIDs(await readFeed().query({favorite_filter: 'true'}).expect(200)), ['alice-video']);
        assert.deepStrictEqual(itemUIDs(await readFeed().query({sub_id: encodeURIComponent('subscription & one')}).expect(200)), ['alice-latest', 'alice-audio']);
    });

    it('accepts category lists as repeated parameters or comma-separated values', async function() {
        for (const category_filter_uids of [['cat-one', 'cat-two'], 'cat-one,cat-two']) {
            const response = await readFeed().query({category_filter_uids}).expect(200);
            assert.deepStrictEqual(itemUIDs(response), ['alice-latest', 'alice-audio', 'alice-video']);
        }
        assert.deepStrictEqual(itemUIDs(await readFeed().query({category_filter_uids: 'cat-two'}).expect(200)), ['alice-latest', 'alice-audio']);
    });

    it('applies filters before sorting and limiting the feed', async function() {
        const response = await readFeed().query({
            sub_id: encodeURIComponent('subscription & one'),
            sort: encodeURIComponent(JSON.stringify({by: 'title', order: 1})),
            range: [0, 1]
        }).expect(200);
        assert.deepStrictEqual(itemUIDs(response), ['alice-audio']);
        assert.deepStrictEqual(itemUIDs(await readFeed().query({text_search: 'no matching title'}).expect(200)), []);
    });

    it('rejects a revoked feed token on both forms of the endpoint', async function() {
        const issued = (await as('alice', '/api/generateAPIToken').send({label: 'Temporary reader', type: 'rss'}).expect(200)).body;
        await readFeed('/api/rss/', issued.token).expect(200);
        const revoked = await as('alice', '/api/revokeAPIToken').send({token_id: issued.id}).expect(200);
        assert.strictEqual(revoked.body.success, true);
        await readFeed('/api/rss', issued.token).expect(401);
        await readFeed('/api/rss/', issued.token).expect(401);
    });
});
