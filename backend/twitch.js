const config_api = require('./config');
const logger = require('./logger');

const fs = require('fs-extra')
const path = require('path');
const { promisify } = require('util');
const child_process = require('child_process');

async function getCommentsForVOD(vodId) {
    const execFile = promisify(child_process.execFile);

    // Reject invalid params to prevent command injection attack
    if (!vodId.match(/^[0-9a-z]+$/)) {
        logger.error('VOD ID must be purely alphanumeric. Twitch chat download failed!');
        return null;
    }
    const safeVodId = path.basename(vodId);

    const is_windows = process.platform === 'win32';
    const cliExt = is_windows ? '.exe' : ''
    const cliPath = `TwitchDownloaderCLI${cliExt}`

    let result;
    try {
        result = await execFile(cliPath, ['chatdownload', '-u', safeVodId, '-o', path.join('appdata', `${safeVodId}.json`)]);
    } catch (err) {
        if (err.code === 'ENOENT') {
            logger.error(`${cliPath} does not exist. Twitch chat download failed! Get it here: https://github.com/lay295/TwitchDownloader`);
        } else {
            logger.error(`Failed to download twitch comments for ${safeVodId}`);
            logger.error(err.stderr || err.message);
        }
        return null;
    }

    if (result['stderr']) {
        logger.error(`Failed to download twitch comments for ${safeVodId}`);
        logger.error(result['stderr']);
        return null;
    }

    const temp_chat_path = path.join('appdata', `${safeVodId}.json`);
    const appdataBasePath = path.resolve('appdata');
    const resolvedTempChatPath = path.resolve(temp_chat_path);
    const relativeTempChatPath = path.relative(appdataBasePath, resolvedTempChatPath);
    if (relativeTempChatPath.startsWith('..') || path.isAbsolute(relativeTempChatPath)) {
        logger.error(`Refusing to access temporary twitch chat file outside appdata for ${safeVodId}`);
        return null;
    }

    const raw_json = fs.readJSONSync(resolvedTempChatPath);
    const new_json = raw_json.comments.map(comment_obj => {
        return {
            timestamp: comment_obj.content_offset_seconds,
            timestamp_str: convertTimestamp(comment_obj.content_offset_seconds),
            name: comment_obj.commenter.name,
            message: comment_obj.message.body,
            user_color: comment_obj.message.user_color
        }
    });

    fs.unlinkSync(resolvedTempChatPath);

    return new_json;
}

async function getTwitchChatByFileID(id, type, user_uid, uuid, sub) {
    const usersFileFolder = config_api.getConfigItem('ytdl_users_base_path');
    const subscriptionsFileFolder = config_api.getConfigItem('ytdl_subscriptions_base_path');
    let file_path;
    let base_path;
    const safeType = type === 'audio' || type === 'video' ? type : null;

    if (user_uid) {
        if (sub) {
            base_path = path.join(usersFileFolder, user_uid, 'subscriptions', sub.isPlaylist ? 'playlists' : 'channels');
            file_path = path.join(usersFileFolder, user_uid, 'subscriptions', sub.isPlaylist ? 'playlists' : 'channels', sub.name, `${id}.twitch_chat.json`);
        } else {
            if (!safeType) return null;
            base_path = path.join(usersFileFolder, user_uid, safeType);
            file_path = path.join(usersFileFolder, user_uid, safeType, `${id}.twitch_chat.json`);
        }
    } else {
        if (sub) {
            base_path = path.join(subscriptionsFileFolder, sub.isPlaylist ? 'playlists' : 'channels');
            file_path = path.join(subscriptionsFileFolder, sub.isPlaylist ? 'playlists' : 'channels', sub.name, `${id}.twitch_chat.json`);
        } else {
            if (!safeType) return null;
            const typeFolder = config_api.getConfigItem(`ytdl_${safeType}_folder_path`);
            base_path = typeFolder;
            file_path = path.join(typeFolder, `${id}.twitch_chat.json`);
        }
    }

    let chat_file = null;
    if (file_path && base_path) {
        const resolvedBasePath = path.resolve(base_path);
        const resolvedFilePath = path.resolve(file_path);
        const relativeFilePath = path.relative(resolvedBasePath, resolvedFilePath);
        if (relativeFilePath.startsWith('..') || path.isAbsolute(relativeFilePath)) {
            logger.error(`Refusing to read twitch chat outside expected directory for file id '${id}'.`);
            return null;
        }

        if (fs.existsSync(resolvedFilePath)) {
            chat_file = fs.readJSONSync(resolvedFilePath);
        }
    }

    return chat_file;
}

async function downloadTwitchChatByVODID(vodId, id, type, user_uid, sub, customFileFolderPath = null) {
    const usersFileFolder           = config_api.getConfigItem('ytdl_users_base_path');
    const subscriptionsFileFolder   = config_api.getConfigItem('ytdl_subscriptions_base_path');
    const chat = await getCommentsForVOD(vodId);

    // save file if needed params are included
    let file_path;
    let base_path;
    const safeType = type === 'audio' || type === 'video' ? type : null;
    if (customFileFolderPath) {
        base_path = customFileFolderPath;
        file_path = path.join(customFileFolderPath, `${id}.twitch_chat.json`)
    } else if (user_uid) {
        if (sub) {
            base_path = path.join(usersFileFolder, user_uid, 'subscriptions', sub.isPlaylist ? 'playlists' : 'channels');
            file_path = path.join(usersFileFolder, user_uid, 'subscriptions', sub.isPlaylist ? 'playlists' : 'channels', sub.name, `${id}.twitch_chat.json`);
        } else {
            if (!safeType) return null;
            base_path = path.join(usersFileFolder, user_uid, safeType);
            file_path = path.join(usersFileFolder, user_uid, safeType, `${id}.twitch_chat.json`);
        }
    } else {
        if (sub) {
            base_path = path.join(subscriptionsFileFolder, sub.isPlaylist ? 'playlists' : 'channels');
            file_path = path.join(subscriptionsFileFolder, sub.isPlaylist ? 'playlists' : 'channels', sub.name, `${id}.twitch_chat.json`);
        } else {
            if (!safeType) return null;
            const typeFolder = config_api.getConfigItem(`ytdl_${safeType}_folder_path`);
            base_path = typeFolder;
            file_path = path.join(typeFolder, `${id}.twitch_chat.json`);
        }
    }

    if (chat && file_path && base_path) {
        const resolvedBasePath = path.resolve(base_path);
        const resolvedFilePath = path.resolve(file_path);
        const relativeFilePath = path.relative(resolvedBasePath, resolvedFilePath);
        if (relativeFilePath.startsWith('..') || path.isAbsolute(relativeFilePath)) {
            logger.error(`Refusing to write twitch chat outside expected directory for file id '${id}'.`);
            return null;
        }
        fs.writeJSONSync(resolvedFilePath, chat);
    }

    return chat;
}

// Formats an offset in seconds as HH:MM:SS. Hours do not roll over into days.
const convertTimestamp = (timestamp) => {
    const total_seconds = Math.max(0, Math.floor(Number(timestamp) || 0));
    const hours = Math.floor(total_seconds / 3600);
    const minutes = Math.floor(total_seconds % 3600 / 60);
    const seconds = total_seconds % 60;
    return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
};

module.exports = {
    getCommentsForVOD: getCommentsForVOD,
    getTwitchChatByFileID: getTwitchChatByFileID,
    downloadTwitchChatByVODID: downloadTwitchChatByVODID,
    convertTimestamp: convertTimestamp
}
