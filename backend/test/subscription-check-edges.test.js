const { assert, path, fs, uuid, db_api, config_api, subscriptions_api, youtubedl_api, files_api, downloader_api,
    useTemporaryMediaRoots } = require('./test-shared');
const logger = require('../logger');

// What a subscription check does away from its usual path: arguments it is seldom given, lookups
// that fail beside it, a queue that cannot keep up, and what it finds already there.
describe('Subscription check edges', function() {
    const channel_id = 'UCzofo-P8yMMCOv8rsPfIR-g';
    const tables = ['subscriptions', 'download_queue', 'files', 'archives', 'playlists'];
    let media;
    let originals;
    let logged;
    const stub = (object, name, value) => { originals.push([object, name, object[name]]); object[name] = value; };
    const subscription = (fields = {}) => ({
        id: uuid(), name: `edge_sub_${uuid().slice(0, 8)}`, url: `https://www.youtube.com/channel/${channel_id}`, type: 'video',
        user_uid: null, paused: true, maxQuality: null, source_info_checked_at: Date.now(), ...fields
    });
    const upload = (id, fields = {}) => ({ _type: 'url', extractor: 'youtube', id, title: id,
        webpage_url: `https://www.youtube.com/watch?v=${id}`, url: `https://www.youtube.com/watch?v=${id}`, ...fields });
    const waitFor = async (predicate, timeout_ms = 4000) => {
        const start = Date.now();
        while (Date.now() - start < timeout_ms) {
            if (await predicate()) return true;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        return false;
    };
    const checkAndWait = async sub_id => {
        assert.strictEqual(await subscriptions_api.getVideosForSub(sub_id), true);
        assert(await waitFor(async () => {
            const current = await subscriptions_api.getSubscription(sub_id);
            return !!(current && !current.downloading);
        }));
    };
    // The check reads its listing line by line, as yt-dlp prints it.
    const listing = (outputs, err = null) => stub(youtubedl_api, 'runYoutubeDLLineStream', async (url, args, handlers) => {
        for (const output of outputs) handlers.onStdoutLine(typeof output === 'string' ? output : JSON.stringify(output));
        return { child_process: { pid: 4321 }, callback: Promise.resolve({ err }) };
    });
    const queuedUrls = async sub_id => (await db_api.getRecords('download_queue', { sub_id })).map(download => download.url).sort();

    beforeEach(async function() {
        originals = [];
        logged = [];
        media = useTemporaryMediaRoots({ ytdl_allow_subscriptions: true, ytdl_custom_args: '', ytdl_multi_user_mode: false,
            ytdl_use_cookies: false, ytdl_download_rate_limit: '', ytdl_skip_join_only_videos: false, ytdl_max_concurrent_downloads: 0,
            ytdl_include_thumbnail: false, ytdl_default_downloader: 'yt-dlp' });
        for (const table of tables) await db_api.removeAllRecords(table);
        // Nothing here may reach a real yt-dlp process.
        stub(youtubedl_api, 'runYoutubeDL', async () => ({ child_process: null, callback: Promise.resolve({ parsed_output: [{}], err: null }) }));
        listing([]);
        stub(logger, 'warn', message => logged.push(`warn: ${message}`));
        stub(logger, 'error', message => logged.push(`error: ${message}`));
    });

    afterEach(async function() {
        for (const [object, name, value] of originals.reverse()) object[name] = value;
        for (const table of tables) await db_api.removeAllRecords(table);
        media.restore();
    });

    it('asks for a height limit, a rate limit and the cookies file, and warns when the cookies file is gone', async function() {
        const cookies = path.join(__dirname, '..', 'appdata', 'cookies.txt');
        let cookies_exist = true;
        const real_path_exists = fs.pathExists;
        stub(fs, 'pathExists', async file => file === cookies ? cookies_exist : real_path_exists(file));
        config_api.setConfigItem('ytdl_use_cookies', true);
        config_api.setConfigItem('ytdl_download_rate_limit', '2M');
        const sub = subscription({ maxQuality: '720' });
        const after = (args, flag) => args[args.indexOf(flag) + 1];

        let args = await subscriptions_api.generateArgsForSubscription(sub, null);
        assert.strictEqual(after(args, '-f'), 'bestvideo[height<=720]+bestaudio/best[height<=720]');
        assert.strictEqual(after(args, '--merge-output-format'), 'mp4');
        assert.strictEqual(after(args, '-r'), '2M');
        assert.strictEqual(after(args, '--cookies'), path.join('appdata', 'cookies.txt'));

        cookies_exist = false;
        args = await subscriptions_api.generateArgsForSubscription(sub, null);
        assert(!args.includes('--cookies'));
        assert.deepStrictEqual(logged, ['warn: Cookies file could not be found. You can either upload one, or disable \'use cookies\' in the Advanced tab in the settings.']);
    });

    it('shows a check that a restart cut short as stopped, and finds a subscription by name within its account', async function() {
        const sub = subscription({ user_uid: 'alice', downloading: false,
            refresh_status: { active: true, phase: 'collecting', started_at: Date.now() - 1000 } });
        await db_api.insertRecordIntoTable('subscriptions', sub);

        const read = await subscriptions_api.getSubscription(sub.id);
        assert.deepStrictEqual([read.refresh_status.active, read.refresh_status.phase], [false, 'cancelled']);

        config_api.setConfigItem('ytdl_multi_user_mode', true);
        assert.strictEqual((await subscriptions_api.getSubscriptionByName(sub.name, 'alice')).id, sub.id);
        assert.strictEqual(await subscriptions_api.getSubscriptionByName(sub.name, 'bob'), undefined);
    });

    it('closes what is still playing from a subscription it deletes, even when one of them will not close', async function() {
        const sub = subscription();
        await subscriptions_api.subscribe(sub, null, true);
        await db_api.insertRecordIntoTable('files', { uid: 'playing', sub_id: sub.id, title: 'Playing', path: path.join(media.base, 'a.mp4') });
        await db_api.insertRecordIntoTable('files', { uid: 'stuck', sub_id: sub.id, title: 'Stuck', path: path.join(media.base, 'b.mp4') });
        const closed = [];
        stub(config_api, 'descriptors', {
            playing: [{ destroy: () => closed.push('first') }, { destroy: () => closed.push('second') }],
            stuck: [{ destroy: () => { throw new Error('already closed'); } }]
        });

        const result = await subscriptions_api.unsubscribe(sub.id, false);

        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(closed, ['first', 'second']);
        assert.strictEqual(await db_api.getRecord('subscriptions', { id: sub.id }), undefined);
    });

    it('starts no redownload when deleting one of the files throws', async function() {
        const sub = subscription();
        await subscriptions_api.subscribe(sub, null, true);
        await db_api.insertRecordIntoTable('files', { uid: 'kept', sub_id: sub.id, title: 'Kept', path: path.join(media.base, 'kept.mp4') });
        stub(files_api, 'deleteFile', async () => { throw new Error('permission denied'); });

        const result = await subscriptions_api.redownloadSubscription(sub.id);

        assert.strictEqual(result.success, false);
        assert.deepStrictEqual(logged.slice(0, 2), ['error: Failed to delete subscription file \'kept\' before redownload.',
            'error: Error: permission denied']);
    });

    it('skips a subscription deleted while the scheduled check was getting to it', async function() {
        const kept = subscription();
        const deleted = subscription();
        for (const sub of [kept, deleted]) {
            await subscriptions_api.subscribe(sub, null, true);
            // Subscribed paused, or subscribing would start a check of its own.
            await db_api.updateRecord('subscriptions', { id: sub.id }, { paused: false });
        }
        const real_get_subscription = subscriptions_api.getSubscription;
        stub(subscriptions_api, 'getSubscription', async (sub_id, ...rest) => sub_id === deleted.id ? null : real_get_subscription(sub_id, ...rest));
        const checked = [];
        stub(subscriptions_api, 'getVideosForSub', async sub_id => { checked.push(sub_id); return true; });

        const result = await subscriptions_api.checkSubscriptions();

        assert.deepStrictEqual(checked, [kept.id]);
        assert.deepStrictEqual(result.skipped_sub_ids, [deleted.id]);
    });

    it('reads match filters written inline, and lets through an upload whose availability it cannot tell', async function() {
        config_api.setConfigItem('ytdl_custom_args',
            '--match-filter=duration>60,,--no-match-filters,,--match-filter=availability=public,,--match-filter=title~=talk');
        let discovery_args = null;
        const sub = subscription();
        await subscriptions_api.subscribe(sub, null, true);
        const outputs = [
            upload('public-upload'),
            upload('private-upload', { availability: 'private' }),
            // Not from the site, so a flat entry with no availability is not taken to be public.
            { extractor: 'generic', id: 'elsewhere', title: 'Elsewhere', webpage_url: 'https://example.test/elsewhere' },
            // Entries told apart by what little they carry; none of them can be downloaded.
            { url: 'https://example.test/only-a-link' }, { title: 'Only a title' }, { _type: 'url' }
        ];
        stub(youtubedl_api, 'runYoutubeDLLineStream', async (url, args, handlers) => {
            discovery_args = args;
            for (const output of outputs) handlers.onStdoutLine(JSON.stringify(output));
            return { child_process: { pid: 4321 }, callback: Promise.resolve({ err: null }) };
        });

        await checkAndWait(sub.id);

        assert(!discovery_args.includes('--match-filter=availability=public'));
        assert(discovery_args.includes('--match-filter=title~=talk'));
        assert.deepStrictEqual(await queuedUrls(sub.id), ['https://example.test/elsewhere', 'https://www.youtube.com/watch?v=public-upload']);
        assert.strictEqual((await db_api.getRecord('subscriptions', { id: sub.id })).refresh_status.discovered_count, 6);
    });

    it('goes ahead with the check when the lookups beside it fail', async function() {
        const sub = subscription({ timerange: 'now-1week', channel_id, retrieve_channel_playlists: true, source_info_checked_at: null });
        await subscriptions_api.subscribe(sub, null, true);
        stub(youtubedl_api, 'runYoutubeDL', async () => { throw new Error('lookup failed'); });
        stub(youtubedl_api, 'runYoutubeDLLineStream', async (url, args, handlers) => {
            // The listing that would stop at the date filter.
            if (args.includes('--print')) throw new Error('listing failed');
            handlers.onStdoutLine(JSON.stringify(upload('recent-upload')));
            return { child_process: { pid: 4321 }, callback: Promise.resolve({ err: null }) };
        });

        await checkAndWait(sub.id);

        assert.deepStrictEqual(await queuedUrls(sub.id), ['https://www.youtube.com/watch?v=recent-upload']);
        for (const expected of [`could not refresh the channel info of ${sub.name}: lookup failed`,
            `could not list the recent uploads of ${sub.name}: listing failed`,
            `could not skip the uploads of ${sub.name} that predate its date filter: lookup failed`,
            `could not retrieve the playlists of ${sub.name}: lookup failed`]) {
            assert(logged.includes(`warn: Subscription: ${expected}`), `missing: ${expected}\n${logged.join('\n')}`);
        }
    });

    it('fetches each upload to check its date when the dated listing has nothing to read', async function() {
        const sub = subscription({ timerange: 'now-1week', channel_id });
        await subscriptions_api.subscribe(sub, null, true);
        stub(youtubedl_api, 'runYoutubeDL', async () => ({ child_process: null,
            callback: Promise.resolve({ parsed_output: null, err: new Error('HTTP Error 429: Too Many Requests') }) }));
        stub(youtubedl_api, 'runYoutubeDLLineStream', async (url, args) => {
            if (args.includes('--print')) return { child_process: null, callback: Promise.resolve({ err: Object.assign(new Error('exit 2'), { code: 2 }) }) };
            return { child_process: { pid: 4321 }, callback: Promise.resolve({ err: null }) };
        });

        await checkAndWait(sub.id);

        assert(logged.includes(`warn: Subscription: could not list the uploads of ${sub.name} by date, so each one is fetched to check its date: HTTP Error 429: Too Many Requests`),
            logged.join('\n'));
    });

    it('says when some of a channel\'s playlists could not be listed, and keeps the ones that were', async function() {
        const sub = subscription({ channel_id });
        stub(youtubedl_api, 'runYoutubeDL', async () => ({ child_process: null, callback: Promise.resolve({
            parsed_output: [{ entries: [{ id: 'PL1', title: 'Talks' }, { id: 'PL1' }, { id: 'PL2' }] }], err: null }) }));
        stub(youtubedl_api, 'runYoutubeDLLineStream', async (urls, args, handlers) => {
            handlers.onStdoutLine(JSON.stringify(upload('talk-1', { playlist_id: 'PL1' })));
            return { child_process: null, callback: Promise.resolve({ err: { stderr: 'ERROR: [youtube:tab] PL2: This playlist does not exist' } }) };
        });

        const result = await subscriptions_api.listSubscriptionChannelPlaylists(sub);

        assert.deepStrictEqual(result.playlists.map(playlist => [playlist.id, playlist.title, playlist.video_ids]),
            [['PL1', 'Talks', ['talk-1']], ['PL2', 'PL2', []]]);
        assert.deepStrictEqual(logged, [`warn: Subscription: some playlists of ${sub.name} could not be listed: ERROR: [youtube:tab] PL2: This playlist does not exist`]);
    });

    it('leaves out what the library or the archive already has, and clears archived downloads still waiting', async function() {
        config_api.setConfigItem('ytdl_multi_user_mode', true);
        const sub = subscription({ user_uid: 'alice' });
        await subscriptions_api.subscribe(sub, 'alice', true);
        const taken_path = path.join(media.subscriptions, 'taken.mp4');
        // A file saved before the source fields existed is known by its address alone.
        await db_api.insertRecordIntoTable('files', { uid: 'have', sub_id: sub.id, user_uid: 'alice', title: 'Have',
            url: 'https://www.youtube.com/watch?v=have-it', path: path.join(media.subscriptions, 'have.mp4') });
        await db_api.insertRecordIntoTable('files', { uid: 'taken', sub_id: sub.id, user_uid: 'alice', title: 'Taken',
            url: 'https://example.test/other-source', path: taken_path });
        await db_api.insertRecordIntoTable('archives', { extractor: 'youtube', id: 'archived', type: 'video', sub_id: sub.id,
            user_uid: 'alice', timestamp: Date.now() / 1000 });
        const cancelled = [];
        stub(downloader_api, 'cancelDownload', async uid => { cancelled.push(uid); throw new Error('already gone'); });
        const outputs = [upload('have-it'), upload('archived'), upload('same-path', { _filename: taken_path }), upload('new-one')];
        stub(youtubedl_api, 'runYoutubeDLLineStream', async (url, args, handlers) => {
            // Queued while the check was listing, so only the check itself can find them archived.
            for (const [uid, running] of [['waiting', false], ['running', true]]) {
                await db_api.insertRecordIntoTable('download_queue', { uid, sub_id: sub.id, user_uid: 'alice', type: 'video', url:
                    'https://www.youtube.com/watch?v=archived', running, finished: false, error: null, paused: false, step_index: 1 });
            }
            for (const output of outputs) handlers.onStdoutLine(JSON.stringify(output));
            return { child_process: { pid: 4321 }, callback: Promise.resolve({ err: null }) };
        });

        await checkAndWait(sub.id);

        assert.deepStrictEqual(cancelled, ['running']);
        assert.deepStrictEqual(await queuedUrls(sub.id), ['https://www.youtube.com/watch?v=new-one']);
        assert(logged.includes('warn: Failed to cancel archived pending subscription download \'running\' before cleanup.'));
    });

    it('queues a long listing in batches as it reads it, and stops queueing when queueing fails', async function() {
        const sub = subscription();
        await subscriptions_api.subscribe(sub, null, true);
        const queued = [];
        stub(downloader_api, 'createDownload', async url => {
            if (queued.length === 60) throw new Error('database is full');
            queued.push(url);
            return { uid: `download-${queued.length}` };
        });
        listing(Array.from({ length: 130 }, (unused, index) => upload(`upload-${index}`)));

        await checkAndWait(sub.id);

        assert.strictEqual(queued.length, 60);
        const refresh_status = (await db_api.getRecord('subscriptions', { id: sub.id })).refresh_status;
        assert.deepStrictEqual([refresh_status.phase, refresh_status.error], ['error', 'Error: database is full']);
    });

    it('drops the rest of a listing once the check is stopped', async function() {
        const sub = subscription();
        await subscriptions_api.subscribe(sub, null, true);
        let release;
        const queued = [];
        stub(downloader_api, 'createDownload', async url => { queued.push(url); return { uid: `download-${queued.length}` }; });
        stub(youtubedl_api, 'runYoutubeDLLineStream', async (url, args, handlers) => {
            for (let index = 0; index < 50; index++) handlers.onStdoutLine(JSON.stringify(upload(`upload-${index}`)));
            const finished = new Promise(resolve => { release = resolve; });
            return { child_process: { pid: 4321 }, callback: finished.then(() => {
                for (let index = 50; index < 60; index++) handlers.onStdoutLine(JSON.stringify(upload(`upload-${index}`)));
                return { err: null };
            }) };
        });

        assert.strictEqual(await subscriptions_api.getVideosForSub(sub.id), true);
        assert(await waitFor(() => !!release));
        await subscriptions_api.cancelCheckSubscription(sub.id);
        release();
        assert(await waitFor(async () => !(await subscriptions_api.getSubscription(sub.id)).downloading));

        assert(queued.length <= 50);
        assert(!queued.includes('https://www.youtube.com/watch?v=upload-55'));
    });

    it('queues a channel\'s playlists in batches too', async function() {
        const sub = subscription({ channel_id, retrieve_channel_playlists: true });
        await subscriptions_api.subscribe(sub, null, true);
        stub(youtubedl_api, 'runYoutubeDL', async () => ({ child_process: null, callback: Promise.resolve({
            parsed_output: [{ entries: [{ id: 'PL1', title: 'Talks' }] }], err: null }) }));
        stub(youtubedl_api, 'runYoutubeDLLineStream', async (urls, args, handlers) => {
            // The channel's own listing is one address; its playlists' are a list of them.
            if (Array.isArray(urls)) {
                for (let index = 0; index < 55; index++) handlers.onStdoutLine(JSON.stringify(upload(`talk-${index}`, { playlist_id: 'PL1' })));
            }
            return { child_process: null, callback: Promise.resolve({ err: null }) };
        });

        await checkAndWait(sub.id);

        assert.strictEqual((await queuedUrls(sub.id)).length, 55);
    });

    describe('moving its files into a folder of its own', function() {
        let channels;
        let sub;
        const file = async (uid, file_path, fields = {}) => {
            await db_api.insertRecordIntoTable('files', { uid, sub_id: sub.id, path: file_path, isAudio: false, title: uid, ...fields });
        };
        beforeEach(async function() {
            channels = path.join(media.subscriptions, 'channels');
            sub = subscription({ name: 'mover', use_subfolder: false });
            await db_api.insertRecordIntoTable('subscriptions', sub);
        });

        it('takes subtitles and odd sidecars along, leaves files already there, and passes over what is missing or elsewhere', async function() {
            const outside = path.join(media.video, 'Outside.mp4');
            for (const name of ['Flat.mp4', 'Flat.player-subtitles.vtt', 'Flat.player-subtitles.2.vtt', 'Clip.mkv', 'Clip.mkv.info.json',
                path.join('mover', 'Already.mp4')]) {
                await fs.outputFile(path.join(channels, name), 'data');
            }
            await fs.outputFile(outside, 'data');
            await file('flat', path.join(channels, 'Flat.mp4'));
            await file('clip', path.join(channels, 'Clip.mkv'));
            await file('already', path.join(channels, 'mover', 'Already.mp4'));
            await file('gone', path.join(channels, 'Gone.mp4'));
            await file('outside', outside);

            assert.strictEqual(await subscriptions_api.updateSubscription({ id: sub.id, use_subfolder: true }), true);

            const moved = path.join(channels, 'mover');
            for (const name of ['Flat.mp4', 'Flat.player-subtitles.vtt', 'Flat.player-subtitles.2.vtt', 'Clip.mkv', 'Clip.mkv.info.json', 'Already.mp4']) {
                assert(fs.existsSync(path.join(moved, name)), name);
            }
            assert(fs.existsSync(outside));
            const paths = Object.fromEntries((await db_api.getRecords('files', { sub_id: sub.id })).map(record => [record.uid, record.path]));
            assert.deepStrictEqual(paths, { flat: path.join(moved, 'Flat.mp4'), clip: path.join(moved, 'Clip.mkv'),
                already: path.join(moved, 'Already.mp4'), gone: path.join(channels, 'Gone.mp4'), outside });
            assert(logged.includes('warn: Skipping move for subscription file \'outside\' because its path is outside the old subscription folder.'));
        });

        it('keeps the setting as it was when a file cannot be moved', async function() {
            await fs.outputFile(path.join(channels, 'Flat.mp4'), 'data');
            await file('flat', path.join(channels, 'Flat.mp4'));
            stub(fs, 'move', async () => { throw new Error('device busy'); });

            assert.strictEqual(await subscriptions_api.updateSubscription({ id: sub.id, use_subfolder: true }), false);

            assert.strictEqual((await db_api.getRecord('subscriptions', { id: sub.id })).use_subfolder, false);
            assert.strictEqual((await db_api.getRecord('files', { uid: 'flat' })).path, path.join(channels, 'Flat.mp4'));
            assert.deepStrictEqual(logged, ['error: Failed to move files for subscription \'mover\'.', 'error: Error: device busy']);
        });
    });

    it('keeps a renaming rule in the listing only when the listing has to read dates', async function() {
        const seen = [];
        stub(youtubedl_api, 'runYoutubeDLLineStream', async (url, args) => {
            seen.push(args);
            return { child_process: { pid: 4321 }, callback: Promise.resolve({ err: null }) };
        });
        const rule = '--replace-in-metadata,,title,,draft,,final';
        const flat = subscription({ custom_args: rule });
        const dated = subscription({ custom_args: rule, timerange: '20200101' });
        for (const sub of [flat, dated]) {
            await subscriptions_api.subscribe(sub, null, true);
            await checkAndWait(sub.id);
        }

        const rule_args = args => args.includes('--replace-in-metadata') ? args.slice(args.indexOf('--replace-in-metadata'), args.indexOf('--replace-in-metadata') + 4) : null;
        assert.deepStrictEqual(seen.map(rule_args), [null, ['--replace-in-metadata', 'title', 'draft', 'final']]);
    });
});
