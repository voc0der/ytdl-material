const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const categories_api = require('../categories');
const hooks_api = require('../hooks');
const db_api = require('../db');
const logger = require('../logger');

// What categories and hooks do when what they read is not what they expect.
describe('Category and hook failures', function() {
    let originals;
    let warnings;
    const stub = (object, name, value) => { originals.push([object, name, object[name]]); object[name] = value; };

    beforeEach(function() {
        originals = [];
        warnings = [];
        stub(logger, 'warn', message => warnings.push(message));
        stub(logger, 'verbose', () => {});
    });

    afterEach(function() {
        for (const [object, name, value] of originals.reverse()) object[name] = value;
    });

    it('puts a file in no category when the categories cannot be read', async function() {
        stub(db_api, 'getRecords', async () => null);
        assert.strictEqual(await categories_api.categorize({title: 'Moon landing'}), null);
        assert.deepStrictEqual(warnings, ['Categories could not be found.']);
    });

    it('matches nothing on a rule whose comparison it does not know, and says which category has it', async function() {
        stub(db_api, 'getRecords', async () => [{
            name: 'Space',
            rules: [{preceding_operator: null, comparator: 'resembles', property: 'title', value: 'Moon'}]
        }]);
        assert.strictEqual(await categories_api.categorize({title: 'Moon landing'}), null);
        assert.deepStrictEqual(warnings, ['Invalid comparison used for category Space']);
    });

    describe('listing hooks', function() {
        let dir;
        let previous_dir;
        beforeEach(function() {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-hooks-'));
            previous_dir = hooks_api.getHooksDir();
            hooks_api.setHooksDir(dir);
        });
        afterEach(function() {
            hooks_api.setHooksDir(previous_dir);
            fs.rmSync(dir, {recursive: true, force: true});
        });

        it('says so when a stage cannot be read, but not when it is simply not there', function() {
            assert.deepStrictEqual(hooks_api.listHooks('download-finished.d'), []);
            assert.deepStrictEqual(warnings, []);

            const failure = Object.assign(new Error('input/output error'), {code: 'EIO'});
            stub(fs, 'readdirSync', () => { throw failure; });
            assert.deepStrictEqual(hooks_api.listHooks('download-finished.d'), []);
            assert.deepStrictEqual(warnings, [`Could not read the hooks in ${path.join(dir, 'download-finished.d')}: input/output error`]);
        });

        it('skips a hook that is a link to nothing', function() {
            const stage = path.join(dir, 'download-finished.d');
            fs.mkdirSync(stage);
            fs.symlinkSync(path.join(dir, 'gone'), path.join(stage, '10-dangling'));
            fs.writeFileSync(path.join(stage, '20-real'), '#!/bin/sh\n', {mode: 0o755});

            assert.deepStrictEqual(hooks_api.listHooks('download-finished.d').map(hook => path.basename(hook)), ['20-real']);
        });
    });
});
