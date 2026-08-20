/* eslint-disable no-undef */
const assert = require('assert');
const low = require('../lowdb-compat');
const winston = require('winston');
const path = require('path');
const os = require('os');
const util = require('util');
const fs = require('fs-extra');
const { v4: uuid } = require('uuid');
const NodeID3 = require('node-id3');
const exec = util.promisify(require('child_process').exec);

const FileSync = require('../lowdb-compat/adapters/FileSync');

const adapter = new FileSync('./appdata/db.json');
const db = low(adapter);

const users_adapter = new FileSync('./appdata/users.json');
const users_db = low(users_adapter);

const defaultFormat = winston.format.printf(({ level, message, timestamp }) => {
    return `${timestamp} ${level.toUpperCase()}: ${message}`;
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), defaultFormat),
    defaultMeta: {},
    transports: [
        new winston.transports.File({ filename: 'appdata/logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'appdata/logs/combined.log' }),
        new winston.transports.Console({ level: 'debug', name: 'console' })
    ]
});

const auth_api = require('../authentication/auth');
const db_api = require('../db');
const utils = require('../utils');
const subscriptions_api = require('../subscriptions');
const archive_api = require('../archive');
const categories_api = require('../categories');
const files_api = require('../files');
const youtubedl_api = require('../youtube-dl');
const config_api = require('../config');
const downloader_api = require('../downloader');
const CONSTS = require('../consts');

db_api.initialize(db, users_db, 'local_db_test.json');

const sample_video_json = {
    id: 'Sample Video',
    title: 'Sample Video',
    thumbnailURL: 'https://sampleurl.jpg',
    isAudio: false,
    duration: 177.413,
    url: 'sampleurl.com',
    uploader: 'Sample Uploader',
    size: 2838445,
    path: 'users\\admin\\video\\Sample Video.mp4',
    upload_date: '2017-07-28',
    description: null,
    view_count: 230,
    abr: 128,
    thumbnailPath: null,
    user_uid: 'admin',
    uid: '1ada04ab-2773-4dd4-bbdd-3e2d40761c50',
    registered: 1628469039377
};

const generateEmptyVideoFile = async (file_path) => {
    if (fs.existsSync(file_path)) fs.unlinkSync(file_path);
    return await exec(`ffmpeg -t 1 -f lavfi -i color=c=black:s=640x480 -c:v libx264 -tune stillimage -pix_fmt yuv420p "${file_path}"`);
};

const generateEmptyAudioFile = async (file_path) => {
    if (fs.existsSync(file_path)) fs.unlinkSync(file_path);
    return await exec(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 1 -q:a 9 -acodec libmp3lame ${file_path}`);
};


/*************************************************
 * A throwaway set of media roots.
 *
 * Tests that exercise path containment have to
 * create files inside whatever the media roots are
 * configured to be, and then delete them. Pointed
 * at the real configuration, that means a test run
 * writes into -- and recursively removes from --
 * the machine's actual media folders. On a
 * developer's own install, a fixture named
 * users/alice is not obviously distinguishable
 * from a real account.
 *
 * So the roots are redirected somewhere disposable
 * for the duration, by intercepting reads rather
 * than writing the config file.
 ************************************************/
function useTemporaryMediaRoots(extra_overrides = {}) {
    const original_getConfigItem = config_api.getConfigItem;
    const original_setConfigItem = config_api.setConfigItem;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-media-test-'));

    const roots = {
        'ytdl_video_folder_path': path.join(base, 'video'),
        'ytdl_audio_folder_path': path.join(base, 'audio'),
        'ytdl_users_base_path': path.join(base, 'users'),
        'ytdl_subscriptions_base_path': path.join(base, 'subscriptions')
    };
    for (const root of Object.values(roots)) fs.ensureDirSync(root);

    const overrides = Object.assign({}, roots, extra_overrides);

    config_api.getConfigItem = (key) =>
        Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : original_getConfigItem(key);

    // Writes are intercepted as well as reads. A test that repoints a root mid-run is
    // doing so to exercise something, not to edit the developer's config file -- and if
    // the write escaped, the read interception above would hide it anyway.
    config_api.setConfigItem = (key, value) => {
        overrides[key] = value;
        return true;
    };

    return {
        base,
        video: roots['ytdl_video_folder_path'],
        audio: roots['ytdl_audio_folder_path'],
        users: roots['ytdl_users_base_path'],
        subscriptions: roots['ytdl_subscriptions_base_path'],
        restore() {
            config_api.getConfigItem = original_getConfigItem;
            config_api.setConfigItem = original_setConfigItem;
            fs.removeSync(base);
        }
    };
}

module.exports = {
    useTemporaryMediaRoots,
    os,
    assert,
    low,
    path,
    util,
    fs,
    uuid,
    NodeID3,
    exec,
    db,
    users_db,
    logger,
    auth_api,
    db_api,
    utils,
    subscriptions_api,
    archive_api,
    categories_api,
    files_api,
    youtubedl_api,
    config_api,
    downloader_api,
    CONSTS,
    sample_video_json,
    generateEmptyVideoFile,
    generateEmptyAudioFile
};
