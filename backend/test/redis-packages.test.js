const assert = require('assert');
const net = require('net');
const { createClient } = require('redis');
const { RedisStore } = require('rate-limit-redis');

const redis_store = require('../redis-store');
const { DelegatingRateLimitStore } = require('../rate-limit-store');

// A port that was free a moment ago, so nothing answers on it.
function closedPort() {
    return new Promise(resolve => {
        const server = net.createServer().listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

/*************************************************
 * A Redis client that answers rate-limit-redis the
 * way a server would: the scripts load, a counter
 * starts at one, and nothing else matters. Every
 * command it is sent is kept.
 ************************************************/
function fakeRedisClient() {
    const client = {
        isReady: true,
        commands: [],
        async sendCommand(args) {
            client.commands.push(args);
            if (args[0] === 'SCRIPT') return `sha-${client.commands.length}`;
            if (args[0] === 'EVALSHA') return [1, 60000];
            return 0;
        }
    };
    return client;
}

/*************************************************
 * The other Redis tests stand in fakes for both the
 * redis client and rate-limit-redis, so neither
 * package is ever loaded. These run the real ones,
 * as far as they go without a server, so that a
 * version bump which changes how either is called
 * is caught: the rate limiters refuse requests
 * rather than pass them when their store fails.
 ************************************************/
describe('Redis packages behind the rate limiters', function() {
    afterEach(function() {
        redis_store.__resetLoaders();
    });

    describe('Connecting (redis)', function() {
        it('gives up on a server that is not there after the initial retries', async function() {
            const port = await closedPort();
            const errors = [];
            await assert.rejects(redis_store.createConnection(`redis://127.0.0.1:${port}`, {
                connectTimeoutMs: 500,
                initialReconnectDelayMs: 10,
                maxInitialRetries: 2,
                onError: error => errors.push(error)
            }));
            assert.deepStrictEqual(errors.map(error => error.code), ['ECONNREFUSED', 'ECONNREFUSED', 'ECONNREFUSED']);
        });

        it('reports a failed connection test in one attempt', async function() {
            const port = await closedPort();
            const errors = [];
            const result = await redis_store.testConnectionString(`redis://127.0.0.1:${port}`, {onError: error => errors.push(error)});
            assert.strictEqual(result.success, false);
            assert(typeof result.error === 'string' && result.error.length > 0);
            assert.strictEqual(errors.length, 1);
        });

        it('refuses a connection string that is not a Redis URL before connecting', async function() {
            for (const [connection_string, message] of [
                ['', /empty/],
                ['not a url', /invalid/],
                ['postgres://db.example.test/ytdl', /must start with redis/]
            ]) {
                const result = await redis_store.testConnectionString(connection_string);
                assert.strictEqual(result.success, false);
                assert.match(result.error, message);
            }
            await assert.rejects(redis_store.createConnection(42), /must be a string/);
        });

        it('builds a real client from the connection string, and retries less once it has been up', async function() {
            let options = null;
            const while_connecting = [];
            redis_store.__setCreateRedisClient(client_options => {
                options = client_options;
                // The real client, so options it no longer accepts would throw here.
                const client = createClient(client_options);
                client.connect = async () => {
                    while_connecting.push(options.socket.reconnectStrategy(0), options.socket.reconnectStrategy(2));
                    return client;
                };
                return client;
            });
            await redis_store.createConnection(' rediss://cache.example.test:6380/2 ', {connectTimeoutMs: 1234});

            assert.strictEqual(options.url, 'rediss://cache.example.test:6380/2');
            assert.strictEqual(options.socket.connectTimeout, 1234);
            // Two quick retries while first connecting, then it gives up.
            assert.deepStrictEqual(while_connecting, [250, false]);
            // Once connected, every reconnect is retried, backing off to a limit.
            assert.deepStrictEqual([0, 2, 20].map(retries => options.socket.reconnectStrategy(retries)), [250, 750, 2000]);
        });
    });

    describe('Counting (rate-limit-redis)', function() {
        it('loads its scripts and sends every command through the client as one flat array', async function() {
            const client = fakeRedisClient();
            const store = redis_store.createRateLimitStore(client, {prefix: 'ytdl:test:'});
            assert(store instanceof RedisStore);
            assert.strictEqual(store.prefix, 'ytdl:test:');

            store.init({windowMs: 60000});
            const hits = await store.increment('203.0.113.7');
            assert.strictEqual(hits.totalHits, 1);
            assert(hits.resetTime instanceof Date);

            await store.decrement('203.0.113.7');
            await store.resetKey('203.0.113.7');

            assert(client.commands.length >= 4);
            assert(client.commands.every(command => Array.isArray(command) && command.every(part => typeof part === 'string')));
            assert.deepStrictEqual(client.commands[0].slice(0, 2), ['SCRIPT', 'LOAD']);
            assert(client.commands.some(command => command[0] === 'EVALSHA' && command.includes('ytdl:test:203.0.113.7')));
            assert(client.commands.some(command => command.join(' ') === 'DECR ytdl:test:203.0.113.7'));
            assert(client.commands.some(command => command.join(' ') === 'DEL ytdl:test:203.0.113.7'));
        });

        it('defaults the prefix, and needs a client', function() {
            assert.strictEqual(redis_store.createRateLimitStore(fakeRedisClient()).prefix, 'ytdl:rate-limit:');
            assert.throws(() => redis_store.createRateLimitStore(null), /client is required/);
        });
    });

    describe('Switching stores', function() {
        let logged;
        let store;
        let client;

        beforeEach(async function() {
            logged = [];
            const logger = {warn: message => logged.push(['warn', message]), info: message => logged.push(['info', message])};
            store = new DelegatingRateLimitStore('ytdl:test:', {logger});
            store.init({windowMs: 60000});
            client = fakeRedisClient();
            await store.useRedisStore(client);
        });

        afterEach(function() {
            store.shutdown();
        });

        it('counts in Redis while the client is ready', async function() {
            const hits = await store.increment('203.0.113.7');
            assert.strictEqual(hits.totalHits, 1);
            assert.strictEqual(store.localKeys, false);
            assert(client.commands.some(command => command[0] === 'EVALSHA'));
        });

        it('counts in memory while it is not, and says when Redis is back', async function() {
            await store.increment('203.0.113.7');
            client.isReady = false;
            const evalsha_count = client.commands.length;

            await store.increment('203.0.113.7');
            const in_memory = await store.increment('203.0.113.7');
            assert.strictEqual(in_memory.totalHits, 2);
            assert.strictEqual(store.localKeys, true);
            assert.strictEqual(client.commands.length, evalsha_count);
            assert.match(logged[0][1], /unavailable\. Using in-memory rate limiting/);

            client.isReady = true;
            await store.get('203.0.113.7');
            assert.deepStrictEqual(logged.map(([level]) => level), ['warn', 'info']);
            assert.match(logged[1][1], /active again/);
        });

        it('passes every other operation to the store in use', async function() {
            await store.decrement('203.0.113.7');
            await store.resetKey('203.0.113.7');
            assert(client.commands.some(command => command.join(' ') === 'DECR ytdl:test:203.0.113.7'));
            assert(client.commands.some(command => command.join(' ') === 'DEL ytdl:test:203.0.113.7'));

            client.isReady = false;
            await store.increment('198.51.100.1');
            await store.resetAll();
            assert.strictEqual((await store.get('198.51.100.1')), undefined);
        });

        it('goes back to memory alone when told to', async function() {
            await store.useMemoryStore();
            await store.increment('203.0.113.7');
            assert.strictEqual(client.commands.filter(command => command[0] === 'EVALSHA').length, 0);
            assert.strictEqual(store.localKeys, true);
        });
    });
});
