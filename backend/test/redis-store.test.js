/* eslint-disable no-undef */
const redis_store = require('../redis-store');
const { assert } = require('./test-shared');

describe('Redis rate-limit helpers', function() {
    afterEach(function() {
        redis_store.__resetLoaders();
    });

    it('detects supported Redis connection string schemes', function() {
        assert.strictEqual(redis_store.isRedisConnectionString('redis://127.0.0.1:6379/0'), true);
        assert.strictEqual(redis_store.isRedisConnectionString('rediss://cache.example.com:6380/1'), true);
        assert.strictEqual(redis_store.isRedisConnectionString('postgresql://db.example.com:5432/ytdl-material'), false);
    });

    it('creates a prefixed Redis rate-limit store', async function() {
        let capturedOptions = null;
        const commands = [];

        class FakeRedisStore {
            constructor(options) {
                capturedOptions = options;
            }
        }

        redis_store.__setRedisStoreCtor(FakeRedisStore);

        const fakeClient = {
            sendCommand: async (command) => {
                commands.push(command);
                return 'PONG';
            }
        };

        const store = redis_store.createRateLimitStore(fakeClient, { prefix: 'ytdl:test:' });
        assert(store instanceof FakeRedisStore);
        assert.strictEqual(capturedOptions.prefix, 'ytdl:test:');

        const result = await capturedOptions.sendCommand('PING');
        assert.strictEqual(result, 'PONG');
        assert.deepStrictEqual(commands, [['PING']]);
    });

    it('tests Redis connection strings by pinging and closing the client', async function() {
        let closed = false;

        redis_store.__setCreateRedisClient(() => {
            const client = {
                isOpen: true,
                on: () => client,
                connect: async () => {},
                ping: async () => 'PONG',
                close: async () => {
                    closed = true;
                },
                destroy: () => {}
            };
            return client;
        });

        const result = await redis_store.testConnectionString('redis://cache.example.com:6379/0');

        assert.deepStrictEqual(result, { success: true, error: '' });
        assert.strictEqual(closed, true);
    });

    it('returns the connection error when Redis testing fails', async function() {
        let destroyed = false;

        redis_store.__setCreateRedisClient(() => {
            const client = {
                isOpen: false,
                on: () => client,
                connect: async () => {
                    throw new Error('ECONNREFUSED');
                },
                close: async () => {},
                destroy: () => {
                    destroyed = true;
                }
            };
            return client;
        });

        const result = await redis_store.testConnectionString('redis://cache.example.com:6379/0');

        assert.strictEqual(result.success, false);
        assert.match(result.error, /ECONNREFUSED/);
        assert.strictEqual(destroyed, true);
    });
});
