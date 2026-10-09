const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const {startApp} = require('./helpers/app-process');

const TEST_URL = 'https://example.test/clips/one';
const SECRET = 'fixture-cookie-value';
const COOKIES = [
    '# Netscape HTTP Cookie File',
    '',
    `.example.test\tTRUE\t/\tTRUE\t0\tsession\t${SECRET}`,
    `#HttpOnly_.example.test\tTRUE\t/\tTRUE\t0\ttoken\t${SECRET}`,
    'malformed row',
    ''
].join('\r\n');

describe('Cookie diagnostics through the server', function() {
    this.timeout(30000);

    // Each group has its own server and stays within the real ten-request limit.
    function fixture(useCookies = true) {
        let app;
        const file = name => path.join(app.root, 'appdata', name);
        before(async function() {
            app = await startApp({
                env: {ytdl_use_cookies: String(useCookies)},
                preload: path.join(__dirname, 'helpers/cookie-diagnostics.js')
            });
        });
        beforeEach(async function() {
            await fs.writeFile(file('cookies.txt'), COOKIES);
            await fs.writeJSON(file('cookie-test-scenario.json'), {result: {parsed_output: [{title: 'Test clip', extractor: 'generic'}]}});
            await fs.remove(file('cookie-test-call.json'));
        });
        after(async function() { if (app) await app.stop(); });
        return {
            file,
            scenario: value => fs.writeJSON(file('cookie-test-scenario.json'), value),
            async request(body = {url: TEST_URL}, status = 200) {
                const response = await app.api.post('/api/testCookies').send(body).expect(status);
                assert.equal(response.body.use_cookies_enabled, useCookies);
                assert(Array.isArray(response.body.logs));
                assert(!JSON.stringify(response.body).includes(SECRET), 'diagnostics must not include cookie values');
                return response.body;
            },
            async assertNotLaunched() {
                assert.equal(await fs.pathExists(file('cookie-test-call.json')), false);
            }
        };
    }

    describe('Validation and cookie files', function() {
        const server = fixture();

        for (const [label, body, error] of [
            ['missing URL', {}, 'Missing URL to test.'],
            ['blank URL', {url: '   '}, 'Missing URL to test.'],
            ['malformed URL', {url: 'not a URL'}, 'Invalid URL. Only http/https URLs are allowed.'],
            ['local file URL', {url: 'file:///etc/passwd'}, 'Invalid URL. Only http/https URLs are allowed.']
        ]) {
            it(`rejects a ${label} before launching a downloader`, async function() {
                const response = await server.request(body, 400);
                assert.equal(response.success, false);
                assert.equal(response.error, error);
                assert.equal(response.cookie_file_found, false);
                await server.assertNotLaunched();
            });
        }

        it('reports a missing cookie file', async function() {
            await fs.remove(server.file('cookies.txt'));
            const response = await server.request();
            assert.equal(response.success, false);
            assert.equal(response.error, 'Cookies file not found.');
            assert.equal(response.cookie_file_found, false);
            await server.assertNotLaunched();
        });

        it('reports an empty cookie file without starting a process', async function() {
            await fs.writeFile(server.file('cookies.txt'), '');
            const response = await server.request();
            assert.equal(response.success, false);
            assert.equal(response.error, 'Cookies file is empty.');
            assert.equal(response.cookie_file_found, true);
            assert.equal(response.cookie_file_size, 0);
            await server.assertNotLaunched();
        });

        it('counts normal and HttpOnly cookies and warns about malformed rows', async function() {
            const response = await server.request({url: `  ${TEST_URL}  `});
            assert.equal(response.success, true);
            assert.equal(response.cookie_file_found, true);
            assert.equal(response.cookie_file_size, Buffer.byteLength(COOKIES));
            assert.deepEqual(response.cookie_summary, {total_lines: 4, cookie_entries: 3, invalid_entries: 1});
            assert.deepEqual(response.result, {title: 'Test clip', extractor: 'generic'});
            assert(response.logs.some(line => line.includes('1 entries that may not be valid')));
            assert.deepEqual(await fs.readJSON(server.file('cookie-test-call.json')), {
                url: TEST_URL,
                args: ['--skip-download', '--no-warnings', '--no-playlist', '--dump-single-json', '--cookies', path.join('appdata', 'cookies.txt')]
            });
            assert.equal(await fs.readFile(server.file('cookies.txt'), 'utf8'), COOKIES);
        });
    });

    describe('Downloader outcomes', function() {
        const server = fixture(false);

        it('can explicitly test cookies while automatic cookie use is disabled', async function() {
            await fs.writeFile(server.file('cookies.txt'), '.example.test\tTRUE\t/\tTRUE\t0\tsession\tvalue\n');
            await server.scenario({result: {parsed_output: [{}]}});
            const response = await server.request({url: 'http://example.test/clip'});
            assert.equal(response.success, true);
            assert.deepEqual(response.result, {title: null, extractor: null});
            assert.deepEqual(response.cookie_summary, {total_lines: 1, cookie_entries: 1, invalid_entries: 0});
            assert(response.logs.includes('Metadata fetch succeeded.'));
        });

        it('reports a failure to launch as a server error', async function() {
            await server.scenario({launch_error: {message: 'Could not start downloader'}});
            const response = await server.request({url: TEST_URL}, 500);
            assert.equal(response.success, false);
            assert.equal(response.error, 'Could not start downloader');
            assert.equal(response.cookie_file_found, true);
            assert.deepEqual(response.cookie_summary, {total_lines: 4, cookie_entries: 3, invalid_entries: 1});
        });

        for (const scenario of [{no_process: true}, {no_callback: true}]) {
            it(`reports an incomplete process result: ${Object.keys(scenario)[0]}`, async function() {
                await server.scenario(scenario);
                const response = await server.request({url: TEST_URL}, 500);
                assert.equal(response.success, false);
                assert.equal(response.error, 'Failed to initialize downloader process.');
                assert.equal(response.cookie_file_found, true);
            });
        }

        it('uses successful metadata even if the process also reports an error', async function() {
            await server.scenario({result: {parsed_output: [{title: 'Found'}], err: 'non-fatal warning'}});
            const response = await server.request();
            assert.equal(response.success, true);
            assert.deepEqual(response.result, {title: 'Found', extractor: null});
            assert.equal(response.error, undefined);
        });
    });

    describe('Failure diagnostics', function() {
        const server = fixture();

        for (const [label, err, expected] of [
            ['plain text', 'Access denied', 'Access denied'],
            ['stderr before message', {stderr: 'Process output', message: 'Generic message'}, 'Process output'],
            ['message', {message: 'Network failed'}, 'Network failed'],
            ['structured error', {code: 7}, '{"code":7}'],
            ['missing error', null, 'Unknown error.']
        ]) {
            it(`returns a readable failure for ${label}`, async function() {
                await server.scenario({result: {parsed_output: [], err}});
                const response = await server.request();
                assert.equal(response.success, false);
                assert.equal(response.error, expected);
                assert.equal(response.cookie_file_found, true);
                assert.equal(response.cookie_file_size, Buffer.byteLength(COOKIES));
                assert(response.logs.includes(expected));
            });
        }

        it('decodes process stderr buffers and truncates long diagnostics', async function() {
            await server.scenario({stderr_buffer: true, result: {parsed_output: [], err: {stderr: 'x'.repeat(1300)}}});
            const response = await server.request();
            assert.equal(response.success, false);
            assert.equal(response.error, 'x'.repeat(1200) + '...');
        });

        it('reports an unknown error for an empty stderr buffer', async function() {
            await server.scenario({stderr_buffer: true, result: {err: {stderr: ''}}});
            const response = await server.request();
            assert.equal(response.success, false);
            assert.equal(response.error, 'Unknown error.');
        });
    });
});
