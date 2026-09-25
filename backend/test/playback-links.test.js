const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const ID = 'AbcD_123-xy';

describe('Playback links', function() {
    const cleanup = [];
    afterEach(async function() {
        while (cleanup.length) await cleanup.pop()();
    });

    function fixture() {
        const state = {now: 1000, multiUser: true, records: [
            {uid: 'file-1', user_uid: 'alice', source_id: ID, source_extractor: 'youtube',
             isAudio: false, path: 'video.mp4', url: 'https://www.youtube.com/watch?v=' + ID}
        ]};
        const config = {getConfigItem: () => state.multiUser};
        const files = {
            getVideo: async (uid, owner) => state.records.find(f => f.uid === uid && (!state.multiUser || f.user_uid === owner)),
            extractSourceMetadataFromUrl: url => {
                if (!url) return null;
                const parsed = new URL(url);
                if (parsed.hostname === 'www.youtube.com') return {source_extractor: 'youtube', source_id: parsed.searchParams.get('v')};
                if (parsed.hostname === 'youtu.be') return {source_extractor: 'youtube', source_id: parsed.pathname.slice(1)};
                return null;
            }
        };
        const db = {getRecords: async (table, filter) => {
            assert.equal(table, 'files');
            assert.equal(filter.isAudio, false);
            assert.equal('user_uid' in filter, state.multiUser);
            // PostgreSQL rejects Mongo operators, so every term must be plain equality.
            for (const [key, value] of Object.entries(filter)) {
                assert.ok(!key.startsWith('$') && (typeof value !== 'object' || value === null),
                    'non-portable filter term: ' + key);
            }
            state.filter = filter;
            return state.records.filter(f => Object.entries(filter).every(([k, v]) => f[k] === v));
        }};
        const utils = {
            isServableMediaFile: p => p !== 'missing.mp4',
            parseByteRange: (range, size) => {
                if (!range) return null;
                const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range);
                if (+start >= size) return {satisfiable: false};
                return {start: +start, end: +end, length: end - start + 1};
            },
            pipeMediaFileToResponse: (stream, res) => stream.pipe(res)
        };
        const transcode = {requested: [], reaped: [], ready: false, copy: {status: 'missing'},
            request(file) {this.requested.push(file.uid); return this.ready;},
            getCopy() {return this.copy;},
            reap(max_age, in_use) {this.reaped.push({max_age, in_use}); return {removed: 0, kept: 0};}};
        const exports = {};
        vm.runInNewContext(fs.readFileSync(path.join(root, 'playback-links.js'), 'utf8'), {
            exports, URLSearchParams, Date: {now: () => state.now},
            require: name => ({'./db': db, './files': files, './config': config, './utils': utils,
                './playback-transcode': transcode}[name] || require(name))
        });
        function request(owner = 'alice', body = {youtube_id: ID}) {
            return {user: owner ? {uid: owner} : undefined, isAuthenticated: () => !!owner, body};
        }
        function response() {
            return {statusCode: 200, headers: {}, set(k, v) {this.headers[k] = v; return this;},
                    sendStatus(s) {this.statusCode = s; return this;}, json(value) {this.body = value; return this;}};
        }
        async function create(owner, body) {
            const res = response(); await exports.create(request(owner, body), res); return res;
        }
        async function stream(link, overrides = {}) {
            const req = {path: '/api/stream', method: 'GET', query: Object.fromEntries(new URL('http://local' + link).searchParams), ...overrides};
            const res = response(); let passed = false;
            await exports.authorizeStream((_req, r) => r.sendStatus(401), () => assert.fail('guard skipped'))(req, res, () => {passed = true;});
            return {req, res, passed};
        }
        return {state, config, files, utils, transcode, exports, request, response, create, stream};
    }

    it('exact source lookup is owner-scoped and returns only one-file credentials', async () => {
        const f = fixture(); const res = await f.create('alice');
        assert.equal(res.statusCode, 200); assert.equal(f.state.filter.user_uid, 'alice');
        assert.deepEqual(Object.keys(res.body).sort(), ['expires_at', 'stream_path', 'uid']);
        assert.match(res.body.stream_path, /^\/api\/stream\?uid=file-1&playback_token=[\w-]{43}$/);
        const allowed = await f.stream(res.body.stream_path);
        assert.equal(allowed.passed, true);
        assert.equal(allowed.req.user, undefined); // no account identity is granted
        assert.equal(allowed.req.playback.owner, 'alice');
    });

    it('another user cannot select the file by source ID or UID', async () => {
        const f = fixture();
        assert.equal((await f.create('bob')).statusCode, 404);
        assert.equal((await f.create('bob', {uid: 'file-1'})).statusCode, 404);
        assert.equal((await f.create(null)).statusCode, 401);
    });

    it('audio copies, unrelated titles and filename IDs do not match', async () => {
        const f = fixture();
        for (const record of [
            {...f.state.records[0], isAudio: true},
            {...f.state.records[0], source_id: 'DifferentID', url: 'https://www.youtube.com/watch?v=DifferentID'},
            {uid: 'file-1', user_uid: 'alice', id: ID, isAudio: false, path: 'video.mp4', title: ID}
        ]) {
            f.state.records = [record];
            assert.equal((await f.create('alice')).statusCode, 404);
        }
    });

    it('old URL metadata and subscription files work; missing duplicate is skipped', async () => {
        const f = fixture(); const file = f.state.records[0];
        f.state.records = [{...file, path: 'missing.mp4'}, {...file, uid: 'sub-file',
            source_id: undefined, source_extractor: undefined, sub_id: 'subscription', url: 'https://youtu.be/' + ID}];
        assert.equal((await f.create('alice')).body.uid, 'sub-file');
    });

    it('invalid input is rejected and caller-supplied owner is ignored', async () => {
        const f = fixture();
        for (const body of [{}, {youtube_id: {$ne: ''}}, {youtube_id: 'x.*'}, {uid: 'file-1', youtube_id: ID}]) {
            assert.equal((await f.create('alice', body)).statusCode, 400);
        }
        assert.equal((await f.create('bob', {uid: 'file-1', uuid: 'alice'})).statusCode, 404);
    });

    it('transcoding is opt-in, boolean only, and carried by the link', async () => {
        const f = fixture();
        for (const transcode of ['yes', 1, null, {}]) {
            assert.equal((await f.create('alice', {youtube_id: ID, transcode})).statusCode, 400);
        }
        const plain = await f.create('alice', {youtube_id: ID, transcode: false});
        assert.deepEqual(Object.keys(plain.body).sort(), ['expires_at', 'stream_path', 'uid']);
        assert.equal((await f.stream(plain.body.stream_path)).req.playback.transcode, false);
        assert.deepEqual(f.transcode.requested, []);

        const res = await f.create('alice', {uid: 'file-1', transcode: true});
        assert.equal(res.body.transcode, true); assert.equal(res.body.ready, false);
        assert.deepEqual(f.transcode.requested, ['file-1']);
        assert.equal((await f.stream(res.body.stream_path)).req.playback.transcode, true);
        f.transcode.ready = true;
        assert.equal((await f.create('alice', {uid: 'file-1', transcode: true})).body.ready, true);
    });

    it('reaping keeps copies unexpired transcoding links use, and waits as long as a link lives', async () => {
        const f = fixture();
        f.state.records.push({...f.state.records[0], uid: 'file-2', source_id: 'OtherID_123', url: undefined});
        const res = await f.create('alice', {uid: 'file-1', transcode: true});
        await f.create('alice', {uid: 'file-2'});
        await f.exports.reapTranscodes();
        const [{max_age, in_use}] = f.transcode.reaped;
        assert.equal(max_age, res.body.expires_at - f.state.now);
        assert.deepEqual(Array.from(in_use()), ['file-1']);
        f.state.now = res.body.expires_at;
        assert.deepEqual(Array.from(in_use()), []);
    });

    it('ticket cannot select a different file, owner, route, method or auth scheme', async () => {
        const f = fixture(); const link = (await f.create('alice')).body.stream_path;
        for (const suffix of ['&uuid=bob', '&sub_id=x', '&jwt=x', '&playlist_id=x', '&library=bob']) {
            assert.equal((await f.stream(link + suffix)).res.statusCode, 403);
        }
        assert.equal((await f.stream(link.replace('file-1', 'file-2'))).res.statusCode, 403);
        assert.equal((await f.stream(link, {method: 'POST'})).res.statusCode, 403);
        assert.equal((await f.stream(link, {path: '/api/getAllFiles'})).res.statusCode, 403);
        assert.equal((await f.stream(link.replace(/.$/, '!'))).res.statusCode, 401);
    });

    it('expiry, ownership changes and server restart invalidate the ticket', async () => {
        const f = fixture(); const res = await f.create('alice'); const link = res.body.stream_path;
        f.state.records[0].user_uid = 'bob';
        assert.equal((await f.stream(link)).res.statusCode, 404);
        f.state.records[0].user_uid = 'alice'; f.state.now = res.body.expires_at;
        assert.equal((await f.stream(link)).res.statusCode, 401);
        assert.equal((await fixture().stream(link)).res.statusCode, 401);
    });

    it('requests without tickets follow the existing auth and shared guard', async () => {
        const f = fixture(); const calls = [];
        const wrapper = f.exports.authorizeStream((_q, _s, next) => {calls.push('auth'); return next();},
            (_q, _s, next) => {calls.push('guard'); return next();});
        await wrapper({query: {}}, f.response(), () => calls.push('handler'));
        assert.deepEqual(calls, ['auth', 'guard', 'handler']);
    });

    it('single-user mode works but changing auth mode revokes issued links', async () => {
        const f = fixture(); f.state.multiUser = false;
        const link = (await f.create(null)).body.stream_path;
        assert.equal((await f.stream(link)).passed, true);
        f.state.multiUser = true;
        assert.equal((await f.stream(link)).res.statusCode, 403);
    });

    it('real HTTP route serves HEAD and byte ranges, transcoding links their copy; sharing permission gates creation', async () => {
        const f = fixture(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-playback-'));
        cleanup.push(() => fs.rmSync(dir, {recursive: true, force: true}));
        const file = path.join(dir, 'video.mp4'); fs.writeFileSync(file, '0123456789');
        f.state.records[0].path = file;
        const routes = new Map();
        const app = Object.fromEntries(['get', 'post'].map(method => [method, (url, ...handlers) => routes.set(method.toUpperCase() + url, handlers)]));
        const optionalJwt = (req, res, next) => {
            if (req.headers.authorization !== 'Bearer alice-key') return res.sendStatus(401);
            req.user = {uid: 'alice'}; req.isAuthenticated = () => true; return next();
        };
        const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
        const block = source.slice(source.indexOf("app.post('/api/createPlaybackLink'"), source.indexOf("app.get('/api/streamSubtitle'"));
        vm.runInNewContext(block, {app, playback_links: f.exports, playback_transcode: f.transcode, optionalJwt,
            requirePermission: permission => {assert.equal(permission, 'sharing'); return (req, res, next) => req.headers['x-no-sharing'] ? res.sendStatus(403) : next();},
            requireAuthenticatedOrShared: (_req, _res, next) => next(),
            // A playback link never names a library -- authorizeStream refuses one that does.
            resolveLibraryOwner: (_req, _res, next) => next(),
            libraryOwnerUid: req => req.user ? req.user.uid : null,
            config_api: f.config, files_api: f.files, utils: f.utils, fs,
            mime: {lookup: () => 'video/mp4'}, logger: {warn() {}, error() {}}});
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, 'http://local'); req.path = url.pathname;
            req.query = Object.fromEntries(url.searchParams); req.isAuthenticated = () => false;
            res.set = (k, v) => {res.setHeader(k, v); return res;};
            res.status = code => {res.statusCode = code; return res;};
            res.type = value => {res.setHeader('Content-Type', value); return res;};
            res.send = value => res.end(value);
            res.json = value => res.end(JSON.stringify(value));
            res.sendStatus = code => {res.statusCode = code; res.end();};
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            req.body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
            const handlers = routes.get((req.method === 'HEAD' ? 'GET' : req.method) + req.path);
            let i = 0; const next = () => handlers[i++](req, res, next);
            try { await next(); } catch {res.statusCode = 500; res.end('Internal server error');}
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        cleanup.push(async () => {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        });
        const base = 'http://127.0.0.1:' + server.address().port;
        const options = {method: 'POST', headers: {Authorization: 'Bearer alice-key'}, body: JSON.stringify({youtube_id: ID})};
        assert.equal((await fetch(base + '/api/createPlaybackLink', {...options, headers: {...options.headers, 'x-no-sharing': '1'}})).status, 403);
        const created = await fetch(base + '/api/createPlaybackLink', options);
        assert.equal(created.status, 200); const link = (await created.json()).stream_path;
        const head = await fetch(base + link, {method: 'HEAD'});
        assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
        const range = await fetch(base + link, {headers: {Range: 'bytes=2-5'}});
        assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await range.text(), '2345');
        assert.equal((await fetch(base + link.replace('file-1', 'other'))).status, 403);
        assert.equal((await fetch(base + '/api/createPlaybackLink?' + link.split('?')[1], {method: 'POST'})).status, 401);

        const copy = path.join(dir, 'copy.mp4'); fs.writeFileSync(copy, 'abcdefghijkl');
        const transcoded = await fetch(base + '/api/createPlaybackLink', {...options, body: JSON.stringify({uid: 'file-1', transcode: true})});
        const transcode_link = (await transcoded.json()).stream_path;
        f.transcode.copy = {status: 'pending'};
        const pending = await fetch(base + transcode_link, {method: 'HEAD'});
        assert.equal(pending.status, 503); assert.equal(pending.headers.get('retry-after'), '10');
        f.transcode.copy = {status: 'failed'};
        assert.equal((await fetch(base + transcode_link)).status, 500);
        f.transcode.copy = {status: 'missing'};
        assert.equal((await fetch(base + transcode_link)).status, 404);
        f.transcode.copy = {status: 'ready', path: copy};
        const copy_head = await fetch(base + transcode_link, {method: 'HEAD'});
        assert.equal(copy_head.status, 200); assert.equal(copy_head.headers.get('content-length'), '12');
        const copy_range = await fetch(base + transcode_link, {headers: {Range: 'bytes=2-5'}});
        assert.equal(copy_range.status, 206); assert.equal(await copy_range.text(), 'cdef');
        // the plain link still gets the original
        assert.equal(await (await fetch(base + link, {headers: {Range: 'bytes=2-5'}})).text(), '2345');
    });
});
