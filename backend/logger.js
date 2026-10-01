const winston = require('winston');

function normalizeLogLevel(logLevel) {
    if (!logLevel) return null;
    const normalized = String(logLevel).trim().toLowerCase();
    if (normalized === 'warning') return 'warn';
    return Object.prototype.hasOwnProperty.call(winston.config.npm.levels, normalized) ? normalized : null;
}

// In the order they are read. The first one that is set and not empty is the one in force.
const ENV_LOG_LEVEL_VARIABLES = ['ytdl_log_level', 'YTDL_LOG_LEVEL', 'ytdl_logger_level', 'YTDL_LOGGER_LEVEL'];

function getEnvLogLevelVariable() {
    return ENV_LOG_LEVEL_VARIABLES.find(variable => process.env[variable]) || null;
}

function getRawEnvLogLevel() {
    const variable = getEnvLogLevelVariable();
    return variable ? process.env[variable] : undefined;
}

function hasEnvLogLevelOverride() {
    return !!getRawEnvLogLevel();
}

function resolveLogLevelFromEnv() {
    const raw_log_level = getRawEnvLogLevel();

    const normalized_log_level = normalizeLogLevel(raw_log_level);
    if (normalized_log_level) {
        return {logLevel: normalized_log_level, invalidRawLogLevel: null};
    }

    if (raw_log_level) {
        return {logLevel: 'info', invalidRawLogLevel: raw_log_level};
    }

    const debugMode = process.env.YTDL_MODE === 'debug';
    return {logLevel: debugMode ? 'debug' : 'info', invalidRawLogLevel: null};
}

const {logLevel, invalidRawLogLevel} = resolveLogLevelFromEnv();

const defaultFormat = winston.format.printf(({ level, message, timestamp }) => {
    return `${timestamp} ${level.toUpperCase()}: ${message}`;
});
const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.combine(winston.format.timestamp(), defaultFormat),
    defaultMeta: {},
    transports: [
      //
      // - Write to all logs with level `info` and below to `combined.log`
      // - Write all logs error (and below) to `error.log`.
      //
      new winston.transports.File({ filename: 'appdata/logs/error.log', level: 'error' }),
      new winston.transports.File({ filename: 'appdata/logs/combined.log' }),
      new winston.transports.Console({level: logLevel, name: 'console'})
    ]
});

if (invalidRawLogLevel) {
    logger.warn(`Invalid log level '${invalidRawLogLevel}' from environment. Falling back to 'info'.`);
}

/*************************************************
 * The level an environment variable holds the
 * logger at, and which variable, or null when the
 * saved setting decides. While one is set the saved
 * setting has no effect, so the settings page shows
 * this in its place. ytdl_log_level is not a config
 * key, so it never reaches the saved setting.
 ************************************************/
function getEnvLogLevelOverride() {
    const variable = getEnvLogLevelVariable();
    if (!variable) return null;
    return {level: resolveLogLevelFromEnv().logLevel, variable};
}

logger.hasEnvLogLevelOverride = hasEnvLogLevelOverride;
logger.getEnvLogLevelOverride = getEnvLogLevelOverride;

module.exports = logger;
