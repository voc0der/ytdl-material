/*************************************************
 * Short links to a file or playlist: /s/<id>, which
 * redirects to the player.
 *
 * A player link names a file by its uid and, for a
 * share in multi-user mode, the owner by theirs: two
 * UUIDs. A short link names the record by an id of
 * its own, which says nothing about either.
 *
 * It is only another name for the player link, never
 * a way past it. The page it leads to asks the server
 * for the file the same way, so whoever could not
 * open the long link cannot open the short one.
 ************************************************/
const crypto = require('node:crypto');
const config_api = require('./config');
const db_api = require('./db');
const logger = require('./logger');

// Letters and digits only. Some chat apps end a link at a trailing - or _, which an id drawn
// from base64url would end in now and then.
const SHARE_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// 65 bits: too many to guess, and too many for two records ever to draw the same id, so
// nothing checks whether one has.
const SHARE_ID_LENGTH = 11;
const SHARE_ID_PATTERN = new RegExp(`^[A-Za-z0-9]{${SHARE_ID_LENGTH}}$`);
// The table, and the field that names a record in it.
const SHARE_TABLES = [['files', 'uid'], ['playlists', 'id']];

exports.generateShareId = () => {
    let share_id = '';
    for (let i = 0; i < SHARE_ID_LENGTH; i++) share_id += SHARE_ID_ALPHABET[crypto.randomInt(SHARE_ID_ALPHABET.length)];
    return share_id;
}

exports.isShareId = (value) => typeof value === 'string' && SHARE_ID_PATTERN.test(value);

/*************************************************
 * Gives an id to every file and playlist without
 * one: everything from before short links, and
 * whatever a backup or an import has put back since.
 * New records get theirs as they are made.
 ************************************************/
exports.assignMissingShareIds = async () => {
    let assigned = 0;
    for (const [table, key] of SHARE_TABLES) {
        const records = await db_api.getRecords(table, {share_id: null}, false, null, null, [key]);
        const update_obj = {};
        for (const record of records) {
            if (record[key]) update_obj[record[key]] = {share_id: exports.generateShareId()};
        }
        if (Object.keys(update_obj).length === 0) continue;
        await db_api.bulkUpdateRecordsByKey(table, key, update_obj);
        assigned += Object.keys(update_obj).length;
    }
    if (assigned > 0) logger.info(`Gave ${assigned} files and playlists a short share link.`);
    return assigned;
}

// ?t=90, in seconds. Anything else is left off rather than refused: the link still opens.
exports.parseStartTime = (value) => {
    if (typeof value !== 'string' || !/^\d{1,7}(\.\d{1,3})?$/.test(value)) return null;
    const seconds = Number(value);
    return seconds > 0 ? seconds : null;
}

/*************************************************
 * The player route a short link stands for, or null.
 *
 * The owner goes in, as a share link has always
 * carried them, only while a record is shared in
 * multi-user mode. A player link with an owner in it
 * asks for the share and nothing else, which would
 * stop the owner opening their own unshared file.
 * Single-user mode needs no owner to find a file.
 ************************************************/
exports.resolveShareLink = async (share_id, start_time = null) => {
    if (!exports.isShareId(share_id)) return null;
    const file = await db_api.getRecord('files', {share_id: share_id});
    const record = file || await db_api.getRecord('playlists', {share_id: share_id});
    if (!record) return null;

    let route = file
        ? `/player;uid=${encodeURIComponent(file.uid)}`
        : `/player;playlist_id=${encodeURIComponent(record.id)}`;
    if (config_api.getConfigItem('ytdl_multi_user_mode') && record.sharingEnabled && record.user_uid) {
        route += `;uuid=${encodeURIComponent(record.user_uid)}`;
    }
    if (start_time) route += `;timestamp=${start_time}`;
    return route;
}

/*************************************************
 * GET /s/<id>[?t=<seconds>].
 *
 * The redirect is relative, as the app's own pages
 * are, so it lands on whatever address the link was
 * opened at. /s/<id> and /s/<id>/ both resolve it to
 * /#/player;... there.
 ************************************************/
exports.redirect = async (req, res) => {
    const route = await exports.resolveShareLink(req.params.share_id, exports.parseStartTime(req.query.t));
    if (!route) {
        res.sendStatus(404);
        return;
    }
    const up = req.path.endsWith('/') ? '../../' : '../';
    res.redirect(`${up}#${route}`);
}
