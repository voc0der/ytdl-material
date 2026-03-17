const { URL } = require('url');

let createRedisClient = null;
let RedisStoreCtor = null;

function getCreateRedisClient() {
    if (!createRedisClient) {
        ({ createClient: createRedisClient } = require('redis'));
    }
    return createRedisClient;
}

function getRedisStoreCtor() {
    if (!RedisStoreCtor) {
        ({ RedisStore: RedisStoreCtor } = require('rate-limit-redis'));
    }
    return RedisStoreCtor;
}

function normalizeRedisConnectionString(connectionString = '') {
    if (typeof connectionString !== 'string') {
        throw new Error('Redis connection string must be a string.');
    }

    const normalized = connectionString.trim();
    if (!normalized) {
        throw new Error('Redis connection string is empty.');
    }

    let parsedUrl = null;
    try {
        parsedUrl = new URL(normalized);
    } catch (error) {
        throw new Error('Redis connection string is invalid.');
    }

    if (parsedUrl.protocol !== 'redis:' && parsedUrl.protocol !== 'rediss:') {
        throw new Error('Redis connection string must start with redis:// or rediss://.');
    }

    return normalized;
}

function isRedisConnectionString(connectionString = '') {
    if (typeof connectionString !== 'string') return false;
    const normalized = connectionString.trim().toLowerCase();
    return normalized.startsWith('redis://') || normalized.startsWith('rediss://');
}

async function createConnection(connectionString, options = {}) {
    const normalizedConnectionString = normalizeRedisConnectionString(connectionString);
    const {
        connectTimeoutMs = 5000,
        initialReconnectDelayMs = 250,
        maxInitialRetries = 2,
        maxRuntimeReconnectDelayMs = 2000,
        onError = null
    } = options;

    let hasConnectedOnce = false;
    const client = getCreateRedisClient()({
        url: normalizedConnectionString,
        socket: {
            connectTimeout: connectTimeoutMs,
            reconnectStrategy: (retries) => {
                if (!hasConnectedOnce) {
                    return retries >= maxInitialRetries ? false : initialReconnectDelayMs;
                }

                return Math.min(initialReconnectDelayMs * (retries + 1), maxRuntimeReconnectDelayMs);
            }
        }
    });

    client.on('error', error => {
        if (typeof onError === 'function') onError(error);
    });

    try {
        await client.connect();
        hasConnectedOnce = true;
        return client;
    } catch (error) {
        client.destroy();
        throw error;
    }
}

async function closeConnection(client) {
    if (!client) return;

    if (client.isOpen) {
        await client.close();
        return;
    }

    client.destroy();
}

async function testConnectionString(connectionString, options = {}) {
    let client = null;

    try {
        client = await createConnection(connectionString, {
            ...options,
            maxInitialRetries: 0
        });
        await client.ping();
        return { success: true, error: '' };
    } catch (error) {
        return {
            success: false,
            error: error && error.message ? error.message : 'Connection failed.'
        };
    } finally {
        await closeConnection(client).catch(() => null);
    }
}

function createRateLimitStore(client, options = {}) {
    if (!client) throw new Error('Redis client is required to create a rate-limit store.');

    const RedisStore = getRedisStoreCtor();
    return new RedisStore({
        prefix: options.prefix || 'ytdl:rate-limit:',
        sendCommand: (...args) => client.sendCommand(args)
    });
}

exports.normalizeRedisConnectionString = normalizeRedisConnectionString;
exports.isRedisConnectionString = isRedisConnectionString;
exports.createConnection = createConnection;
exports.closeConnection = closeConnection;
exports.testConnectionString = testConnectionString;
exports.createRateLimitStore = createRateLimitStore;

exports.__setCreateRedisClient = (customCreateRedisClient) => {
    createRedisClient = customCreateRedisClient;
};

exports.__setRedisStoreCtor = (customRedisStoreCtor) => {
    RedisStoreCtor = customRedisStoreCtor;
};

exports.__resetLoaders = () => {
    createRedisClient = null;
    RedisStoreCtor = null;
};
