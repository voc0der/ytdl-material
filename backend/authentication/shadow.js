const { Mutex } = require('async-mutex');
const db = require('../db');
const config = require('../config');

// An assignment is separate from the account's role and permission overrides. Ending it
// restores those settings, including roles refreshed by an external sign-in provider.
const POLICIES = Object.freeze({
    read_only: {permissions: ['subscriptions']},
    full: {permissions: ['filemanager', 'subscriptions', 'sharing', 'advanced_download', 'downloads_manager']}
});

// Many reads use POST. Explicit capabilities keep a new endpoint from accidentally
// granting writes or account administration to a shadow session.
const READ_ROUTES = new Set([
    'GET /api/getmp3s', 'GET /api/getmp4s', 'GET /api/stream', 'GET /api/streamsubtitle', 'GET /api/rss',
    ...['getFile', 'getAllFiles', 'getDuplicateSummary', 'getDuplicates', 'getFullTwitchChat',
        'getAllCategories', 'getSubscription', 'getSubscriptions', 'getPlaylist', 'getPlaylists',
        'getSnipStatus', 'getArchives', 'downloadArchive', 'downloadFileFromServer', 'downloads',
        'download', 'getFileFormats', 'searchVideos', 'getSharedLibraries', 'getNotifications']
        .map(route => `POST /api/${route.toLowerCase()}`)
]);
const WRITE_ROUTES = new Set([
    'downloadFile', 'downloadFiles', 'generateArgs', 'removeNewestDuplicates', 'removeDuplicates',
    'updateFile', 'generateThumbnail', 'updateConcurrentStream', 'downloadTwitchChatByVODID',
    'enableSharing', 'disableSharing', 'incrementViewCount', 'subscribe', 'unsubscribe',
    'deleteSubscriptionFile', 'downloadVideosForSubscription', 'updateSubscription',
    'checkSubscription', 'redownloadSubscription', 'cancelCheckSubscription', 'createPlaylist',
    'addFileToPlaylist', 'updatePlaylist', 'deletePlaylist', 'deleteFile', 'snipFile', 'deleteAllFiles',
    'importArchive', 'deleteArchiveItems', 'createPlaybackLink', 'clearDownloads', 'clearDownload',
    'pauseDownload', 'pauseAllDownloads', 'resumeDownload', 'resumeAllDownloads',
    'retryDuplicateDownload', 'restartDownload', 'cancelDownload', 'setNotificationsToRead',
    'deleteNotification', 'deleteAllNotifications'
].map(route => `POST /api/${route.toLowerCase()}`));
const ACCOUNT_ROUTES = new Set(['stopShadow', 'listAPITokens', 'generateAPIToken', 'revokeAPIToken']
    .map(route => `POST /api/${route.toLowerCase()}`));

function policyFor(assignment) {
    return assignment && Object.hasOwn(POLICIES, assignment.access) ? POLICIES[assignment.access] : null;
}

async function resolve(actor) {
    if (!actor?.shadow) return {user: actor};
    const assignment = actor.shadow;
    const policy = policyFor(assignment);
    const target = typeof assignment.target_uid === 'string'
        ? await db.getRecord('users', {uid: assignment.target_uid}) : null;
    const unavailable = !policy || !target || target.uid === actor.uid || !!target.shadow;
    const permissions = unavailable ? [] : policy.permissions.filter(permission =>
        !(actor.permission_overrides || []).includes(permission) || (actor.permissions || []).includes(permission));
    // Never copy credentials, provider claims, role, or permission overrides from the target.
    const user = {
        uid: target?.uid || assignment.target_uid,
        name: target?.name || assignment.target_uid,
        created: target?.created,
        role: 'shadow',
        permissions,
        permission_overrides: [],
        // Only an administrator may end their own assignment. Anyone else stays on it until an
        // administrator changes it in Settings.
        shadow_session: {actor_uid: actor.uid, actor_name: actor.name, access: assignment.access, unavailable,
            can_stop: actor.role === 'admin'}
    };
    return {user, permissions};
}

async function apply(req, res, next) {
    if (!config.getConfigItem('ytdl_multi_user_mode') || !req.user?.shadow) return next();
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const route = `${method} ${req.path.replace(/\/$/, '').toLowerCase()}`;
    // These always operate on the caller, even if their target has been deleted.
    if (ACCOUNT_ROUTES.has(route)) return next();

    const actor = req.user;
    const {user, permissions} = await resolve(actor);
    req.authenticated_user = actor;
    req.user = user;
    req.shadow_permissions = permissions;
    if (user.shadow_session.unavailable) {
        return res.status(403).send({success: false, error: 'The shadow target is unavailable until an administrator ends this assignment.'});
    }
    const read = READ_ROUTES.has(route) || (method === 'GET'
        && /^\/api\/(thumbnail|subscriptionartwork|resolveplayerlink)\/[^/]+\/?$/i.test(req.path));
    if (read || (actor.shadow.access === 'full' && WRITE_ROUTES.has(route))) return next();
    return res.status(403).send({success: false, error: 'This action is not allowed while shadowing.'});
}

const assignmentMutex = new Mutex();
async function updateUser(change) {
    return assignmentMutex.runExclusive(async () => {
        const bad = error => ({success: false, status: 400, error});
        if (!change || typeof change.uid !== 'string') return bad('A user id is required.');
        const user = await db.getRecord('users', {uid: change.uid});
        if (!user) return bad('The account does not exist.');
        const updates = {};
        if (Object.hasOwn(change, 'name')) {
            if (typeof change.name !== 'string' || !change.name.trim()) return bad('A name is required.');
            updates.name = change.name.trim();
        }
        if (Object.hasOwn(change, 'role')) {
            if (typeof change.role !== 'string' || !await db.getRecord('roles', {key: change.role})) return bad('Unknown role.');
            updates.role = change.role;
        }
        if (Object.hasOwn(change, 'shadow')) {
            if (change.shadow === null) {
                updates.shadow = null;
            } else {
                const assignment = change.shadow;
                if (!policyFor(assignment) || typeof assignment.target_uid !== 'string') return bad('Select a target and shadow access level.');
                if (assignment.target_uid === user.uid) return bad('An account cannot shadow itself.');
                const target = await db.getRecord('users', {uid: assignment.target_uid});
                if (!target) return bad('The shadow target does not exist.');
                if (target.shadow) return bad('Choose an account that is not shadowing another account.');
                const incoming = await db.getRecord('users', {'shadow.target_uid': user.uid});
                if (incoming) return bad('Remove assignments targeting this account before it can shadow another account.');
                updates.shadow = {target_uid: target.uid, access: assignment.access};
            }
        }
        const success = await db.updateRecord('users', {uid: user.uid}, updates);
        return {success: !!success};
    });
}

// Called once an account is deleted. An assignment left pointing at its uid would pass to
// any later account given the same uid. Under the mutex, so an assignment validated against
// the account just before it was removed cannot be written after this sweep.
async function endAssignmentsTo(uid) {
    return assignmentMutex.runExclusive(() => db.updateRecords('users', {'shadow.target_uid': uid}, {shadow: null}));
}

module.exports = {resolve, apply, updateUser, endAssignmentsTo};
