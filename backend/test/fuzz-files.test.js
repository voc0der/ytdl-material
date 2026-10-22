/*************************************************
 * Fuzz tests: the checks between a request and a
 * file. Media paths come out of database records,
 * which the API can edit, so the containment checks
 * are all that stands between a record and any file
 * the server can read.
 ************************************************/
const fc = require('fast-check');
const os = require('os');
const { assert, fs, path, utils } = require('./test-shared');
const config_api = require('../config');
const { check, timeout } = require('./helpers/fuzz');

// Settings for the length of a describe block, without writing the config file.
function useSettings(settings) {
    let original;
    before(function() {
        original = config_api.getConfigItem;
        config_api.getConfigItem = (key) => (Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : original(key));
    });
    after(function() {
        config_api.getConfigItem = original;
    });
}

// path.relative's answer, read correctly: inside means no '..' segment at the start.
function within(candidate, container) {
    const relative = path.relative(container, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

describe('Fuzz: media paths', function() {
    this.timeout(timeout());

    let base;
    const roots = {};
    const settings = {};
    useSettings(settings);

    before(function() {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-fuzz-media-')));
        for (const root of ['video', 'audio', 'users', 'subscriptions']) roots[root] = path.join(base, 'media', root);
        Object.assign(settings, {
            ytdl_video_folder_path: roots.video,
            ytdl_audio_folder_path: roots.audio,
            ytdl_users_base_path: roots.users,
            ytdl_subscriptions_base_path: roots.subscriptions,
            ytdl_multi_user_mode: false
        });

        // media/video/outside/secret.mp4 shares its name, relative to video/, with the file
        // outside: a path that reaches one by text and the other through a link has two
        // readings, and only the one the OS makes counts.
        const files = [
            'media/video/clip.mp4', 'media/video/..clip.mp4', 'media/video/sub/inner.mp4',
            'media/video/outside/secret.mp4', 'media/audio/song.mp3', 'media/users/alice/video/a.mp4',
            'media/users/bob/video/b.mp4', 'media/subscriptions/channels/x/s.mp4', 'media/video2/clip.mp4',
            'outside/secret.mp4'
        ];
        for (const file of files) fs.outputFileSync(path.join(base, file), 'x');
        // Links from inside the roots: to another root, out of them, to a directory outside,
        // and to nothing.
        fs.symlinkSync('../audio/song.mp3', path.join(roots.video, 'to-audio'));
        fs.symlinkSync('../../outside/secret.mp4', path.join(roots.video, 'to-outside'));
        fs.symlinkSync('../../outside', path.join(roots.video, 'dir-out'));
        fs.symlinkSync('../../outside/missing.mp4', path.join(roots.video, 'dangling'));
    });

    after(function() {
        if (base) fs.removeSync(base);
    });

    const SEGMENTS = [
        'media', 'video', 'audio', 'users', 'subscriptions', 'alice', 'bob', 'channels', 'x', 'sub',
        'clip.mp4', '..clip.mp4', 'inner.mp4', 'song.mp3', 'a.mp4', 'b.mp4', 's.mp4', 'video2', 'outside',
        'secret.mp4', 'to-audio', 'to-outside', 'dir-out', 'dangling', 'missing', '..', '.', ''
    ];
    const candidate = fc.array(fc.constantFrom(...SEGMENTS), {minLength: 1, maxLength: 7})
        .map(segments => `${base}/${segments.join('/')}`);
    const owner = fc.constantFrom(null, 'alice', 'bob', 'carol', '..', 'alice/..', '../users/alice', '');

    // Where the user's media may live: every root, or in multi-user mode the shared ones
    // and the user's own directory inside users/.
    function rootsFor(uid, multi_user) {
        if (!multi_user || !uid) return Object.values(roots);
        const own = path.resolve(roots.users, uid);
        const shared = [roots.video, roots.audio, roots.subscriptions];
        return own.startsWith(roots.users + path.sep) ? [...shared, own] : shared;
    }

    // The file the OS opens for a path. fs.realpathSync collapses '..' before following
    // links, so it can name a different file; the native call doesn't.
    const opens = (candidate_path) => fs.realpathSync.native(candidate_path);

    it('count a path as inside the roots exactly when the file it opens is', async function() {
        await check(this, fc.property(candidate, owner, fc.boolean(), (candidate_path, uid, multi_user) => {
            settings.ytdl_multi_user_mode = multi_user;
            // Only paths that open something: a missing file has nothing to compare.
            if (!fs.existsSync(candidate_path)) return;
            const opened = opens(candidate_path);
            const expected = rootsFor(uid, multi_user).some(root => within(opened, root));
            assert.strictEqual(utils.isPathInsideMediaRoots(candidate_path, uid), expected,
                `${candidate_path} opens ${opened}`);
        }), [
            [`${base}/media/video/..clip.mp4`, null, false],
            [`${base}/media/video/dir-out/../outside/secret.mp4`, null, false]
        ]);
    });

    it('serve only regular files inside the roots', async function() {
        await check(this, fc.property(candidate, owner, fc.boolean(), (candidate_path, uid, multi_user) => {
            settings.ytdl_multi_user_mode = multi_user;
            if (!utils.isServableMediaFile(candidate_path, uid)) return;
            assert(fs.statSync(candidate_path).isFile(), `${candidate_path} is not a file`);
            const opened = opens(candidate_path);
            assert(rootsFor(uid, multi_user).some(root => within(opened, root)), `${candidate_path} opens ${opened}`);
        }), [
            [`${base}/media/video/dir-out/../outside/secret.mp4`, null, false],
            [`${base}/media/media/../video/to-audio`, null, false]
        ]);
    });
});

describe('Fuzz: subscription folders', function() {
    this.timeout(timeout());

    const settings = {};
    useSettings(settings);

    const CHARACTERS = ['a', 'b', '.', '/', '\\', ' ', '\t', '\n', '\r', '\0', ':', '*', '?', ' ', ' ', '​'];
    const text = fc.oneof(
        fc.string({unit: fc.constantFrom(...CHARACTERS), maxLength: 8}),
        fc.string({unit: 'binary', maxLength: 8})
    );
    const filename_settings = fc.record({
        ytdl_replace_invalid_filename_chars: fc.boolean(),
        ytdl_invalid_filename_chars: fc.option(fc.string({unit: fc.constantFrom(...CHARACTERS), maxLength: 4}), {nil: undefined}),
        ytdl_invalid_filename_replacement: fc.option(fc.constantFrom('', '_', '.', '..', '/', '\\', ' ', 'x', '\0'), {nil: undefined})
    });

    it('keep a subscription to one folder inside its type folder', async function() {
        const base = '/srv/subscriptions';
        await check(this, fc.property(text, filename_settings, fc.boolean(), fc.boolean(), (name, chosen, is_playlist, use_subfolder) => {
            Object.keys(settings).forEach(key => delete settings[key]);
            Object.assign(settings, chosen);
            const sub = {name: name, id: 'subscription-id', isPlaylist: is_playlist, use_subfolder: use_subfolder};
            const type_path = path.join(base, is_playlist ? 'playlists' : 'channels');

            const download_path = utils.getSubscriptionDownloadPath(sub, base);
            const metadata_path = utils.getSubscriptionMetadataPath(sub, base);
            if (use_subfolder) {
                assert.strictEqual(path.dirname(download_path), type_path, `${JSON.stringify(name)} became ${download_path}`);
                assert.strictEqual(metadata_path, download_path);
            } else {
                assert.strictEqual(download_path, type_path);
                assert.strictEqual(path.dirname(metadata_path), path.join(type_path, '.metadata'),
                    `${JSON.stringify(name)} became ${metadata_path}`);
            }
        }));
    });
});

describe('Fuzz: byte ranges', function() {
    this.timeout(timeout());

    const size = fc.oneof(fc.constant(0), fc.nat(1000), fc.nat(2 ** 40), fc.constant(Number.MAX_SAFE_INTEGER));
    const number = fc.oneof(fc.nat(2000), fc.bigInt({min: 0n, max: 10n ** 30n}).map(String), fc.constant(''));
    const header = fc.oneof(
        fc.tuple(number, number).map(([start, end]) => `bytes=${start}-${end}`),
        fc.tuple(fc.constantFrom('bytes=', 'Bytes=', 'bytes =', ' bytes=', 'items='), number, fc.constantFrom('-', '--', ','), number,
            fc.constantFrom('', ' ', ',0-1', '-', '\t')).map(parts => parts.join('')),
        fc.string({unit: fc.constantFrom(...'bytes=-0123456789, \t;'), maxLength: 24}),
        fc.string({maxLength: 24})
    );

    it('answer 206 only with a range inside the file, of the length sent', async function() {
        await check(this, fc.property(header, size, (range_header, file_size) => {
            const range = utils.parseByteRange(range_header, file_size);
            if (range === null || range.satisfiable === false) return;
            assert(Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end), JSON.stringify(range));
            assert(range.start >= 0 && range.start <= range.end && range.end < file_size, `${range_header} of ${file_size}: ${JSON.stringify(range)}`);
            assert.strictEqual(range.length, range.end - range.start + 1);
        }));
    });

    it('answer a well-formed range with exactly the bytes it names', async function() {
        await check(this, fc.property(fc.nat(2 ** 40), fc.nat(2 ** 40), fc.nat(2 ** 40), (file_size, a, b) => {
            const [start, end] = a <= b ? [a, b] : [b, a];
            if (end < file_size) {
                assert.deepStrictEqual(utils.parseByteRange(`bytes=${start}-${end}`, file_size), {start, end, length: end - start + 1});
            }
            if (a > 0 && file_size > 0) {
                const first = Math.max(0, file_size - a);
                assert.deepStrictEqual(utils.parseByteRange(`bytes=-${a}`, file_size), {start: first, end: file_size - 1, length: file_size - first});
            }
        }));
    });
});
