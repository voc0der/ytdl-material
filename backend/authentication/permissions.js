const config_api = require('../config');
const logger = require('../logger');

const auth_api = require('./auth');

/*************************************************
 * Route guards.
 *
 * Until these existed, every API route used
 * optionalJwt, which establishes *who* the caller
 * is and never asks what they are allowed to do.
 * Permissions were computed, handed to the frontend
 * and enforced by hiding buttons.
 *
 * Single-user mode has no accounts, so there is
 * nobody to check and nothing to check against.
 * The frontend's own hasPermission() already
 * returns true unconditionally there; these mirror
 * that rather than invent a second policy.
 ************************************************/
function enforcementApplies() {
    return !!config_api.getConfigItem('ytdl_multi_user_mode');
}

function refuse(req, res, status, message) {
    logger.error(`Refusing ${req.method} ${req.path}: ${message}`);
    res.status(status).send({success: false, error: message});
}

/*************************************************
 * For the things that are not delegable: user
 * management, server control, and anything that
 * moves the database around. These have no matching
 * entry in AVAILABLE_PERMISSIONS because they were
 * never meant to be handed out per-user.
 ************************************************/
exports.requireAdmin = function(req, res, next) {
    if (!enforcementApplies()) return next();

    if (!req.user) return refuse(req, res, 401, 'Authentication required');
    if (req.user.role !== 'admin') return refuse(req, res, 403, 'Administrator access required');

    return next();
}

/*************************************************
 * For everything covered by AVAILABLE_PERMISSIONS.
 *
 * Admins are not special-cased: the admin role is
 * seeded with every permission, so the ordinary
 * lookup already says yes -- and an explicit
 * negative override on an admin should mean what it
 * says rather than be quietly ignored.
 ************************************************/
exports.requirePermission = function(permission) {
    return async function(req, res, next) {
        if (!enforcementApplies()) return next();

        if (!req.user) return refuse(req, res, 401, 'Authentication required');

        if (!await auth_api.userHasPermission(req.user.uid, permission)) {
            return refuse(req, res, 403, `Missing the '${permission}' permission`);
        }

        return next();
    }
}

/*************************************************
 * Requires a real authenticated caller.
 *
 * This replaced a marker that returned next() and
 * nothing else, on the reasoning that optionalJwt
 * had already established identity. That is true
 * for most routes but not all of them: a caller
 * holding a share link is let through with
 * req.can_watch set and no req.user at all, and a
 * guard that checks nothing let that caller reach
 * every route wearing it.
 ************************************************/
exports.requireAuthenticated = function(req, res, next) {
    if (!enforcementApplies()) return next();

    if (!req.user) return refuse(req, res, 401, 'Authentication required');

    return next();
}

/*************************************************
 * For the few routes a share link is meant to
 * reach. optionalJwt has already checked the share
 * itself and set can_watch; this only says that
 * doing so is allowed here.
 ************************************************/
exports.requireAuthenticatedOrShared = function(req, res, next) {
    if (!enforcementApplies()) return next();

    if (!req.user && !req.can_watch) return refuse(req, res, 401, 'Authentication required');

    return next();
}
