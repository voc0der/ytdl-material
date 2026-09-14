const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// app.js starts the server when imported. Execute the update coordinator itself with
// disposable dependencies so a regression test can never install a release or restart it.
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const coordinator = source.slice(source.indexOf('async function updateServer(tag) {'), source.indexOf('async function downloadReleaseFiles(tag) {'));

describe('Server update completion', function() {
    let context;
    let calls;

    beforeEach(function() {
        calls = [];
        context = vm.createContext({
            updaterStatus: null,
            logger: {error: error => calls.push(['error', error])},
            isNewVersionAvailable: async () => true,
            backupServerLite: async () => { calls.push(['backup']); return true; },
            downloadReleaseFiles: async tag => { calls.push(['download', tag]); return true; },
            installDependencies: async () => { calls.push(['install']); return true; },
            utils: {restartServer: update => calls.push(['restart', update])}
        });
        vm.runInContext(coordinator, context);
    });

    it('resolves after preparing a successful restart', async function() {
        assert.strictEqual(await context.updateServer('v1.2.3'), true);
        assert.deepStrictEqual(calls, [['backup'], ['download', 'v1.2.3'], ['install'], ['restart', true]]);
    });

    it('stops when the backup fails', async function() {
        context.backupServerLite = async () => false;
        assert.strictEqual(await context.updateServer('v1.2.3'), false);
        assert(!calls.some(([name]) => name === 'download' || name === 'install' || name === 'restart'));
    });

    it('reports a failed release download without installing dependencies or restarting', async function() {
        context.downloadReleaseFiles = async () => false;
        assert.strictEqual(await context.updateServer('v1.2.3'), false);
        assert.strictEqual(context.updaterStatus.error, true);
        assert.strictEqual(context.updaterStatus.updating, false);
        assert(!calls.some(([name]) => name === 'install' || name === 'restart'));
    });

    it('handles an installation rejection and resolves with the failure status', async function() {
        const failure = new Error('npm install failed');
        context.installDependencies = async () => { throw failure; };
        assert.strictEqual(await context.updateServer('v1.2.3'), false);
        assert.strictEqual(context.updaterStatus.error, true);
        assert.strictEqual(context.updaterStatus.updating, false);
        assert(calls.some(([name, error]) => name === 'error' && error === failure));
        assert(!calls.some(([name]) => name === 'restart'));
    });
});
