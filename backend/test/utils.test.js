/* eslint-disable no-undef */
const { assert, utils } = require('./test-shared');

describe('Utils', async function() {
    it('Strip properties', async function() {
        const test_obj = {test1: 'test1', test2: 'test2', test3: 'test3'};
        const stripped_obj = utils.stripPropertiesFromObject(test_obj, ['test1', 'test3']);
        assert(!stripped_obj['test1'] && stripped_obj['test2'] && !stripped_obj['test3'])
    });

    it('Convert flat object to nested object', async function() {
        // No modfication
        const flat_obj0 = {'test1': {'test_sub': true}, 'test2': {test_sub: true}};
        const nested_obj0 = utils.convertFlatObjectToNestedObject(flat_obj0);
        assert(nested_obj0['test1'] && nested_obj0['test1']['test_sub']);
        assert(nested_obj0['test2'] && nested_obj0['test2']['test_sub']);

        // Standard setup
        const flat_obj1 = {'test1.test_sub': true, 'test2.test_sub': true};
        const nested_obj1 = utils.convertFlatObjectToNestedObject(flat_obj1);
        assert(nested_obj1['test1'] && nested_obj1['test1']['test_sub']);
        assert(nested_obj1['test2'] && nested_obj1['test2']['test_sub']);

        // Nested branches
        const flat_obj2 = {'test1.test_sub': true, 'test1.test2.test_sub': true};
        const nested_obj2 = utils.convertFlatObjectToNestedObject(flat_obj2);
        assert(nested_obj2['test1'] && nested_obj2['test1']['test_sub']);
        assert(nested_obj2['test1'] && nested_obj2['test1']['test2'] && nested_obj2['test1']['test2']['test_sub']);
    });

    it('Redacts sensitive command args for logging', async function() {
        const redacted = utils.redactCommandArgsForLogging([
            '--username', 'user@example.com',
            '--password', 'super-secret',
            '--cookies=appdata/cookies.txt',
            '--proxy', 'http://user:pass@proxy:8080',
            '-o', '%(title)s.%(ext)s'
        ]);

        assert.deepStrictEqual(redacted, [
            '--username', '[REDACTED]',
            '--password', '[REDACTED]',
            '--cookies=[REDACTED]',
            '--proxy', '[REDACTED]',
            '-o', '%(title)s.%(ext)s'
        ]);
    });

    it('Parses expected file size from formats for selected format ids', function() {
        const info = {
            format_id: '137+251',
            formats: [
                {format_id: '137', filesize: 100},
                {format_id: '251', filesize_approx: 25},
                {format_id: '999', filesize: 999}
            ]
        };
        assert.strictEqual(utils.getExpectedFileSize(info), 125);
    });

    it('Falls back to requested_formats when formats sizes are unavailable', function() {
        const info = {
            format_id: '137+251',
            formats: [
                {format_id: '137'},
                {format_id: '251'}
            ],
            requested_formats: [
                {format_id: '137', filesize_approx: 1000},
                {format_id: '251', filesize: 500}
            ]
        };
        assert.strictEqual(utils.getExpectedFileSize(info), 1500);
    });

    it('Falls back to top-level filesize approximation when needed', function() {
        const info = {
            format_id: 'bestvideo+bestaudio',
            formats: [],
            filesize_approx: 4096
        };
        assert.strictEqual(utils.getExpectedFileSize(info), 4096);
    });

    it('Handles fallback format expressions without overcounting all variants', function() {
        const info = {
            format_id: '22/18',
            formats: [
                {format_id: '22', filesize: 2200},
                {format_id: '18', filesize: 1800}
            ]
        };
        assert.strictEqual(utils.getExpectedFileSize(info), 2200);
    });
});
