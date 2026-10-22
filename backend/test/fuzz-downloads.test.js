/*************************************************
 * Fuzz tests: the yt-dlp arguments a download may
 * set. Custom arguments, additional arguments and
 * output templates come from whoever starts the
 * download, so the checks in utils.js and the way
 * the downloader places what they accept decide what
 * yt-dlp is told to do.
 ************************************************/
const fc = require('fast-check');
const os = require('os');
const { assert, fs, path, utils, downloader_api } = require('./test-shared');
const CONSTS = require('../consts');
const { check, timeout, quietLogger } = require('./helpers/fuzz');

const URL = 'https://example.com/watch?v=abc';

// How many values yt-dlp takes after each option a download may set, checked against
// yt-dlp's own option parser. Python's optparse, which it builds on, takes the next
// argument as the value whatever it looks like.
const VALUE_COUNTS = {
    '-f': 1, '--format': 1, '-S': 1, '--format-sort': 1, '--merge-output-format': 1, '--audio-format': 1,
    '--audio-quality': 1, '--remux-video': 1, '--recode-video': 1, '--sub-lang': 1, '--sub-langs': 1,
    '--sub-format': 1, '--convert-subs': 1, '--convert-subtitles': 1, '--parse-metadata': 1,
    '--replace-in-metadata': 3, '-I': 1, '--playlist-items': 1, '--playlist-start': 1, '--playlist-end': 1,
    '--max-downloads': 1, '--match-filter': 1, '--match-filters': 1, '--break-match-filter': 1,
    '--break-match-filters': 1, '--min-filesize': 1, '--max-filesize': 1, '--date': 1, '--datebefore': 1,
    '--dateafter': 1, '--min-views': 1, '--max-views': 1, '--match-title': 1, '--reject-title': 1,
    '--age-limit': 1, '-r': 1, '--limit-rate': 1, '--throttled-rate': 1, '-R': 1, '--retries': 1,
    '--file-access-retries': 1, '--fragment-retries': 1, '--retry-sleep': 1, '--socket-timeout': 1, '-N': 1,
    '--concurrent-fragments': 1, '--buffer-size': 1, '--http-chunk-size': 1, '--source-address': 1,
    '--sleep-requests': 1, '--sleep-interval': 1, '--min-sleep-interval': 1, '--max-sleep-interval': 1,
    '--sleep-subtitles': 1, '--trim-filenames': 1, '--geo-bypass-country': 1, '--geo-bypass-ip-block': 1,
    '--sponsorblock-mark': 1, '--sponsorblock-remove': 1, '--sponsorblock-chapter-title': 1,
    '--extractor-args': 1, '--user-agent': 1, '--referer': 1, '--add-header': 1, '--impersonate': 1,
    // The app's own, which the default settings put on every download's command line.
    '-o': 1
};
const ALLOWED = new Set(utils.ALLOWED_DOWNLOAD_ARGS);

/*************************************************
 * The options yt-dlp acts on for a command line,
 * read the way its parser reads one, as {name,
 * values}; or null when it refuses the command line.
 ************************************************/
function optionsRead(argv) {
    const options = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') break;
        if (arg.startsWith('--')) {
            const equals = arg.indexOf('=');
            const name = equals === -1 ? arg : arg.slice(0, equals);
            // yt-dlp's long options are lowercase letters, digits and dashes. It refuses any
            // other name, whole or abbreviated.
            if (!/^--[a-z0-9][a-z0-9-]*$/.test(name)) return null;
            const count = VALUE_COUNTS[name] || 0;
            const values = equals === -1 ? [] : [arg.slice(equals + 1)];
            if (equals !== -1 && count === 0 && ALLOWED.has(name)) return null;
            while (values.length < count) {
                if (i + 1 >= argv.length) return null;
                values.push(argv[++i]);
            }
            options.push({name, values});
        } else if (arg.length > 1 && arg.startsWith('-')) {
            // A cluster of short options; the first that takes a value ends it.
            for (let j = 1; j < arg.length; j++) {
                if (!/[A-Za-z0-9]/.test(arg[j])) return null;
                const name = `-${arg[j]}`;
                const count = VALUE_COUNTS[name] || 0;
                if (count === 0) {
                    options.push({name, values: []});
                    continue;
                }
                const values = j + 1 < arg.length ? [arg.slice(j + 1)] : [];
                while (values.length < count) {
                    if (i + 1 >= argv.length) return null;
                    values.push(argv[++i]);
                }
                options.push({name, values});
                break;
            }
        }
    }
    return options;
}

