const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const filename = path.join(__dirname, '../../app.js');
const appRequire = createRequire(filename);
const source = fs.readFileSync(filename, 'utf8');

// Load the complete server so V8 sees every function at its original offset. Only
// automatic startup is suppressed; tests explicitly call the lifecycle functions.
// Unlike a source fragment, this cannot mark untested functions as covered.
// Disk writes and process operations belong to this harness, never the real server.
function createAppHarness({ dependencies = {}, globals = {}, config = {}, env = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-app-harness-'));
    const messages = [];
    const logs = Object.fromEntries(['info', 'warn', 'error', 'verbose', 'debug'].map(level =>
        [level, (...args) => messages.push([level, ...args])]));
    const realConfig = appRequire('./config');
    const values = { ytdl_multi_user_mode: false, ytdl_reverse_proxy_whitelist: '', ...config };
    const configApi = {
        ...realConfig,
        initialize() {},
        configExistsCheck() {},
        getConfigItem: key => values[key],
        setConfigItem: (key, value) => { values[key] = value; return true; }
    };
    class MemoryAdapter {
        read() { return {}; }
        write(data) { return data; }
    }
    const fakeProcess = {
        env: { ...env },
        platform: process.platform,
        getuid: () => 1000,
        getgid: () => 1000,
        umask: () => 0o022,
        exit: code => { throw new Error(`Unexpected process exit: ${code}`); }
    };
    // App startup reads these relative names before any route runs. All other file
    // operations use the disposable __dirname or must be supplied by the test.
    const isolatedFs = {
        ...fs,
        existsSync: file => fs.existsSync(path.isAbsolute(file) ? file : path.join(root, file)),
        readJSONSync: file => fs.readJSONSync(path.isAbsolute(file) ? file : path.join(root, file)),
        unlinkSync: file => fs.unlinkSync(path.isAbsolute(file) ? file : path.join(root, file))
    };
    const defaults = {
        'fs-extra': isolatedFs,
        './lowdb-compat/adapters/FileSync': MemoryAdapter,
        './config.js': configApi,
        './db': { ...appRequire('./db'), initialize() {} },
        './authentication/auth': { ...appRequire('./authentication/auth'), initialize() {} },
        './logger': { ...logs, hasEnvLogLevelOverride: () => false, getEnvLogLevelOverride: () => null }
    };
    const context = vm.createContext({
        require: name => Object.hasOwn(dependencies, name) ? dependencies[name]
            : Object.hasOwn(defaults, name) ? defaults[name] : appRequire(name),
        __dirname: root,
        __filename: filename,
        exports: {},
        process: fakeProcess,
        Buffer, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
        fetch: async () => { throw new Error('Unexpected network request'); },
        ...globals
    });
    assert.strictEqual(source.split('\nsetAndLoadConfig();').length, 2, 'startup marker must be unique');
    vm.runInContext(source.replace(/^setAndLoadConfig\(\);$/m, line => ' '.repeat(line.length)), context, { filename });
    return {
        root, context, messages, values,
        read: expression => vm.runInContext(expression, context),
        close() {
            context.clearRedisRateLimitReconnectTimer();
            for (const name of ['testCookiesRateLimitStore', 'apiRateLimitStore', 'authRateLimitStore', 'docsRateLimitStore']) {
                vm.runInContext(`${name}.shutdown()`, context);
            }
            fs.removeSync(root);
        }
    };
}

module.exports = { createAppHarness };
