const express = require('express');
const rateLimit = require('express-rate-limit');
const request = require('supertest');

const { assert, files_api, fs, os, path, useTemporaryMediaRoots, utils } = require('./test-shared');

/*************************************************
 * Express sends files through `send`, which by
 * default answers 404 for any path containing a
 * dot-directory -- anywhere in an absolute path,
 * not just in the part a request named. Media kept
 * under ~/.local/share, or an install inside a
 * hidden directory, got blank thumbnails and failed
 * downloads while the library itself listed fine.
 *
 * The routes live inside app.js, so these tests
 * send through the same calls on a small app, and
 * a source check holds every real call to them.
 ************************************************/
describe('Sending files from under a dot-directory', function() {
    let base = null;
    let media_roots = null;

    const files = {};

    before(function() {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-send-file-test-'));
        const hidden = path.join(base, '.local', 'share', 'ytdl');

        // The roots themselves sit under the dot-directory, as they would for an install
        // configured to keep its media in ~/.local/share.
        media_roots = useTemporaryMediaRoots({
            'ytdl_video_folder_path': path.join(hidden, 'video'),
            'ytdl_audio_folder_path': path.join(hidden, 'audio'),
            'ytdl_users_base_path': path.join(hidden, 'users'),
            'ytdl_subscriptions_base_path': path.join(hidden, 'subscriptions')
        });

        const video = path.join(hidden, 'video');
        fs.ensureDirSync(video);
        files.thumbnail = path.join(video, 'clip.jpg');
        files.media = path.join(video, 'clip.mp4');
        files.subtitle = path.join(video, 'clip.en.vtt');
        // A dot-directory inside the media folder is the same case one level down.
        files.nested = path.join(video, '.thumbnails', 'clip.jpg');

        fs.writeFileSync(files.thumbnail, 'thumbnail bytes');
        fs.writeFileSync(files.media, 'media bytes');
        fs.writeFileSync(files.subtitle, 'WEBVTT\n');
        fs.ensureDirSync(path.dirname(files.nested));
        fs.writeFileSync(files.nested, 'nested thumbnail bytes');
    });

    after(function() {
        if (media_roots) media_roots.restore();
        if (base) fs.removeSync(base);
    });

    // One route per call shape app.js uses: plain, with a completion callback, and a
    // download under a display name. Built like the real routes: the file is decided on
    // the server, never taken from the request, and reading it is rate limited.
    function appSending(file_path, options_for_call) {
        const app = express();
        // The unhandled 404 in the default case would otherwise print a stack trace.
        app.set('env', 'test');
        app.use(rateLimit({
            windowMs: 60 * 1000,
            max: 100,
            standardHeaders: false,
            legacyHeaders: false
        }));
        app.get('/send', (req, res) => {
            res.sendFile(file_path, options_for_call());
        });
        app.get('/send-with-callback', (req, res) => {
            res.sendFile(file_path, options_for_call(), (err) => {
                if (!err || res.headersSent) return;
                res.sendStatus(err.statusCode === 404 ? 404 : 500);
            });
        });
        app.get('/download', (req, res) => {
            res.download(file_path, 'Display Name.zip', options_for_call(), (err) => {
                if (err && !res.headersSent) res.sendStatus(err.statusCode || 500);
            });
        });
        return app;
    }

    it('is refused by Express\'s own default', async function() {
        // The reason sendFileOptions exists. If this starts passing, Express has changed
        // its default and the option may no longer be needed.
        await request(appSending(files.thumbnail, () => ({}))).get('/send').expect(404);
        await request(appSending(files.media, () => ({}))).get('/download').expect(404);
    });

    it('serves a file with sendFileOptions', async function() {
        const response = await request(appSending(files.subtitle, utils.sendFileOptions))
            .get('/send').expect(200);

        assert.strictEqual(response.text, 'WEBVTT\n');
    });

    it('serves through a completion callback, as the thumbnail route does', async function() {
        const response = await request(appSending(files.thumbnail, utils.sendFileOptions))
            .get('/send-with-callback').buffer(true).parse(binaryParser)
            .expect(200);

        assert.strictEqual(response.body.toString(), 'thumbnail bytes');
    });

    it('downloads under a display name', async function() {
        const response = await request(appSending(files.media, utils.sendFileOptions))
            .get('/download').buffer(true).parse(binaryParser)
            .expect(200);

        assert.strictEqual(response.body.toString(), 'media bytes');
        assert.match(response.headers['content-disposition'], /^attachment; filename="Display Name\.zip"/);
    });

    it('serves a dot-directory inside the media folder too', async function() {
        const response = await request(appSending(files.nested, utils.sendFileOptions))
            .get('/send').buffer(true).parse(binaryParser)
            .expect(200);

        assert.strictEqual(response.body.toString(), 'nested thumbnail bytes');
    });

    it('still answers 404 for a file that does not exist', async function() {
        const missing = path.join(path.dirname(files.media), 'missing.jpg');

        await request(appSending(missing, utils.sendFileOptions)).get('/send-with-callback').expect(404);
    });

    it('lets the media path checks through before the send', async function() {
        // The routes only reach the send once these say yes, so a dot-directory that
        // tripped them would fail the same way further up.
        assert(utils.isPathInsideMediaRoots(files.thumbnail));
        assert(utils.isServableMediaFile(files.media));

        const original_getVideo = files_api.getVideo;
        files_api.getVideo = async () => ({uid: 'clip', thumbnailPath: files.thumbnail});
        try {
            assert.strictEqual(await files_api.getThumbnailPathForUser('clip'), path.resolve(files.thumbnail));
        } finally {
            files_api.getVideo = original_getVideo;
        }
    });

    it('hands out a fresh options object each call', function() {
        // Express writes its etag setting onto the options it is given, so a shared object
        // would carry one response's settings into the next.
        assert.notStrictEqual(utils.sendFileOptions(), utils.sendFileOptions());
        assert.deepStrictEqual(utils.sendFileOptions(), {dotfiles: 'allow'});
    });

    it('is passed by every sendFile and download in the backend', function() {
        const backend = path.join(__dirname, '..');
        // The media folders are skipped too: on a development checkout they hold downloads.
        const skipped = new Set(['node_modules', 'test', 'public', 'appdata', 'coverage', 'audio', 'video', 'users', 'subscriptions']);
        const sources = [];
        const walk = (directory) => {
            for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
                if (entry.isDirectory()) {
                    if (!skipped.has(entry.name)) walk(path.join(directory, entry.name));
                } else if (entry.name.endsWith('.js')) {
                    sources.push(path.join(directory, entry.name));
                }
            }
        };
        walk(backend);

        const calls = [];
        for (const source of sources) {
            fs.readFileSync(source, 'utf8').split('\n').forEach((line, index) => {
                if (/\bres\.(sendFile|download)\(/.test(line)) {
                    calls.push({where: `${path.relative(backend, source)}:${index + 1}`, line: line.trim()});
                }
            });
        }

        assert(calls.length >= 5, `expected to find the file-sending routes, found ${calls.length}`);
        const missing = calls.filter(call => !call.line.includes('utils.sendFileOptions()'));
        assert.deepStrictEqual(missing, [],
            'a send without sendFileOptions 404s for media under a dot-directory');
    });
});

function binaryParser(response, callback) {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
}