// Option names outside the allowlist, among them ones that run commands, read options from
// a file, and choose where files go.
const OUTSIDE = ['-o', '--output', '-P', '--paths', '--exec', '--config-locations', '-a', '--batch-file', '-U'];
const ALLOWED_FLAGS = utils.ALLOWED_DOWNLOAD_ARGS.filter(option => !VALUE_COUNTS[option]);
const ALLOWED_WITH_VALUES = utils.ALLOWED_DOWNLOAD_ARGS.filter(option => VALUE_COUNTS[option]);
// Values, including some that look like options and some the app's own arguments hold.
const VALUES = ['best', 'mp4', 'en.*', '1', '%(title)s', 'a=b', '', ' ', '-x', '--no-mtime', 'video/%(title)s.mp4'];

// One option as somebody might write it into the field: on its own, with its value in the
// next token, after an =, after a space, or missing; padded, or in capitals.
const token = fc.oneof(
    {weight: 4, arbitrary: fc.constantFrom(...ALLOWED_FLAGS).map(option => [option])},
    {weight: 4, arbitrary: fc.tuple(fc.constantFrom(...ALLOWED_WITH_VALUES), fc.array(fc.constantFrom(...VALUES), {minLength: 3, maxLength: 3}),
        fc.constantFrom('separate', 'equals', 'space', 'missing')).map(([option, values, form]) => {
        const count = VALUE_COUNTS[option];
        if (form === 'separate') return [option, ...values.slice(0, count)];
        if (form === 'equals') return [`${option}=${values[0]}`, ...values.slice(1, count)];
        if (form === 'space') return [`${option} ${values[0]}`, ...values.slice(1, count)];
        return [option];
    })},
    {weight: 1, arbitrary: fc.constantFrom(...OUTSIDE).map(option => [option])},
    {weight: 1, arbitrary: fc.constantFrom(...VALUES).map(value => [value])},
    {weight: 1, arbitrary: fc.tuple(fc.constantFrom(...ALLOWED_FLAGS), fc.constantFrom(' ', '\t', ' '), fc.boolean())
        .map(([option, pad, upper]) => [`${pad}${upper ? option.toUpperCase() : option}${pad}`])}
);
const argsField = fc.array(token, {minLength: 1, maxLength: 6}).map(tokens => tokens.flat().join(',,'));

describe('Fuzz: download arguments', function() {
    this.timeout(timeout());
    quietLogger();

    it('the downloader knows every option a download may set that takes a value', function() {
        for (const option of utils.ALLOWED_DOWNLOAD_ARGS) {
            assert.strictEqual(CONSTS.YTDL_ARGS_WITH_VALUES.has(option), Boolean(VALUE_COUNTS[option]), option);
        }
    });

    it('custom arguments the allowlist accepts reach yt-dlp as allowed options only', async function() {
        await check(this, fc.asyncProperty(argsField, async (raw) => {
            // Empty custom arguments are none, and the download gets the app's own.
            if (raw === '' || utils.findDisallowedDownloadArgs(raw).length > 0) return;
            const argv = await downloader_api.generateArgs(URL, 'video', {customArgs: raw}, null, true);
            assert(argv.every(arg => typeof arg === 'string'), JSON.stringify(argv));
            const read = optionsRead(argv);
            // A command line yt-dlp refuses runs nothing.
            if (read === null) return;
            const outside = read.filter(option => !ALLOWED.has(option.name));
            assert.deepStrictEqual(outside, [], `${JSON.stringify(raw)} became ${JSON.stringify(argv)}`);
        }));
    });

    it('additional arguments add no option outside the allowlist, and take none of the app\'s as a value', async function() {
        const baseline = optionsRead(await downloader_api.generateArgs(URL, 'video', {}, null, true));
        await check(this, fc.asyncProperty(argsField, async (raw) => {
            if (utils.findDisallowedDownloadArgs(raw).length > 0) return;
            const argv = await downloader_api.generateArgs(URL, 'video', {additionalArgs: raw}, null, true);
            assertOnlyAllowedAdded(raw, argv, baseline);
        }), [
            ['--no-mtime,,--max-filesize'],
            ['--sponsorblock-mark'],
            ['--no-mtime,,--remux-video,,video/%(title)s.mp4'],
            ['-f,,-x'],
            ['--replace-in-metadata=best,,best,,video/%(title)s.mp4']
        ]);
    });
});

