/* eslint-disable no-undef */
const assert = require('assert');
const low = require('../lowdb-compat');
const winston = require('winston');
const path = require('path');
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

module.exports = {
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
    CONSTS,
    sample_video_json,
    generateEmptyVideoFile,
    generateEmptyAudioFile
};
