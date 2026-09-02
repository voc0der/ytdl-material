import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backgroundSource = readFileSync(join(extensionRoot, 'background.js'), 'utf8');

function readJson(name) {
    return JSON.parse(readFileSync(join(extensionRoot, name), 'utf8'));
}

function readArchiveFile(archive, path) {
    return execFileSync('unzip', ['-p', join(extensionRoot, archive), path], {
        encoding: 'utf8',
    });
}

function createEvent(listeners, name) {
    listeners[name] = [];
    return {
        addListener(listener) {
            listeners[name].push(listener);
        },
    };
}

function runBackground(actionApiName, initialTabs = []) {
    const calls = [];
    const listeners = {};
    const actionApi = {};

    for (const method of ['disable', 'enable', 'setIcon', 'setPopup', 'setTitle']) {
        actionApi[method] = (...args) => calls.push({ args, method });
    }

    const chrome = {
        runtime: {
            lastError: null,
            onInstalled: createEvent(listeners, 'installed'),
            onStartup: createEvent(listeners, 'startup'),
        },
        tabs: {
            get(tabId, callback) {
                callback(initialTabs.find((tab) => tab.id === tabId));
            },
            onActivated: createEvent(listeners, 'activated'),
            onUpdated: createEvent(listeners, 'updated'),
            query(_query, callback) {
                callback(initialTabs);
            },
        },
        windows: {
            WINDOW_ID_NONE: -1,
            onFocusChanged: createEvent(listeners, 'focusChanged'),
        },
        [actionApiName]: actionApi,
    };

    vm.runInNewContext(backgroundSource, { chrome, URL });
    return { calls, listeners };
}

test('Chrome manifest uses Manifest V3 APIs', () => {
    const manifest = readJson('manifest.json');

    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.background, { service_worker: 'background.js' });
    assert.equal(manifest.action.default_popup, 'popup.html');
    assert.ok(!('browser_action' in manifest));
    assert.ok(!manifest.permissions.includes('contextMenus'));
});

test('Firefox manifest preserves the existing Manifest V2 contract', () => {
    const manifest = readJson('manifest.firefox.json');

    assert.equal(manifest.manifest_version, 2);
    assert.deepEqual(manifest.background, {
        scripts: ['background.js'],
        persistent: false,
    });
    assert.equal(manifest.browser_action.default_popup, 'popup.html');
    assert.equal(
        manifest.browser_specific_settings.gecko.id,
        'ytdl-material@voc0der.github.io',
    );
    assert.ok(!manifest.permissions.includes('contextMenus'));
});

test('browser manifests share their package identity and version', () => {
    const chromeManifest = readJson('manifest.json');
    const firefoxManifest = readJson('manifest.firefox.json');

    for (const property of ['description', 'name', 'version']) {
        assert.equal(chromeManifest[property], firefoxManifest[property]);
    }
});

for (const actionApiName of ['action', 'browserAction']) {
    test(`background supports chrome.${actionApiName}`, () => {
        const { calls, listeners } = runBackground(actionApiName, [
            { id: 1, url: 'https://www.youtube.com/watch?v=video' },
            { id: 2, url: 'https://music.youtube.com/watch?v=track' },
            { id: 3, url: 'https://youtu.be/video' },
            { id: 4, url: 'https://youtube.com.example.test/watch?v=video' },
            { id: 5, url: 'not a URL' },
        ]);

        assert.deepEqual(
            calls.filter(({ method }) => method === 'enable').map(({ args }) => args[0]),
            [1, 2, 3],
        );
        assert.deepEqual(
            calls.filter(({ method }) => method === 'disable').map(({ args }) => args[0]),
            [4, 5],
        );
        assert.equal(listeners.installed.length, 1);
        assert.equal(listeners.startup.length, 1);
        assert.equal(listeners.activated.length, 1);
        assert.equal(listeners.updated.length, 1);
        assert.equal(listeners.focusChanged.length, 1);
    });
}

test('tab updates refresh the action only for relevant changes', () => {
    const { calls, listeners } = runBackground('action');

    listeners.updated[0](10, {}, { id: 10, url: 'https://www.youtube.com/watch?v=video' });
    assert.equal(calls.length, 0);

    listeners.updated[0](10, { status: 'loading' }, {
        id: 10,
        url: 'https://www.youtube.com/watch?v=video',
    });
    assert.equal(calls.at(-1).method, 'enable');

    listeners.updated[0](10, { url: 'https://example.test/' }, {
        id: 10,
        url: 'https://example.test/',
    });
    assert.equal(calls.at(-1).method, 'disable');
});

test('packaged manifests and background scripts match their sources', () => {
    const packages = [
        ['ytdl-material-chrome-extension.zip', 'manifest.json'],
        ['ytdl-material-firefox-extension.zip', 'manifest.firefox.json'],
    ];

    for (const [archive, manifest] of packages) {
        assert.deepEqual(
            JSON.parse(readArchiveFile(archive, 'manifest.json')),
            readJson(manifest),
        );
        assert.equal(readArchiveFile(archive, 'background.js'), backgroundSource);
    }
});

test('checked-in extension archives are reproducible', () => {
    execFileSync(process.execPath, [join(extensionRoot, 'package.mjs'), '--check'], {
        stdio: 'pipe',
    });
});
