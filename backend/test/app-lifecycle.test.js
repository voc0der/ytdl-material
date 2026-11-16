const assert = require('assert');
const { EventEmitter } = require('events');
const { createAppHarness } = require('./helpers/app-harness');

describe('Server lifecycle integrations', function() {
    let harness;
    afterEach(function() { if (harness) harness.close(); });

    it('listens with TLS and runs startup hooks after the listener is ready', async function() {
        const calls = [];
        harness = createAppHarness({
            config: { ytdl_ssl_cert_path: '/cert.pem', ytdl_ssl_key_path: '/key.pem', ytdl_url: 'https://example.test' },
            env: { USING_HEROKU: 'true', PORT: '3456' },
            dependencies: {
                'fs-extra': { existsSync: file => file.endsWith('.pem'), readFileSync: file => Buffer.from(file) },
                https: { createServer: options => {
                    calls.push(['tls', options.cert.toString(), options.key.toString()]);
                    return { listen: (port, callback) => { calls.push(['listen', port]); callback(); } };
                } },
                './utils': { wait: async () => {} },
                './hooks': { runStartedHooks: (...args) => calls.push(['hook', ...args]) }
            }
        });
        await harness.context.startServer();
        assert.deepStrictEqual(calls, [['tls', '/cert.pem', '/key.pem'], ['listen', '3456'], ['hook', '3456', 'https://example.test']]);
        assert.strictEqual(harness.values.ytdl_port, '3456');
    });

    it('falls back to HTTP with a warning when a TLS file is absent', async function() {
        let listened = false;
        harness = createAppHarness({ config: { ytdl_ssl_cert_path: '/missing.pem' }, dependencies: {
            http: { createServer: () => ({ listen: (port, callback) => { listened = true; callback(); } }) },
            './hooks': { runStartedHooks() {} }
        }});
        await harness.context.startServer();
        assert.strictEqual(listened, true);
        assert(harness.messages.some(([level, message]) => level === 'warn' && message.includes('Starting HTTP server')));
    });

    describe('Redis reconnects', function() {
        let pending;
        let stores;
        let client;
        let redis;
        let fail;
        let closed;
        let errors;

        beforeEach(function() {
            pending = new Map();
            stores = [];
            closed = [];
            fail = false;
            client = new EventEmitter();
            client.isReady = true;
            redis = {
                createConnection: async (url, options) => {
                    assert.strictEqual(url, 'redis://fixture');
                    errors = options.onError;
                    if (fail) throw new Error('offline');
                    return client;
                },
                closeConnection: async old => { closed.push(old); throw new Error('already closed'); }
            };
            // A memory-store stub implements the rate-limit middleware contract without
            // any sockets or wall-clock retries. We exercise app.js's coordination here.
            class Store {
                constructor(prefix) { this.prefix = prefix; stores.push(this); }
                init() {}
                increment() { return { totalHits: 1, resetTime: new Date() }; }
                decrement() {}
                resetKey() {}
                shutdown() {}
                async useMemoryStore() { this.mode = 'memory'; }
                async useRedisStore(value) { this.mode = 'redis'; this.client = value; }
            }
            harness = createAppHarness({
                config: { ytdl_redis_connection_string: '  redis://fixture  ' },
                dependencies: { './redis-store': redis, './rate-limit-store': { DelegatingRateLimitStore: Store } },
                globals: {
                    setTimeout: (callback, delay) => { const token = {}; pending.set(token, {callback, delay}); return token; },
                    clearTimeout: token => pending.delete(token)
                }
            });
        });

        it('initializes all stores and attaches lifecycle diagnostics', async function() {
            assert.strictEqual(await harness.context.initializeRateLimiters(), true);
            assert.strictEqual(stores.length, 5);
            // Wrong current passwords are counted per account, across every server sharing Redis.
            assert(stores.some(store => store.prefix === 'ytdl:rate-limit:current-password:'));
            assert(stores.every(store => store.mode === 'redis' && store.client === client));
            for (const event of ['ready', 'reconnecting', 'end']) client.emit(event);
            errors(new Error('connection dropped'));
            assert(harness.messages.some(([, message]) => message.includes('connection dropped')));
            assert(harness.messages.some(([, message]) => message.includes('connection ended')));
            assert.strictEqual(pending.size, 0);
        });

        it('stays on memory after failure, schedules one retry and reconnects', async function() {
            fail = true;
            assert.strictEqual(await harness.context.initializeRateLimiters(), false);
            assert(stores.every(store => store.mode === 'memory'));
            harness.context.scheduleRedisRateLimitReconnect();
            assert.strictEqual(pending.size, 1);
            const [token, retry] = [...pending][0];
            assert.strictEqual(retry.delay, 5000);
            pending.delete(token);
            await retry.callback();
            assert.strictEqual(pending.size, 1, 'a failed retry must not schedule two timers');
            fail = false;
            const [nextToken, next] = [...pending][0];
            pending.delete(nextToken);
            await next.callback();
            assert.strictEqual(pending.size, 0);
            assert(stores.every(store => store.mode === 'redis'));
        });

        it('closes the previous client and cancels pending retries when Redis is disabled', async function() {
            await harness.context.initializeRateLimiters();
            harness.context.scheduleRedisRateLimitReconnect();
            assert.strictEqual(pending.size, 1);
            harness.values.ytdl_redis_connection_string = ' ';
            assert.strictEqual(await harness.context.initializeRateLimiters(), true);
            assert.deepStrictEqual(closed, [client]);
            assert.strictEqual(pending.size, 0);
            assert(stores.every(store => store.mode === 'memory'));
            harness.context.scheduleRedisRateLimitReconnect();
            assert.strictEqual(pending.size, 0);
        });

        it('does not retry a connection failure unless requested', async function() {
            fail = true;
            assert.strictEqual(await harness.context.connectRedisRateLimitClient('redis://fixture'), false);
            assert.strictEqual(pending.size, 0);
        });
    });
});
