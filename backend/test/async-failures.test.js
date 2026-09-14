const {assert, db_api, downloader_api, subscriptions_api, youtubedl_api, useTemporaryMediaRoots} = require('./test-shared');

describe('Async download and subscription failures', function() {
    let originals;
    let media;
    const failure = new Error('database unavailable');

    beforeEach(function() {
        originals = {get: db_api.getRecord, update: db_api.updateRecord, run: youtubedl_api.runYoutubeDL};
        media = useTemporaryMediaRoots();
    });

    afterEach(function() {
        db_api.getRecord = originals.get;
        db_api.updateRecord = originals.update;
        youtubedl_api.runYoutubeDL = originals.run;
        media.restore();
    });

    it('rejects a download when its initial state update fails', async function() {
        db_api.getRecord = async () => ({uid: 'test-download', paused: false});
        db_api.updateRecord = async () => { throw failure; };
        await assert.rejects(downloader_api.downloadQueuedFile('test-download'), error => error === failure);
    });

    it('rejects a subscription when the duplicate lookup fails', async function() {
        db_api.getRecord = async () => { throw failure; };
        await assert.rejects(subscriptions_api.subscribe({url: 'https://example.com/channel'}), error => error === failure);
    });

    it('rejects a failed launch and clears the download progress timer', async function() {
        const originalSetInterval = global.setInterval;
        const originalClearInterval = global.clearInterval;
        const timers = new Set();
        global.setInterval = (...args) => {
            const timer = originalSetInterval(...args);
            timers.add(timer);
            return timer;
        };
        global.clearInterval = timer => {
            timers.delete(timer);
            return originalClearInterval(timer);
        };
        try {
            db_api.getRecord = async () => ({uid: 'test-download', url: 'https://example.com/video', type: 'video', options: {}, args: []});
            db_api.updateRecord = async () => true;
            youtubedl_api.runYoutubeDL = async () => { throw failure; };
            await assert.rejects(downloader_api.downloadQueuedFile('test-download'), error => error === failure);
            assert.strictEqual(timers.size, 0, 'progress timer must be cleared on launch failure');
        } finally {
            for (const timer of timers) originalClearInterval(timer);
            global.setInterval = originalSetInterval;
            global.clearInterval = originalClearInterval;
        }
    });
});
