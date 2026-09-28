const assert = require('assert');
const child_process = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const {promisify} = require('util');
const {useTemporaryMediaRoots} = require('./test-shared');
const twitch_api = require('../twitch');
const logger = require('../logger');

// What TwitchDownloaderCLI writes, trimmed to the fields that are read back.
const CLI_OUTPUT = {
    comments: [
        {content_offset_seconds: 4.2, commenter: {name: 'first_viewer'}, message: {body: 'hello', user_color: '#FF0000'}},
        {content_offset_seconds: 3725, commenter: {name: 'late_viewer'}, message: {body: 'still here', user_color: null}}
    ]
};
const CHAT = [
    {timestamp: 4.2, timestamp_str: '00:00:04', name: 'first_viewer', message: 'hello', user_color: '#FF0000'},
    {timestamp: 3725, timestamp_str: '01:02:05', name: 'late_viewer', message: 'still here', user_color: null}
];

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

        it('logs the error itself when the CLI fails without saying why', async function() {
            stubExecFile(() => { throw Object.assign(new Error('killed by SIGKILL'), {code: null}); });
            assert.strictEqual(await twitch_api.getCommentsForVOD('abc123'), null);
            assert(errors.some(message => message.includes('killed by SIGKILL')));
        });

        it('returns null when the CLI reports a problem on stderr', async function() {
            stubExecFile(() => ({stdout: '', stderr: 'Unable to find VOD'}));
            assert.strictEqual(await twitch_api.getCommentsForVOD('abc123'), null);
            assert(errors.some(message => message.includes('Unable to find VOD')));
        });

        it('reads the chat the CLI wrote and removes its temporary file', async function() {
            const output_path = path.resolve('appdata', 'ytdltest1.json');
            try {
                stubExecFile((file, args) => {
                    assert.strictEqual(path.resolve(args[args.indexOf('-o') + 1]), output_path);
                    fs.writeJSONSync(output_path, CLI_OUTPUT);
                    return {stdout: '', stderr: ''};
                });

                assert.deepStrictEqual(await twitch_api.getCommentsForVOD('ytdltest1'), CHAT);
                assert(!fs.existsSync(output_path), 'the temporary chat file was left in appdata');
            } finally {
                fs.removeSync(output_path);
            }
        });
    });

    describe('saved chat', function() {
        let media;
        let originals;
        let errors;

        // The CLI writes its output into appdata, where getCommentsForVOD reads and deletes it.
        function cliWrites(output) {
            const stub = () => { throw new Error('expected the promisified execFile'); };
            stub[promisify.custom] = async (file, args) => {
                fs.writeJSONSync(args[args.indexOf('-o') + 1], output);
                return {stdout: '', stderr: ''};
            };
            child_process.execFile = stub;
        }

        beforeEach(function() {
            media = useTemporaryMediaRoots();
            errors = [];
            originals = {execFile: child_process.execFile, error: logger.error};
            logger.error = message => errors.push(String(message));
            cliWrites(CLI_OUTPUT);
        });

        afterEach(function() {
            child_process.execFile = originals.execFile;
            logger.error = originals.error;
            fs.removeSync(path.resolve('appdata', 'ytdltest2.json'));
            media.restore();
        });

        function chatPath(...segments) {
            return path.join(...segments.slice(0, -1), `${segments[segments.length - 1]}.twitch_chat.json`);
        }

        const layouts = [
            {
                name: 'a video in the shared folder',
                args: ['video', null, null],
                folder: () => media.video
            },
            {
                name: 'an audio file in the shared folder',
                args: ['audio', null, null],
                folder: () => media.audio
            },
            {
                name: "a video in a user's folder",
                args: ['video', 'alice', null],
                folder: () => path.join(media.users, 'alice', 'video')
            },
            {
                name: "a channel subscription in a user's folder",
                args: ['video', 'alice', {name: 'Some Channel', isPlaylist: false}],
                folder: () => path.join(media.users, 'alice', 'subscriptions', 'channels', 'Some Channel')
            },
            {
                name: 'a playlist subscription in the shared folder',
                args: ['video', null, {name: 'Some Playlist', isPlaylist: true}],
                folder: () => path.join(media.subscriptions, 'playlists', 'Some Playlist')
            }
        ];

        for (const layout of layouts) {
            it(`saves and reads back the chat for ${layout.name}`, async function() {
                const [type, user_uid, sub] = layout.args;
                fs.ensureDirSync(layout.folder());

                const chat = await twitch_api.downloadTwitchChatByVODID('ytdltest2', 'file-1', type, user_uid, sub);

                assert.deepStrictEqual(chat, CHAT);
                assert.deepStrictEqual(fs.readJSONSync(chatPath(layout.folder(), 'file-1')), CHAT);
                assert.deepStrictEqual(await twitch_api.getTwitchChatByFileID('file-1', type, user_uid, null, sub), CHAT);
            });
        }

        it('saves into a folder the caller names', async function() {
            const folder = path.join(media.video, 'custom');
            fs.ensureDirSync(folder);

            assert.deepStrictEqual(await twitch_api.downloadTwitchChatByVODID('ytdltest2', 'file-1', 'video', 'alice', null, folder), CHAT);
            assert.deepStrictEqual(fs.readJSONSync(chatPath(folder, 'file-1')), CHAT);
            assert(!fs.existsSync(chatPath(media.users, 'alice', 'video', 'file-1')));
        });

        it('reads nothing for a file with no saved chat', async function() {
            assert.strictEqual(await twitch_api.getTwitchChatByFileID('never-saved', 'video', null, null, null), null);
        });

        it('refuses a type that is not audio or video', async function() {
            assert.strictEqual(await twitch_api.getTwitchChatByFileID('file-1', '../video', null, null, null), null);
            assert.strictEqual(await twitch_api.getTwitchChatByFileID('file-1', 'playlist', 'alice', null, null), null);
            assert.strictEqual(await twitch_api.downloadTwitchChatByVODID('ytdltest2', 'file-1', 'playlist', null, null), null);
            assert.strictEqual(await twitch_api.downloadTwitchChatByVODID('ytdltest2', 'file-1', 'playlist', 'alice', null), null);
        });

        it('will not read chat from outside the folder it belongs in', async function() {
            fs.writeJSONSync(chatPath(media.base, 'secret'), [{message: 'not yours'}]);

            assert.strictEqual(await twitch_api.getTwitchChatByFileID('../secret', 'video', null, null, null), null);
            assert.strictEqual(await twitch_api.getTwitchChatByFileID('secret', 'video', null, null, {name: '../..', isPlaylist: false}), null);
            assert.strictEqual(errors.filter(message => message.includes('Refusing to read twitch chat')).length, 2);
        });

        it('will not write chat outside the folder it belongs in', async function() {
            assert.strictEqual(await twitch_api.downloadTwitchChatByVODID('ytdltest2', '../escaped', 'video', 'alice', null), null);

            assert(!fs.existsSync(chatPath(media.users, 'alice', 'escaped')));
            assert(errors.some(message => message.includes('Refusing to write twitch chat')), errors.join('\n'));
        });

        it('saves nothing when the chat could not be downloaded', async function() {
            const stub = () => { throw new Error('expected the promisified execFile'); };
            stub[promisify.custom] = async () => { throw Object.assign(new Error('spawn ENOENT'), {code: 'ENOENT'}); };
            child_process.execFile = stub;

            assert.strictEqual(await twitch_api.downloadTwitchChatByVODID('ytdltest2', 'file-1', 'video', null, null), null);
            assert(!fs.existsSync(chatPath(media.video, 'file-1')));
        });
    });
});
