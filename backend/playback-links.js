// Credentials for a single media file, never an account session. Kept in memory so
// a restart revokes them. Range/HEAD requests reuse the link until its expiry.
const crypto = require('node:crypto');
const db = require('./db');
const files = require('./files');
const config = require('./config');
const utils = require('./utils');
const playback_transcode = require('./playback-transcode');

const links = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_LINKS = 1000;

async function findFile(body, owner) {
    if (typeof body.uid === 'string' && body.uid && !body.youtube_id) {
        return files.getVideo(body.uid, owner);
    }

    const id = body.youtube_id;
    if (body.uid || typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) return null;

    const multiUser = !!config.getConfigItem('ytdl_multi_user_mode');

    const matches = file => {
        if (file.isAudio !== false
            || !utils.isServableMediaFile(file.path, file.user_uid)) {
            return false;
        }

        const source = files.extractSourceMetadataFromUrl(file.url);

        if (source) {
            return source.source_extractor === 'youtube'
                && source.source_id === id;
        }

        return String(file.source_extractor || '').toLowerCase() === 'youtube'
            && file.source_id === id;
    };

    // Use portable equality filters. db.getRecords() also supports PostgreSQL,
    // where Mongo operators such as $or/$regex are invalid.
    const filter = {isAudio: false, source_id: id};
    if (multiUser) filter.user_uid = owner;

    const candidates = await db.getRecords('files', filter);
    const match = candidates.find(matches);
    if (match) return match;

    // Legacy records may only carry the upstream ID in source URL metadata.
    const legacyFilter = {isAudio: false};
    if (multiUser) legacyFilter.user_uid = owner;

    const legacyCandidates = await db.getRecords('files', legacyFilter);
    return legacyCandidates.find(matches) || null;
}

exports.create = async (req, res) => {
    res.set('Cache-Control', 'no-store');

    try {
        const multiUser = !!config.getConfigItem('ytdl_multi_user_mode');
        const owner = req.isAuthenticated() && req.user ? req.user.uid : null;

        if (multiUser && !owner) return res.sendStatus(401);

        const body = req.body || {};
        const hasUID = Object.prototype.hasOwnProperty.call(body, 'uid');
        const hasYouTube = Object.prototype.hasOwnProperty.call(body, 'youtube_id');

        const byUID = hasUID && !hasYouTube
            && typeof body.uid === 'string' && body.uid.length > 0;

        const byYouTube = !hasUID && hasYouTube
            && typeof body.youtube_id === 'string'
            && /^[\w-]{11}$/.test(body.youtube_id);

        if (!byUID && !byYouTube) return res.sendStatus(400);

        // Opt-in only: the stream never inspects codecs to decide for itself.
        const hasTranscode = Object.prototype.hasOwnProperty.call(body, 'transcode');
        if (hasTranscode && typeof body.transcode !== 'boolean') return res.sendStatus(400);
        const transcode = body.transcode === true;

        const file = await findFile(body, owner);

        if (!file || (multiUser && file.user_uid !== owner)
            || file.isAudio !== false
            || !utils.isServableMediaFile(file.path, file.user_uid)) {
            return res.sendStatus(404);
        }

        const now = Date.now();

        for (const [key, value] of links) {
            if (value.expires <= now) links.delete(key);
        }

        if (links.size >= MAX_LINKS) return res.sendStatus(503);

        const token = crypto.randomBytes(32).toString('base64url');
        const expires = now + TTL_MS;

        links.set(token, {
            uid: file.uid,
            owner: file.user_uid ?? null,
            multiUser,
            expires,
            transcode
        });

        // Requested after the link is stored, so the reaper already counts the copy as in use.
        const ready = transcode ? playback_transcode.request(file) : null;

        return res.json({
            uid: file.uid,
            expires_at: expires,
            stream_path: '/api/stream?' + new URLSearchParams({
                uid: file.uid,
                playback_token: token
            }),
            ...(transcode && {transcode, ready})
        });
    } catch (err) {
        console.error('createPlaybackLink failed:', err);
        return res.sendStatus(500);
    }
};

// Installed ONLY on /api/stream. A playback link cannot log in, list the library,
// mint another link, or authorize any other route. Existing JWT/share auth is
// unchanged for requests without a playback_token.
exports.authorizeStream = (optionalJwt, requireAuthenticatedOrShared) =>
    async (req, res, next) => {
        if (!Object.prototype.hasOwnProperty.call(req.query, 'playback_token')) {
            return optionalJwt(req, res,
                () => requireAuthenticatedOrShared(req, res, next));
        }

        res.set('Cache-Control', 'private, no-store');
        res.set('Referrer-Policy', 'no-referrer');

        const token = req.query.playback_token;
        const grant = typeof token === 'string' ? links.get(token) : null;

        if (!grant || grant.expires <= Date.now()) {
            if (grant) links.delete(token);
            return res.sendStatus(401);
        }

        if (!['GET', 'HEAD'].includes(req.method)
            || req.path !== '/api/stream'
            || req.query.uid !== grant.uid
            || ['uuid', 'sub_id', 'jwt', 'playlist_id'].some(key => key in req.query)
            || grant.multiUser !== !!config.getConfigItem('ytdl_multi_user_mode')) {
            return res.sendStatus(403);
        }

        try {
            // Recheck ownership on every request; deleting/moving the file revokes it.
            const file = await files.getVideo(grant.uid, grant.owner);

            if (!file || (file.user_uid ?? null) !== grant.owner
                || file.isAudio !== false) {
                return res.sendStatus(404);
            }

            req.playback = grant;
            return next();
        } catch (err) {
            console.error('playback authorization failed:', err);
            return res.sendStatus(500);
        }
    };

// A copy stays while an unexpired link can still stream it, and is only reaped once it is
// older than a link lives.
exports.reapTranscodes = () => playback_transcode.reap(TTL_MS, () => {
    const now = Date.now();
    return [...links.values()]
        .filter(grant => grant.transcode && grant.expires > now)
        .map(grant => grant.uid);
});
