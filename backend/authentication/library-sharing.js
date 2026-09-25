const config_api = require('../config');
const logger = require('../logger');
const db_api = require('../db');

/*************************************************
 * Library sharing: an account letting every other
 * account on the server browse and watch its
 * library, without changing any of it.
 *
 * A read names the library it wants with the
 * `library` query parameter, and only the read
 * routes in app.js that run resolveLibraryOwner
 * look at it. Every other route -- every write --
 * goes on acting on the caller's own records, so
 * carrying the parameter somewhere it is not read
 * reaches nobody else's files.
 ************************************************/

function multiUserMode() {
    return !!config_api.getConfigItem('ytdl_multi_user_mode');
}

function refuse(req, res, status, message) {
    logger.warn(`Refusing ${req.method} ${req.path}: ${message}`);
    res.status(status).send({success: false, error: message});
}

/*************************************************
 * The libraries the caller may switch to: every
 * other account that shares its own. Only the uid
 * and name leave the process -- the rest of a user
 * record is nobody else's business.
 ************************************************/
exports.getSharedLibraries = async function(caller_uid) {
    if (!multiUserMode()) return [];

    const owners = await db_api.getRecords('users', {library_shared: true});
    return owners
        .filter(owner => owner.uid !== caller_uid)
        .map(owner => ({uid: owner.uid, name: owner.name || owner.uid}))
        .sort((a, b) => a.name.localeCompare(b.name));
}

exports.setLibrarySharing = async function(user_uid, enabled) {
    if (!await db_api.getRecord('users', {uid: user_uid})) return false;
    return await db_api.updateRecord('users', {uid: user_uid}, {library_shared: enabled});
}

/*************************************************
 * Resolves whose library a read is for.
 *
 * Asking for your own library, or asking nothing,
 * changes nothing. Asking for anybody else's needs
 * a signed-in caller and an owner who shares, and
 * is refused otherwise rather than quietly answered
 * from the caller's own library: a list of the
 * wrong person's files is a worse answer than none.
 *
 * Single-user mode has one library, so there is
 * nothing to choose between.
 ************************************************/
exports.resolveLibraryOwner = async function(req, res, next) {
    const requested = req.query ? req.query.library : undefined;
    if (requested === undefined || requested === '' || !multiUserMode()) return next();

    if (typeof requested !== 'string') return refuse(req, res, 400, 'library must be a single user id');
    if (!req.user) return refuse(req, res, 401, 'Authentication required to browse a library');
    if (requested === req.user.uid) return next();

    const owner = await db_api.getRecord('users', {uid: requested});
    if (!owner || owner.library_shared !== true) return refuse(req, res, 403, 'That library is not shared');

    req.library_owner = owner.uid;
    return next();
}

// The uid whose records a read route should answer from.
exports.libraryOwnerUid = function(req) {
    if (req.library_owner) return req.library_owner;
    return req.user ? req.user.uid : null;
}
