/* eslint-disable no-undef */
const { DelegatingRateLimitStore } = require('../rate-limit-store');
const { assert } = require('./test-shared');

describe('Delegating rate-limit store', function() {
    function createLogger(messages) {
        return {
            info: message => messages.push({ level: 'info', message }),
            warn: message => messages.push({ level: 'warn', message })
        };
    }

    it('falls back to memory while Redis is unavailable and resumes Redis when it is ready again', async function() {
        const messages = [];
        const memoryStore = {
            localKeys: true,
            init: () => {},
            increment: async key => `memory:${key}`
        };
        const redisStore = {
            localKeys: false,
            init: () => {},
            increment: async key => `redis:${key}`
        };
        const fakeClient = { isReady: false };
        const store = new DelegatingRateLimitStore('ytdl:test:', {
            logger: createLogger(messages),
            memoryStoreFactory: () => memoryStore,
            redisHelper: {
                createRateLimitStore: () => redisStore
            }
        });

        store.init({ windowMs: 60000 });
        await store.useRedisStore(fakeClient);

        assert.strictEqual(await store.increment('a'), 'memory:a');
        fakeClient.isReady = true;
        assert.strictEqual(await store.increment('b'), 'redis:b');
        fakeClient.isReady = false;
        assert.strictEqual(await store.increment('c'), 'memory:c');
        fakeClient.isReady = true;
        assert.strictEqual(await store.increment('d'), 'redis:d');
        assert(messages.some(entry => entry.level === 'warn' && entry.message.includes('Using in-memory rate limiting until Redis is ready again.')));
        assert(messages.some(entry => entry.level === 'info' && entry.message.includes('is active again.')));
    });

    it('falls back to memory for a Redis command error without detaching Redis permanently', async function() {
        const messages = [];
        let shouldThrow = true;
        const memoryStore = {
            localKeys: true,
            init: () => {},
            increment: async key => `memory:${key}`
        };
        const redisStore = {
            localKeys: false,
            init: () => {},
            increment: async key => {
                if (shouldThrow) {
                    shouldThrow = false;
                    throw new Error('redis unavailable');
                }
                return `redis:${key}`;
            }
        };
        const fakeClient = { isReady: true };
        const store = new DelegatingRateLimitStore('ytdl:test:', {
            logger: createLogger(messages),
            memoryStoreFactory: () => memoryStore,
            redisHelper: {
                createRateLimitStore: () => redisStore
            }
        });

        store.init({ windowMs: 60000 });
        await store.useRedisStore(fakeClient);

        assert.strictEqual(await store.increment('a'), 'memory:a');
        assert.strictEqual(await store.increment('b'), 'redis:b');
        assert(messages.some(entry => entry.level === 'warn' && entry.message.includes('redis unavailable')));
    });
});
