const assert = require('assert');
const logger = require('../logger');

describe('Logger', function() {
    const env_keys = ['ytdl_log_level', 'YTDL_LOG_LEVEL', 'ytdl_logger_level', 'YTDL_LOGGER_LEVEL'];
    const original_env_values = {};

    beforeEach(function() {
        for (const key of env_keys) {
            original_env_values[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(function() {
        for (const key of env_keys) {
            if (original_env_values[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = original_env_values[key];
            }
        }
    });

    it('hasEnvLogLevelOverride is false when no log level env vars are set', function() {
        assert.strictEqual(logger.hasEnvLogLevelOverride(), false);
    });

    it('hasEnvLogLevelOverride is true when ytdl_log_level is set', function() {
        process.env.ytdl_log_level = 'debug';
        assert.strictEqual(logger.hasEnvLogLevelOverride(), true);
    });

    it('hasEnvLogLevelOverride is true when only the uppercase env var is set', function() {
        process.env.YTDL_LOGGER_LEVEL = 'warn';
        assert.strictEqual(logger.hasEnvLogLevelOverride(), true);
    });

    it('getEnvLogLevelOverride is null when no log level env vars are set', function() {
        assert.strictEqual(logger.getEnvLogLevelOverride(), null);
    });

    it('getEnvLogLevelOverride names the variable in force and the level it sets', function() {
        process.env.ytdl_logger_level = 'error';
        process.env.ytdl_log_level = ' WARNING ';
        assert.deepStrictEqual(logger.getEnvLogLevelOverride(), {level: 'warn', variable: 'ytdl_log_level'});
    });

    it('getEnvLogLevelOverride passes over an empty variable, and reports the info fallback for an invalid one', function() {
        process.env.ytdl_log_level = '';
        process.env.YTDL_LOGGER_LEVEL = 'loud';
        assert.deepStrictEqual(logger.getEnvLogLevelOverride(), {level: 'info', variable: 'YTDL_LOGGER_LEVEL'});
    });
});
