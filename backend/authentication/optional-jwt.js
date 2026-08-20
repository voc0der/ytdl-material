const config_api = require('../config');

const auth_api = require('./auth');
const files_api = require('../files');

/*************************************************
 * Establishes *who* is calling, for every API
 * route. It says nothing about what they may do --
 * that is what the guards in permissions.js are for
 * -- and the two have to be read together, because
 * a guard can only be as good as the identity it
 * was handed.
 *
 * Lives in its own module so it can be mounted on a
 * bare express app and exercised directly. It used
 * to be a closure inside app.js, which meant the
 * only way to test it was to boot the entire
 * application -- so nothing tested it, and a bug in
 * how it composed with the register route went
 * unnoticed through a round of review.
 ************************************************/

/*************************************************
 * The routes a share link may reach, matched
 * exactly. These used to be substring tests, so
 * '/api/getFile' also matched '/api/getFileFormats'
 * and '/api/getPlaylist' matched '/api/getPlaylists'
 * -- anybody holding one shared item could reach
 * handlers the share was never issued for.
 ************************************************/
const SHARED_LINK_PATHS = new Set([
    '/api/getFile',
    '/api/stream',
    '/api/streamSubtitle',
    '/api/getPlaylist',
    '/api/downloadFileFromServer'
]);

exports.SHARED_LINK_PATHS = SHARED_LINK_PATHS;

/*************************************************
 * Paths that must answer a caller who has no token
 * at all: you cannot require a session from someone
 * who is trying to establish one.
 ************************************************/
function isPublicAuthPath(req_path) {
    return req_path.includes('/api/auth/register')
        || req_path.includes('/api/auth/oidc/login')
        || req_path.includes('/api/auth/oidc/callback')
        || req_path.includes('/api/auth/oidc/status');
}

exports.isPublicAuthPath = isPublicAuthPath;

/*************************************************
 * Resolves a token when one is offered, and never
 * refuses a caller who has none.
 *
 * For the routes that have to answer an anonymous
 * caller -- playback state for a share link -- while
 * still knowing who a logged-in one is. optionalJwt
 * cannot do this: it 401s a request with no token,
 * and a route with no jwt middleware at all sees
 * req.isAuthenticated() as false for everybody,
 * including users who are plainly logged in.
 ************************************************/
exports.resolveJwtIfPresent = function (req, res, next) {
    if (!config_api.getConfigItem('ytdl_multi_user_mode')) return next();
    if (!req.query || !req.query.jwt) return next();

    return auth_api.passport.authenticate('jwt', {session: false}, (err, user) => {
        if (err || !user) return next();
        return req.logIn(user, {session: false}, () => next());
    })(req, res, next);
}

exports.optionalJwt = async function (req, res, next) {
    const multiUserMode = config_api.getConfigItem('ytdl_multi_user_mode');
    if (multiUserMode && ((req.body && req.body.uuid) || (req.query && req.query.uuid)) && SHARED_LINK_PATHS.has(req.path)) {
        // check if shared video
        const using_body = req.body && req.body.uuid;
        const uuid = using_body ? req.body.uuid : req.query.uuid;
        const uid = using_body ? req.body.uid : req.query.uid;
        const playlist_id = using_body ? req.body.playlist_id : req.query.playlist_id;
        let authorized = false;
        if (!playlist_id) {
            authorized = !!await auth_api.getUserVideo(uuid, uid, true);
        } else {
            const playlist = await files_api.getPlaylist(playlist_id, uuid, true);
            /*************************************************
             * A shared playlist authorizes the files that are
             * in it, not everything its owner happens to own.
             *
             * Only the playlist was being checked, so a share
             * link plus any file uid belonging to the same
             * user streamed that user's private media.
             *
             * A request with no uid is asking for the playlist
             * itself, which is what the share is for.
             ************************************************/
            const playlist_uids = playlist && Array.isArray(playlist['uids']) ? playlist['uids'] : [];
            authorized = !!playlist && (!uid || playlist_uids.includes(uid));
        }

        if (authorized) {
            req.can_watch = true;
            return next();
        } else {
            res.sendStatus(401);
            return;
        }
    } else if (multiUserMode && !isPublicAuthPath(req.path)) {
        if (!req.query.jwt) {
            res.sendStatus(401);
            return;
        }
        return auth_api.passport.authenticate('jwt', { session: false })(req, res, next);
    } else if (multiUserMode && req.query.jwt) {
        // A public auth path still has to be able to tell who is calling when a token is
        // offered. Registration is the case that matters: it is open to strangers, but it
        // is also how an administrator adds an account from the settings page, and that is
        // the same endpoint with a JWT attached. A bad or expired token is not fatal here
        // -- the caller simply stays anonymous and gets the stranger's treatment.
        return auth_api.passport.authenticate('jwt', {session: false}, (err, user) => {
            if (err || !user) return next();
            return req.logIn(user, {session: false}, () => next());
        })(req, res, next);
    }
    return next();
};