/*************************************************
 * Checks a command line built with arguments from a
 * request or a stored record against the one built
 * without them: every option yt-dlp reads from it is
 * either allowed or one the app sets, and each of
 * the app's options that nobody else may set still
 * reaches yt-dlp, with its own values.
 ************************************************/
function assertOnlyAllowedAdded(raw, argv, baseline) {
    const described = `${JSON.stringify(raw)} became ${JSON.stringify(argv)}`;
    assert(argv.every(arg => typeof arg === 'string'), described);
    const read = optionsRead(argv);
    // A command line yt-dlp refuses runs nothing.
    if (read === null) return;
    const app_options = new Set(baseline.map(option => option.name));
    const outside = read.filter(option => !ALLOWED.has(option.name) && !app_options.has(option.name));
    assert.deepStrictEqual(outside, [], described);
    for (const option of baseline.filter(option => !ALLOWED.has(option.name))) {
        assert(read.some(found => found.name === option.name && JSON.stringify(found.values) === JSON.stringify(option.values)),
            `${option.name} ${option.values.join(' ')} no longer reaches yt-dlp: ${described}`);
    }
}

describe('Fuzz: subscription arguments', function() {
    this.timeout(timeout());
    quietLogger();

    const subscriptions_api = require('../subscriptions');
    const sub = {id: 'fuzz-subscription', name: 'Fuzz', type: 'video', isPlaylist: false, user_uid: null};

    // Not filtered through the allowlist first: a stored subscription holds whatever was
    // saved, whenever it was saved, or whatever a backup put back.
    it('reach yt-dlp as allowed options only, whatever a subscription holds', async function() {
        const baseline = optionsRead(await subscriptions_api.generateArgsForSubscription({...sub}, null));
        await check(this, fc.asyncProperty(argsField, async (raw) => {
            const argv = await subscriptions_api.generateArgsForSubscription({...sub, custom_args: raw}, null);
            assertOnlyAllowedAdded(raw, argv, baseline);
        }), [
            ['--no-mtime,,--paths,,elsewhere']
        ]);
    });
});

describe('Fuzz: output templates', function() {
    this.timeout(timeout());
    quietLogger();

    let base;
    let folder;

    before(function() {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-fuzz-output-')));
        folder = path.join(base, 'downloads', 'video');
        fs.mkdirpSync(path.join(folder, 'sub'));
        fs.mkdirpSync(path.join(base, 'downloads', 'video2'));
        fs.mkdirpSync(path.join(base, 'outside'));
        // Links inside the download folder: out of it, within it, and to nothing.
        fs.symlinkSync('../../outside', path.join(folder, 'out'));
        fs.symlinkSync('sub', path.join(folder, 'in'));
        fs.symlinkSync('../../outside/missing', path.join(folder, 'dangling'));
    });

    after(function() {
        if (base) fs.removeSync(base);
    });

    const SEGMENTS = ['..', '.', '', 'sub', 'in', 'out', 'dangling', 'x', '%(title)s', '%(id)s', '...', '..x', 'video', 'video2', 'outside', 'downloads'];
    const template = fc.tuple(fc.boolean(), fc.array(fc.constantFrom(...SEGMENTS), {minLength: 1, maxLength: 6}))
        .map(([absolute, segments]) => `${absolute ? '/' : ''}${segments.join('/')}`);

    // Where yt-dlp's write of a template would land: the downloader joins it onto the folder
    // and adds the extension, yt-dlp fills in each field with a name of its own and creates
    // the directories, and the file goes into the last of them. So that is done here, in a
    // throwaway tree, and the directory found afterwards is the answer.
    function landingDirectory(accepted) {
        let field = 0;
        const output = `${path.join(folder, accepted)}.mp4`.replace(/%\([^)]*\)s/g, () => `field${field++}`);
        let created;
        try {
            created = fs.mkdirSync(path.dirname(output), {recursive: true});
            return fs.realpathSync.native(path.dirname(output));
        } catch {
            // No directory to write into, so nothing is written.
            return null;
        } finally {
            if (created) fs.rmSync(created, {recursive: true, force: true});
        }
    }

    it('write inside the download folder, whatever the fields expand to', async function() {
        await check(this, fc.property(template, (custom_output) => {
            const accepted = utils.sanitizeCustomOutput(custom_output, folder);
            if (accepted === null) return;
            const directory = landingDirectory(accepted);
            if (directory === null) return;
            const relative = path.relative(folder, directory);
            assert(relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)),
                `${JSON.stringify(custom_output)} writes into ${directory}`);
        }));
    });
});
