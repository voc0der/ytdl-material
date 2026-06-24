/* eslint-disable no-undef */
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
});
