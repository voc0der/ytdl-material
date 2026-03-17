const rateLimit = require('express-rate-limit');
const logger = require('./logger');
const redis_store = require('./redis-store');

class DelegatingRateLimitStore {
    constructor(prefix, options = {}) {
        this.prefix = prefix;
        this.logger = options.logger || logger;
        this.memoryStoreFactory = options.memoryStoreFactory || (() => new rateLimit.MemoryStore());
        this.redisHelper = options.redisHelper || redis_store;
        this.options = null;
        this.memoryStore = null;
        this.redisStore = null;
        this.redisClient = null;
        this.lastSelectedStoreType = null;
    }

    init(options) {
        this.options = options;
        this.ensureMemoryStore();
        if (typeof this.memoryStore.init === 'function') {
            this.memoryStore.init(options);
        }
        this.lastSelectedStoreType = null;
    }

    ensureMemoryStore() {
        if (!this.memoryStore) {
            this.memoryStore = this.memoryStoreFactory();
        }
        return this.memoryStore;
    }

    async useMemoryStore() {
        this.ensureMemoryStore();
        this.redisClient = null;
        this.redisStore = null;
        this.lastSelectedStoreType = null;
    }

    async useRedisStore(client) {
        this.ensureMemoryStore();
        this.redisClient = client;
        this.redisStore = this.redisHelper.createRateLimitStore(client, { prefix: this.prefix });
        if (this.options && typeof this.redisStore.init === 'function') {
            this.redisStore.init(this.options);
        }
        this.lastSelectedStoreType = null;
    }

    get localKeys() {
        const { store } = this.getSelectedStore();
        return !!(store && store.localKeys);
    }

    getSelectedStore() {
        if (this.redisStore && this.redisClient && this.redisClient.isReady) {
            return { store: this.redisStore, type: 'redis' };
        }

        return { store: this.ensureMemoryStore(), type: 'memory' };
    }

    recordStoreSelection(type) {
        if (type === this.lastSelectedStoreType) return;

        if (type === 'memory' && this.lastSelectedStoreType === 'redis') {
            this.logger.warn(`Redis rate-limit store for prefix '${this.prefix}' is unavailable. Using in-memory rate limiting until Redis is ready again.`);
        } else if (type === 'redis' && this.lastSelectedStoreType === 'memory' && this.redisStore) {
            this.logger.info(`Redis rate-limit store for prefix '${this.prefix}' is active again.`);
        }

        this.lastSelectedStoreType = type;
    }

    async get(key) {
        return this.runStoreMethod('get', key);
    }

    async increment(key) {
        return this.runStoreMethod('increment', key);
    }

    async decrement(key) {
        return this.runStoreMethod('decrement', key);
    }

    async resetKey(key) {
        return this.runStoreMethod('resetKey', key);
    }

    async resetAll() {
        return this.runStoreMethod('resetAll');
    }

    shutdown() {
        if (this.memoryStore && typeof this.memoryStore.shutdown === 'function') {
            this.memoryStore.shutdown();
        }
        if (this.redisStore && typeof this.redisStore.shutdown === 'function') {
            this.redisStore.shutdown();
        }
    }

    async runStoreMethod(methodName, ...args) {
        const { store, type } = this.getSelectedStore();
        this.recordStoreSelection(type);
        if (!store || typeof store[methodName] !== 'function') return undefined;

        try {
            return await store[methodName](...args);
        } catch (error) {
            const memoryStore = this.ensureMemoryStore();
            const canFallbackToMemory = memoryStore
                && store !== memoryStore
                && typeof memoryStore[methodName] === 'function';

            if (!canFallbackToMemory) throw error;

            this.lastSelectedStoreType = 'memory';
            this.logger.warn(`Redis rate-limit store error for prefix '${this.prefix}'. Using in-memory rate limiting until Redis is ready again. ${error.message}`);
            return memoryStore[methodName](...args);
        }
    }
}

exports.DelegatingRateLimitStore = DelegatingRateLimitStore;
