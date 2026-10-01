const assert = require('assert');
const { startApp } = require('./helpers/app-process');

/*************************************************
 * ytdl_log_level holds the logger at its level, and
 * is not a config key, so the saved setting never
 * hears of it. The settings page showed the saved
 * one, Info, on a server logging at debug.
 ************************************************/
describe('A log level set in the environment', function() {
    this.timeout(30000);

    let app;

    before(async function() {
        app = await startApp({env: {ytdl_log_level: 'DEBUG'}});
    });

    after(async function() {
        if (app) await app.stop();
    });

    it('is in the config with the variable that set it, and the saved level is left alone', async function() {
        const res = await app.api.get('/api/config').expect(200);
        assert.deepStrictEqual(res.body.server_runtime.log_level, {level: 'debug', variable: 'ytdl_log_level'});
        assert.strictEqual(res.body.config_file.YtdlMaterial.Advanced.logger_level, 'info');
    });
});
