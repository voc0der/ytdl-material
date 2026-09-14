const assert = require('assert');
const child_process = require('child_process');
const {promisify} = require('util');
const twitch_api = require('../twitch');
const logger = require('../logger');

describe('Twitch chat', function() {
    describe('convertTimestamp', function() {
        const cases = [
            [0, '00:00:00'],
            [0.4, '00:00:00'],
            [59.9, '00:00:59'],
            [61.5, '00:01:01'],
            [3661.25, '01:01:01'],
            [86400, '24:00:00'],
            [360000, '100:00:00']
        ];
        for (const [input, expected] of cases) {
            it(`formats ${input} seconds as ${expected}`, function() {
                assert.strictEqual(twitch_api.convertTimestamp(input), expected);
            });
        }

        it('treats missing or negative offsets as zero', function() {
            assert.strictEqual(twitch_api.convertTimestamp(undefined), '00:00:00');
            assert.strictEqual(twitch_api.convertTimestamp(-5), '00:00:00');
        });
    });

    describe('getCommentsForVOD', function() {
        let originals;
        let errors;
        let calls;

        function stubExecFile(implementation) {
            const stub = (...args) => { throw new Error(`unexpected callback call ${args}`); };
            stub[promisify.custom] = async (file, args) => {
                calls.push({file, args});
                return implementation(file, args);
            };
            child_process.execFile = stub;
        }

        beforeEach(function() {
            errors = [];
            calls = [];
            originals = {execFile: child_process.execFile, error: logger.error};
            logger.error = message => errors.push(String(message));
        });

        afterEach(function() {
            child_process.execFile = originals.execFile;
            logger.error = originals.error;
        });

        it('rejects a non-alphanumeric VOD id without running the CLI', async function() {
            stubExecFile(() => ({stdout: '', stderr: ''}));
            assert.strictEqual(await twitch_api.getCommentsForVOD('123; rm -rf /'), null);
            assert.strictEqual(calls.length, 0);
        });

        it('passes the VOD id as an argument rather than through a shell', async function() {
            stubExecFile(() => { throw Object.assign(new Error('spawn failed'), {code: 'ENOENT'}); });
            await twitch_api.getCommentsForVOD('abc123');
            assert.strictEqual(calls.length, 1);
            assert.match(calls[0].file, /^TwitchDownloaderCLI(\.exe)?$/);
            assert.deepStrictEqual(calls[0].args.slice(0, 3), ['chatdownload', '-u', 'abc123']);
        });

        it('returns null with an install hint when the CLI is not installed', async function() {
            stubExecFile(() => { throw Object.assign(new Error('spawn TwitchDownloaderCLI ENOENT'), {code: 'ENOENT'}); });
            assert.strictEqual(await twitch_api.getCommentsForVOD('abc123'), null);
            assert(errors.some(message => message.includes('does not exist') && message.includes('TwitchDownloader')));
        });

        it('returns null instead of rejecting when the CLI fails', async function() {
            stubExecFile(() => { throw Object.assign(new Error('exited with code 1'), {code: 1, stderr: 'VOD not found'}); });
            assert.strictEqual(await twitch_api.getCommentsForVOD('abc123'), null);
            assert(errors.some(message => message.includes('VOD not found')));
        });
    });
});
