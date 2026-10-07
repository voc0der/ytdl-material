const assert = require('assert');
const { startApp } = require('./helpers/app-process');

/*************************************************
 * A pasted list of links, through the real route.
 * With max_concurrent_downloads at 0 the server
 * queues what it is sent and starts none of it,
 * so nothing is ever downloaded.
 ************************************************/
describe('A pasted list of links through the server', function() {
    this.timeout(30000);

    let app;

    before(async function() {
        app = await startApp({env: {ytdl_max_concurrent_downloads: '0'}});
    });

    after(async function() {
        if (app) await app.stop();
    });

    it('queues each link once, and the same list again queues nothing', async function() {
        const urls = Array.from({length: 12}, (_, i) => `https://example.com/clips/${i}`);

        const first = await app.api.post('/api/downloadFiles').send({urls: [...urls, urls[0], 'file:///etc/passwd']}).expect(200);
        assert.deepStrictEqual(first.body, {success: true, queued_count: 12, duplicate_count: 1, invalid_count: 1});

        const again = await app.api.post('/api/downloadFiles').send({urls: urls}).expect(200);
        assert.deepStrictEqual(again.body, {success: true, queued_count: 0, duplicate_count: 12, invalid_count: 0});

        const listed = await app.api.post('/api/downloads').send({}).expect(200);
        assert.deepStrictEqual(listed.body.downloads.map(download => download.url).sort(), [...urls].sort());
    });

    it('refuses a request without a list, or with more links than it takes at once', async function() {
        await app.api.post('/api/downloadFiles').send({url: 'https://example.com/clips/1'}).expect(400);
        await app.api.post('/api/downloadFiles').send({urls: []}).expect(400);

        const too_many = Array.from({length: 1001}, (_, i) => `https://example.com/clips/${i}`);
        const refused = await app.api.post('/api/downloadFiles').send({urls: too_many}).expect(400);
        assert.strictEqual(refused.body.error, 'A maximum of 1000 URLs may be queued at once.');
    });
});
