const { v4: uuid } = require('uuid');
const fs = require('fs-extra');
const { promisify } = require('util');
const http = require('http');
const https = require('https');
const auth_api = require('./authentication/auth');
const { requireAdmin, requirePermission, requireAuthenticated, requireAuthenticatedOrShared } = require('./authentication/permissions');
const { optionalJwt, resolveJwtIfPresent, requireJwtForTokenManagement } = require('./authentication/optional-jwt');
const api_tokens_api = require('./authentication/api-tokens');
const oidc_api = require('./authentication/oidc');
const path = require('path');
const compression = require('compression');
const multer  = require('multer');
const express = require("express");
const rateLimit = require('express-rate-limit');
const bodyParser = require("body-parser");
const { ZipArchive } = require('archiver');
const unzipper = require('unzipper');
const db_api = require('./db');
const { DelegatingRateLimitStore } = require('./rate-limit-store');
const { skipApiRateLimit, skipAuthRateLimit } = require('./rate-limit-paths');
const redis_store = require('./redis-store');
const utils = require('./utils')
const low = require('./lowdb-compat')
const fetch = globalThis.fetch;
const URL = require('url').URL;
const CONSTS = require('./consts')
const read_last_lines = require('read-last-lines');
const ps = require('ps-node');
const mime = require('mime-types');

const logger = require('./logger');
const config_api = require('./config.js');
const downloader_api = require('./downloader');
const tasks_api = require('./tasks');
const subscriptions_api = require('./subscriptions');
const categories_api = require('./categories');
const twitch_api = require('./twitch');
const youtubedl_api = require('./youtube-dl');
const archive_api = require('./archive');
const files_api = require('./files');
const notifications_api = require('./notifications');
const transcoding_api = require('./transcoding');

var app = express();
const CONFIG_ROOT_KEY = 'YtdlMaterial';
const LEGACY_CONFIG_ROOT_KEY = ['Youtube', 'DLMaterial'].join('');

function normalizeConfigRoot(config_file) {
    if (!config_file || typeof config_file !== 'object') return config_file;
    if (config_file[CONFIG_ROOT_KEY] !== undefined) return config_file;
    if (config_file[LEGACY_CONFIG_ROOT_KEY] === undefined) return config_file;

    config_file[CONFIG_ROOT_KEY] = config_file[LEGACY_CONFIG_ROOT_KEY];
    delete config_file[LEGACY_CONFIG_ROOT_KEY];
    return config_file;
}

function parseTrustProxySetting(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return value;

    const trimmed = value.trim();
    if (trimmed === '') return undefined;

    const lowerValue = trimmed.toLowerCase();
    if (lowerValue === 'true') return true;
    if (lowerValue === 'false') return false;
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (trimmed.includes(',')) return trimmed.split(',').map(item => item.trim()).filter(item => item !== '');

    return trimmed;
}

function getFirstDefinedEnvValue(envKeys = []) {
    for (const envKey of envKeys) {
        if (process.env[envKey] !== undefined) return {envKey, value: process.env[envKey]};
    }
    return {envKey: null, value: undefined};
}

function parseUmaskSetting(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value !== 'string') return undefined;

    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (/^0o[0-7]+$/i.test(trimmed)) return parseInt(trimmed.slice(2), 8);
    if (/^[0-7]+$/.test(trimmed)) return parseInt(trimmed, 8);

    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function configureExpressTrustProxy() {
    const {envKey: trustProxyEnvKey, value: rawTrustProxyValue} = getFirstDefinedEnvValue(['ytdl_trust_proxy', 'YTDL_TRUST_PROXY']);
    const trustProxyFromEnv = parseTrustProxySetting(rawTrustProxyValue);
    if (trustProxyFromEnv !== undefined) {
        app.set('trust proxy', trustProxyFromEnv);
        logger.info(`Express trust proxy configured from ${trustProxyEnvKey}: ${JSON.stringify(trustProxyFromEnv)}`);
        return;
    }

    const reverseProxyWhitelist = config_api.getConfigItem('ytdl_reverse_proxy_whitelist');
    if (reverseProxyWhitelist && reverseProxyWhitelist.trim() !== '') {
        const trustedProxies = reverseProxyWhitelist
            .split(',')
            .map(item => item.trim())
            .filter(item => item !== '');

        if (trustedProxies.length > 0) {
            app.set('trust proxy', trustedProxies);
            logger.info('Express trust proxy configured from reverse proxy whitelist.');
        }
    }
}

// database setup
const FileSync = require('./lowdb-compat/adapters/FileSync');

const adapter = new FileSync('./appdata/db.json');
const db = low(adapter)

const users_adapter = new FileSync('./appdata/users.json');
const users_db = low(users_adapter);

// env var setup

const {value: rawUmaskValue} = getFirstDefinedEnvValue(['ytdl_umask', 'YTDL_UMASK']);
const umask = parseUmaskSetting(rawUmaskValue);
if (umask !== undefined) process.umask(umask);

// check if debug mode
let debugMode = process.env.YTDL_MODE === 'debug';

// logging setup

config_api.initialize();
db_api.initialize(db, users_db);
auth_api.initialize(db_api);

// Set some defaults
db.defaults(
    {
        playlists: [],
        files: [],
        configWriteFlag: false,
        downloads: {},
        subscriptions: [],
        files_to_db_migration_complete: false,
        tasks_manager_role_migration_complete: false,
        archives_migration_complete: false
}).write();

users_db.defaults(
    {
        users: [],
        roles: {
            "admin": {
                "permissions": [
                    'filemanager',
                    'settings',
                    'subscriptions',
                    'sharing',
                    'advanced_download',
                    'downloads_manager'
                ]
            }, "user": {
                "permissions": [
                    'filemanager',
                    'subscriptions',
                    'sharing'
                ]
            }
        }
    }
).write();

// config values
let url = null;
let backendPort = null;
let useDefaultDownloadingAgent = null;
let customDownloadingAgent = null;
let allowSubscriptions = null;

// other needed values
let url_domain = null;
let updaterStatus = null;

const concurrentStreams = {};

// Snipping re-encodes and can run for minutes, far longer than a request should stay open,
// so jobs are tracked here and the client polls for the result. These are deliberately
// in-memory: a snip that was interrupted by a restart is not worth resuming.
// A null-prototype map so a job_uid like '__proto__' cannot resolve to an inherited value.
const snipJobs = Object.create(null);
const SNIP_JOB_RETENTION_MS = 30 * 60 * 1000;
// Each snip is a full re-encode, so an unbounded queue would let one client saturate the
// server's CPU.
const MAX_ACTIVE_SNIP_JOBS = 3;

function pruneSnipJobs() {
    const now = Date.now();
    for (const job_uid of Object.keys(snipJobs)) {
        const job = snipJobs[job_uid];
        if (job['finished'] && now - job['finished'] > SNIP_JOB_RETENTION_MS) delete snipJobs[job_uid];
    }
}

function countActiveSnipJobs() {
    return Object.keys(snipJobs).filter(job_uid => snipJobs[job_uid]['status'] === 'snipping').length;
}
const OPENAPI_SPEC_PATH_CANDIDATES = [
    path.resolve(__dirname, '..', 'Public API v1.yaml'),
    path.resolve(__dirname, 'Public API v1.yaml')
];

let documentation_api_enabled = false;
let documentation_api_handler = null;
let openapi_spec_path = null;
let redisRateLimitClient = null;
let redisRateLimitReconnectTimer = null;
let redisRateLimitConnectionString = '';

if (debugMode) logger.info('YTDL-Material in debug mode!');

// check if just updated
const just_updated = fs.existsSync('restart_update.json');
if (just_updated) {
    updaterStatus = {
        updating: false,
        details: 'Update complete! You are now on ' + CONSTS['CURRENT_VERSION']
    }
    fs.unlinkSync('restart_update.json');
}

if (fs.existsSync('restart_general.json')) fs.unlinkSync('restart_general.json');

// updates & starts youtubedl (commented out b/c of repo takedown)
// startYoutubeDL();

var validDownloadingAgents = [
    'aria2c',
    'avconv',
    'axel',
    'curl',
    'ffmpeg',
    'httpie',
    'wget'
];

const subscription_timeouts = {};

let version_info = null;
if (fs.existsSync('version.json')) {
    version_info = fs.readJSONSync('version.json');
    logger.verbose(`Version info: ${JSON.stringify(version_info, null, 2)}`);
} else {
    version_info = {'type': 'N/A', 'tag': 'N/A', 'commit': 'N/A', 'date': 'N/A'};
}

// don't overwrite config if it already happened.. NOT
// let alreadyWritten = db.get('configWriteFlag').value();

// checks if config exists, if not, a config is auto generated
config_api.configExistsCheck();

setAndLoadConfig();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// use passport
app.use(auth_api.passport.initialize());

// reverse proxy whitelist
app.use(reverseProxyWhitelistMiddleware);

// actual functions

async function checkMigrations() {
    // 4.1->4.2 migration
    
    const simplified_db_migration_complete = db.get('simplified_db_migration_complete').value();
    if (!simplified_db_migration_complete) {
        logger.info('Beginning migration: 4.1->4.2+')
        let success = await simplifyDBFileStructure();
        success = success && await files_api.addMetadataPropertyToDB('view_count');
        success = success && await files_api.addMetadataPropertyToDB('description');
        success = success && await files_api.addMetadataPropertyToDB('height');
        success = success && await files_api.addMetadataPropertyToDB('abr');
        // sets migration to complete
        db.set('simplified_db_migration_complete', true).write();
        if (success) { logger.info('4.1->4.2+ migration complete!'); }
        else { logger.error('Migration failed: 4.1->4.2+'); }
    }

    const new_db_system_migration_complete = db.get('new_db_system_migration_complete').value();
    if (!new_db_system_migration_complete) {
        logger.info('Beginning migration: 4.2->4.3+')
        let success = await db_api.importJSONToDB(db.value(), users_db.value());
        await tasks_api.setupTasks(); // necessary as tasks were not properly initialized at first
        // sets migration to complete
        db.set('new_db_system_migration_complete', true).write();
        if (success) { logger.info('4.2->4.3+ migration complete!'); }
        else { logger.error('Migration failed: 4.2->4.3+'); }
    }

    const tasks_manager_role_migration_complete = db.get('tasks_manager_role_migration_complete').value();
    if (!tasks_manager_role_migration_complete) {
        logger.info('Checking if tasks manager role permissions exist for admin user...');
        const success = await auth_api.changeRolePermissions('admin', 'tasks_manager', 'yes');
        if (success) logger.info('Task manager permissions check complete!');
        else logger.error('Failed to auto add tasks manager permissions to admin role!');
        db.set('tasks_manager_role_migration_complete', true).write();
    }

    const archives_migration_complete = db.get('archives_migration_complete').value();
    if (!archives_migration_complete) {
        logger.info('Checking if archives have been migrated...');
        const imported_archives = await archive_api.importArchives();
        if (imported_archives) logger.info('Archives migration complete!');
        else logger.error('Failed to migrate archives!');
        db.set('archives_migration_complete', true).write();
    }

    return true;
}

async function simplifyDBFileStructure() {
    // back up db files
    const old_db_file = fs.readJSONSync('./appdata/db.json');
    const old_users_db_file = fs.readJSONSync('./appdata/users.json');
    fs.writeJSONSync('appdata/db.old.json', old_db_file);
    fs.writeJSONSync('appdata/users.old.json', old_users_db_file);

    // simplify
    let users = users_db.get('users').value();
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        if (user['files']['video'] !== undefined && user['files']['audio'] !== undefined) {
            const user_files = user['files']['video'].concat(user['files']['audio']);
            const user_db_path = users_db.get('users').find({uid: user['uid']});
            user_db_path.assign({files: user_files}).write();
        }
        if (user['playlists']['video'] !== undefined && user['playlists']['audio'] !== undefined) {
            const user_playlists = user['playlists']['video'].concat(user['playlists']['audio']);
            const user_db_path = users_db.get('users').find({uid: user['uid']});
            user_db_path.assign({playlists: user_playlists}).write();
        }
    }

    if (db.get('files.video').value() !== undefined && db.get('files.audio').value() !== undefined) {
        const files = db.get('files.video').value().concat(db.get('files.audio').value());
        db.assign({files: files}).write();
    }

    if (db.get('playlists.video').value() !== undefined && db.get('playlists.audio').value() !== undefined) {
        const playlists = db.get('playlists.video').value().concat(db.get('playlists.audio').value());
        db.assign({playlists: playlists}).write();
    }
    

    return true;
}

// CIDR IP checking utility
function ipInCIDR(ip, cidr) {
    const [range, bits = 32] = cidr.split('/');
    const mask = ~(2 ** (32 - bits) - 1);
    const ipNum = ip.split('.').reduce((int, oct) => (int << 8) + parseInt(oct, 10), 0) >>> 0;
    const rangeNum = range.split('.').reduce((int, oct) => (int << 8) + parseInt(oct, 10), 0) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
}

// Reverse proxy whitelist middleware
function reverseProxyWhitelistMiddleware(req, res, next) {
    const whitelist = config_api.getConfigItem('ytdl_reverse_proxy_whitelist');

    if (!whitelist || whitelist.trim() === '') {
        // No whitelist configured, allow all
        return next();
    }

    // Get the direct connecting IP (the reverse proxy itself, not the end client)
    const proxyIp = (req.connection.remoteAddress || req.socket.remoteAddress || '').replace('::ffff:', '');

    // Parse whitelist (can be comma-separated CIDRs)
    const allowedRanges = whitelist.split(',').map(s => s.trim()).filter(s => s);

    // Check if IP is in any of the allowed ranges
    for (const range of allowedRanges) {
        try {
            if (ipInCIDR(proxyIp, range)) {
                return next();
            }
        } catch (e) {
            logger.warn(`Invalid CIDR range in whitelist: ${range}`);
        }
    }

    logger.warn(`Access denied for reverse proxy IP ${proxyIp} - not in whitelist`);
    return res.status(403).send('Access forbidden');
}

async function startServer() {
    if (process.env.USING_HEROKU && process.env.PORT) {
        // default to heroku port if using heroku
        backendPort = process.env.PORT || backendPort;

        // set config to port
        await setPortItemFromENV();
    }

    // Check if SSL certificates are configured
    const sslCertPath = config_api.getConfigItem('ytdl_ssl_cert_path');
    const sslKeyPath = config_api.getConfigItem('ytdl_ssl_key_path');

    let server;

    if (sslCertPath && sslKeyPath && fs.existsSync(sslCertPath) && fs.existsSync(sslKeyPath)) {
        // Start HTTPS server
        const httpsOptions = {
            cert: fs.readFileSync(sslCertPath),
            key: fs.readFileSync(sslKeyPath)
        };

        server = https.createServer(httpsOptions, app);
        server.listen(backendPort, function() {
            logger.info(`ytdl-material ${CONSTS['CURRENT_VERSION']} started on HTTPS PORT ${backendPort}`);
        });
    } else {
        // Start HTTP server
        if (sslCertPath || sslKeyPath) {
            logger.warn('SSL certificate or key path configured but files not found. Starting HTTP server instead.');
        }

        server = http.createServer(app);
        server.listen(backendPort, function() {
            logger.info(`ytdl-material ${CONSTS['CURRENT_VERSION']} started on HTTP PORT ${backendPort}`);
        });
    }
}

async function updateServer(tag) {
    // no tag provided means update to the latest version
    if (!tag) {
        const new_version_available = await isNewVersionAvailable();
        if (!new_version_available) {
            logger.error('ERROR: Failed to update - no update is available.');
            return false;
        }
    }

    return new Promise(async resolve => {
        // backup current dir
        updaterStatus = {
            updating: true,
            'details': 'Backing up key server files...'
        }
        let backup_succeeded = await backupServerLite();
        if (!backup_succeeded) {
            resolve(false);
            return false;
        }

        updaterStatus = {
            updating: true,
            'details': 'Downloading requested release...'
        }
        // grab new package.json and public folder
        await downloadReleaseFiles(tag);

        updaterStatus = {
            updating: true,
            'details': 'Installing new dependencies...'
        }
        // run npm install
        await installDependencies();

        updaterStatus = {
            updating: true,
            'details': 'Update complete! Restarting server...'
        }
        utils.restartServer(true);
    }, err => {
        logger.error(err);
        updaterStatus = {
            updating: false,
            error: true,
            'details': 'Update failed. Check error logs for more info.'
        }
    });
}

async function downloadReleaseFiles(tag) {
    tag = tag ? tag : await getLatestVersion();
    const safeTag = getValidatedReleaseTag(tag);
    const releaseZipPath = getSafeReleaseZipPath(tag);
    if (!safeTag || !releaseZipPath) {
        logger.error(`Refusing to install release with invalid tag: ${tag}`);
        return false;
    }

    return new Promise(async resolve => {
        logger.info('Downloading new files...')

        // downloads the latest release zip file
        const zipDownloaded = await downloadReleaseZip(safeTag);
        if (!zipDownloaded) {
            resolve(false);
            return;
        }

        // deletes contents of public dir
        fs.removeSync(path.join(__dirname, 'public'));
        fs.mkdirSync(path.join(__dirname, 'public'));

        let replace_ignore_list = ['ytdl-material/appdata/default.json',
                                    'ytdl-material/appdata/db.json',
                                    'ytdl-material/appdata/users.json',
                                    'ytdl-material/appdata/*']
        logger.info(`Installing update ${safeTag}...`)

        // downloads new package.json and adds new public dir files from the downloaded zip
        fs.createReadStream(releaseZipPath).pipe(unzipper.Parse())
        .on('entry', function (entry) {
            var fileName = entry.path;
            var is_dir = fileName.substring(fileName.length-1, fileName.length) === '/'
            if (!is_dir && fileName.includes('ytdl-material/public/')) {
                // get public folder files
                const actualFileName = fileName.replace('ytdl-material/public/', '');
                if (actualFileName.length !== 0 && actualFileName.substring(actualFileName.length-1, actualFileName.length) !== '/') {
                    const publicBasePath = path.join(__dirname, 'public');
                    const targetPublicPath = path.resolve(publicBasePath, actualFileName);
                    const relativePublicPath = path.relative(publicBasePath, targetPublicPath);
                    if (relativePublicPath.startsWith('..') || path.isAbsolute(relativePublicPath)) {
                        logger.warn(`Skipping unsafe public file path during update extraction: ${actualFileName}`);
                        entry.autodrain();
                        return;
                    }

                    fs.ensureDirSync(path.dirname(targetPublicPath));
                    entry.pipe(fs.createWriteStream(targetPublicPath));
                } else {
                    entry.autodrain();
                }
            } else if (!is_dir && !replace_ignore_list.includes(fileName)) {
                // get package.json
                const actualFileName = fileName.replace('ytdl-material/', '');
                const repoBasePath = path.resolve(__dirname);
                const targetFilePath = path.resolve(repoBasePath, actualFileName);
                const relativeRepoPath = path.relative(repoBasePath, targetFilePath);
                if (relativeRepoPath.startsWith('..') || path.isAbsolute(relativeRepoPath)) {
                    logger.warn(`Skipping unsafe file path during update extraction: ${actualFileName}`);
                    entry.autodrain();
                    return;
                }
                logger.verbose('Downloading file ' + actualFileName);
                entry.pipe(fs.createWriteStream(targetFilePath));
            } else {
                entry.autodrain();
            }
        })
        .on('close', function () {
            resolve(true);
        });
    });
}

async function downloadReleaseZip(tag) {
    return new Promise(async resolve => {
        const safeTag = getValidatedReleaseTag(tag);
        const resolvedOutputPath = getSafeReleaseZipPath(tag);
        if (!safeTag || !resolvedOutputPath) {
            logger.error(`Refusing to download release with invalid tag: ${tag}`);
            resolve(false);
            return;
        }

        // get name of zip file, which depends on the version
        const tag_without_v = safeTag.substring(1, safeTag.length);
        const zip_file_name = `ytdl-material-${tag_without_v}.zip`;
        const latest_zip_link = `https://github.com/voc0der/ytdl-material/releases/download/${encodeURIComponent(safeTag)}/${encodeURIComponent(zip_file_name)}`;

        // download zip from release
        const res = await fetch(latest_zip_link);
        if (!res.ok) {
            logger.error(`Failed to download release zip for ${safeTag}: HTTP ${res.status}`);
            resolve(false);
            return;
        }
        await utils.writeFetchResponseToFile(res, fs.createWriteStream(resolvedOutputPath), 'update ' + safeTag);
        resolve(true);
    });

}

async function installDependencies() {
    var child_process = require('child_process');
    var exec = promisify(child_process.exec);

    await exec('npm install',{stdio:[0,1,2]});
    return true;
}

async function backupServerLite() {
    await fs.ensureDir(path.join(__dirname, 'appdata', 'backups'));
    let output_path = path.join('appdata', 'backups', `backup-${Date.now()}.zip`);
    logger.info(`Backing up your non-video/audio files to ${output_path}. This may take up to a few seconds/minutes.`);
    let output = fs.createWriteStream(path.join(__dirname, output_path));

    await new Promise(resolve => {
        // archiver 8 exports classes rather than a callable factory; the old form threw.
        var archive = new ZipArchive({
            zlib: { level: 9 } // Sets the compression level.
        });

        archive.on('error', function(err) {
            logger.error(err);
            resolve(false);
        });

        // pipe archive data to the output file
        archive.pipe(output);

        // ignore certain directories (ones with video or audio files)
        const files_to_ignore = [path.join(config_api.getConfigItem('ytdl_subscriptions_base_path'), '**'),
                                path.join(config_api.getConfigItem('ytdl_audio_folder_path'), '**'),
                                path.join(config_api.getConfigItem('ytdl_video_folder_path'), '**'),
                                'appdata/backups/backup-*.zip'];

        archive.glob('**/*', {
            ignore: files_to_ignore
        });

        resolve(archive.finalize());
    });

    // wait a tiny bit for the zip to reload in fs
    await utils.wait(100);
    return true;
}

async function isNewVersionAvailable() {
    // gets tag of the latest version of ytdl-material, compare to current version
    const latest_tag = await getLatestVersion();
    const current_tag = CONSTS['CURRENT_VERSION'];
    if (compareReleaseVersions(latest_tag, current_tag) > 0) {
        return true;
    } else {
        return false;
    }
}

function parseReleaseVersion(tag) {
    if (!tag || typeof tag !== 'string') {
        return null;
    }

    const match = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/i);
    if (!match) {
        return null;
    }

    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] === undefined ? null : Number(match[4])
    };
}

function compareReleaseVersions(a, b) {
    const parsedA = parseReleaseVersion(a);
    const parsedB = parseReleaseVersion(b);

    if (!parsedA || !parsedB) {
        return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
    }

    for (const field of ['major', 'minor', 'patch']) {
        if (parsedA[field] !== parsedB[field]) {
            return parsedA[field] - parsedB[field];
        }
    }

    if (parsedA.prerelease === parsedB.prerelease) {
        return 0;
    }

    if (parsedA.prerelease === null) {
        return 1;
    }

    if (parsedB.prerelease === null) {
        return -1;
    }

    return parsedA.prerelease - parsedB.prerelease;
}

async function getLatestVersion() {
    const res = await fetch('https://api.github.com/repos/voc0der/ytdl-material/releases/latest', {method: 'Get'});
    const json = await res.json();

    if (json['message']) {
        // means there's an error in getting latest version
        logger.error(`ERROR: Received the following message from GitHub's API:`);
        logger.error(json['message']);
        if (json['documentation_url']) logger.error(`Associated URL: ${json['documentation_url']}`)
    }
    return json['tag_name'];
}

async function killAllDownloads() {
    const lookupAsync = promisify(ps.lookup);
    let resultList = null;

    try {
        resultList = await lookupAsync({
            command: 'youtube-dl'
        });
    } catch (err) {
        // failed to get list of processes
        logger.error('Failed to get a list of running youtube-dl processes.');
        logger.error(err);
        return {
            details: err,
            success: false
        };
    }

    // processes that contain the string 'youtube-dl' in the name will be looped
    resultList.forEach(function( process ){
        if (process) {
            ps.kill(process.pid, 'SIGKILL', function( err ) {
                if (err) {
                    // failed to kill, process may have ended on its own
                    logger.warn(`Failed to kill process with PID ${process.pid}`);
                    logger.warn(err);
                }
                else {
                    logger.verbose(`Process ${process.pid} has been killed!`);
                }
            });
        }
    });

    return {
        success: true
    };
}

async function setPortItemFromENV() {
    config_api.setConfigItem('ytdl_port', backendPort.toString());
    await utils.wait(100);
    return true;
}

function getOIDCMigrateTargetFromEnv() {
    return process.env.ytdl_oidc_migrate_videos || process.env.YTDL_OIDC_MIGRATE_VIDEOS || null;
}

function getScopedFilterByUser(user_uid) {
    if (!config_api.getConfigItem('ytdl_multi_user_mode')) return {};
    return {user_uid: user_uid};
}

async function migrateUnassignedVideosToConfiguredUser() {
    const migrate_target = getOIDCMigrateTargetFromEnv();
    if (!migrate_target) return true;

    const normalized_target = String(migrate_target).trim();
    const safe_uid = auth_api.sanitizeUserUID(normalized_target);
    if (!safe_uid) {
        throw new Error(`Invalid ytdl_oidc_migrate_videos value '${normalized_target}'. It must be a valid uid.`);
    }

    let target_user = await db_api.getRecord('users', {uid: safe_uid});
    if (!target_user) {
        target_user = await db_api.getRecord('users', {name: normalized_target});
    }

    if (!target_user) {
        throw new Error(`ytdl_oidc_migrate_videos requested migration to '${normalized_target}', but no such user exists.`);
    }

    const unassigned_filter = {user_uid: null};
    const unassigned_file_count = await db_api.getRecords('files', unassigned_filter, true);
    const unassigned_playlist_count = await db_api.getRecords('playlists', unassigned_filter, true);

    if (!unassigned_file_count && !unassigned_playlist_count) {
        throw new Error('No unassigned videos/files or playlists exist for ytdl_oidc_migrate_videos. Remove this env variable to continue startup.');
    }

    if (unassigned_file_count) {
        const migrated_files = await db_api.updateRecords('files', unassigned_filter, {user_uid: target_user.uid});
        if (!migrated_files) {
            throw new Error(`Failed to migrate unassigned videos/files to user '${target_user.uid}'.`);
        }
    }

    if (unassigned_playlist_count) {
        const migrated_playlists = await db_api.updateRecords('playlists', unassigned_filter, {user_uid: target_user.uid});
        if (!migrated_playlists) {
            throw new Error(`Failed to migrate unassigned playlists to user '${target_user.uid}'.`);
        }
    }

    logger.info(`Migrated ${unassigned_file_count} unassigned videos/files and ${unassigned_playlist_count} unassigned playlists to user '${target_user.uid}' from ytdl_oidc_migrate_videos.`);
    return true;
}

async function setAndLoadConfig() {
    try {
        await setConfigFromEnv();
        await loadConfig();
    } catch (err) {
        logger.error(`Startup failed: ${err.message}`);
        process.exit(1);
    }
}

async function setConfigFromEnv() {
    const config_items = getEnvConfigItems();
    if (!config_items || config_items.length === 0) return true;
    const success = config_api.setConfigItems(config_items);
    if (success) {
        logger.info('Config items set using ENV variables.');
        await utils.wait(100);
        return true;
    } else {
        logger.error('ERROR: Failed to set config items using ENV variables.');
        return false;
    }
}

async function loadConfig() {
    loadConfigValues();
    // non-blocking hardware transcoding flight test
    transcoding_api.initialize();
    initializeDocumentationAPI();
    await initializeRateLimiters();

    const oidc_enabled = oidc_api.isEnabled();
    if (oidc_enabled && !config_api.getConfigItem('ytdl_multi_user_mode')) {
        logger.error('OIDC startup failed: multi-user mode must be enabled when OIDC is enabled.');
        process.exit(1);
    }

    try {
        await oidc_api.initialize();
    } catch (err) {
        logger.error(`OIDC startup failed: ${err.message}`);
        process.exit(1);
    }

    // connect to DB
    if (!config_api.getConfigItem('ytdl_use_local_db')) {
        await db_api.runConfiguredDBMigration();
        await db_api.connectToDB();
        await db_api.bootstrapRemoteDBFromLocalIfNeeded();
    }
    db_api.database_initialized = true;
    db_api.database_initialized_bs.next(true);

    // check migrations
    await checkMigrations();
    await migrateUnassignedVideosToConfiguredUser();

    // now this is done here due to youtube-dl's repo takedown
    await startYoutubeDL();

    // get subscriptions
    if (allowSubscriptions) {
        // set downloading to false
        let subscriptions = await subscriptions_api.getAllSubscriptions();
        await Promise.all(subscriptions.map(async sub => {
            subscriptions_api.writeSubscriptionMetadata(sub);
            await db_api.updateRecord('subscriptions', {id: sub.id}, {
                downloading: false,
                child_process: null,
                refresh_status: subscriptions_api.buildInterruptedSubscriptionRefreshStatus(sub.refresh_status)
            });
        }));
        await tasks_api.executeRunOnStartup('subscriptions_check');
    }

    // start the server here
    startServer();

    return true;
}

function loadConfigValues() {
    url = !debugMode ? config_api.getConfigItem('ytdl_url') : 'http://localhost:4200';
    backendPort = config_api.getConfigItem('ytdl_port');
    useDefaultDownloadingAgent = config_api.getConfigItem('ytdl_use_default_downloading_agent');
    customDownloadingAgent = config_api.getConfigItem('ytdl_custom_downloading_agent');
    allowSubscriptions = config_api.getConfigItem('ytdl_allow_subscriptions');

    if (!useDefaultDownloadingAgent && validDownloadingAgents.indexOf(customDownloadingAgent) !== -1 ) {
        logger.info(`Using non-default downloading agent \'${customDownloadingAgent}\'`)
    } else {
        customDownloadingAgent = null;
    }

    // empty url defaults to default URL
    if (!url || url === '') url = 'http://example.com'
    url_domain = new URL(url);

    if (!logger.hasEnvLogLevelOverride()) {
        let logger_level = config_api.getConfigItem('ytdl_logger_level');
        utils.updateLoggerLevel(logger_level);
    }

    configureExpressTrustProxy();
    warnAboutDeprecatedPublicApiKey();
}

/*************************************************
 * Said plainly at startup, because an administrator
 * who switched this on almost certainly believes it
 * is protecting the API.
 ************************************************/
function warnAboutDeprecatedPublicApiKey() {
    if (!config_api.getConfigItem('ytdl_use_api_key')) return;

    logger.warn('The Public API key is deprecated and does not restrict access to the API. '
        + 'It never has: the key was not required to reach any endpoint, and it did not identify '
        + 'the caller, so it could not authorize anything either. Requests are authorized by the '
        + 'JWT from /api/auth/login and by each route\'s permissions. The setting still controls '
        + 'whether the documentation page is served. Per-user API tokens are tracked in issue #388.');
}

function initializeDocumentationAPI() {
    const docs_enabled = !!config_api.getConfigItem('ytdl_enable_documentation_api');
    const public_api_enabled = !!config_api.getConfigItem('ytdl_use_api_key');

    documentation_api_enabled = false;
    documentation_api_handler = null;
    openapi_spec_path = null;

    if (!docs_enabled) return;

    if (!public_api_enabled) {
        logger.warn('Documentation API is enabled in config but Public API is disabled. Skipping docs startup.');
        return;
    }

    openapi_spec_path = OPENAPI_SPEC_PATH_CANDIDATES.find(spec_path => fs.existsSync(spec_path)) || null;
    if (!openapi_spec_path) {
        logger.error(`Documentation API startup failed: OpenAPI spec not found. Checked: ${OPENAPI_SPEC_PATH_CANDIDATES.join(', ')}`);
        return;
    }

    const { apiReference } = require('@scalar/express-api-reference');
    documentation_api_handler = apiReference({
        url: '/openapi.yaml',
        pageTitle: 'ytdl-material API Reference'
    });
    documentation_api_enabled = true;

    logger.info('Documentation API enabled at /docs. Restart required for config changes to take effect.');
}

function getOrigin() {
    if (process.env.CODESPACES) return `https://${process.env.CODESPACE_NAME}-4200.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
    return url_domain.origin;
}

const VALID_RELEASE_TAG_PATTERN = /^v[0-9A-Za-z][0-9A-Za-z._-]*$/;
const XML_ENTITY_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
};

function getValidatedReleaseTag(tag) {
    return (typeof tag === 'string' && VALID_RELEASE_TAG_PATTERN.test(tag)) ? tag : null;
}

function getSafeReleaseZipPath(tag) {
    const validTag = getValidatedReleaseTag(tag);
    if (!validTag) return null;

    const resolvedOutputPath = path.resolve(__dirname, `ytdl-material-release-${validTag}.zip`);
    const relativeOutputPath = path.relative(__dirname, resolvedOutputPath);
    if (relativeOutputPath.startsWith('..') || path.isAbsolute(relativeOutputPath)) return null;

    return resolvedOutputPath;
}

function escapeXmlEntities(value) {
    if (value === undefined || value === null) return value;
    return String(value).replace(/[&<>"']/g, char => XML_ENTITY_MAP[char]);
}

function isEnvConfigItemDefined(key) {
    return process.env[key] !== undefined || process.env[key.toUpperCase()] !== undefined;
}

// gets a list of config items that are stored as an environment variable
function getEnvConfigItems() {
    let config_items = [];

    let config_item_keys = Object.keys(config_api.CONFIG_ITEMS);
    for (let i = 0; i < config_item_keys.length; i++) {
        let key = config_item_keys[i];
        if (isEnvConfigItemDefined(key)) {
            const config_item = generateEnvVarConfigItem(key);
            config_items.push(config_item);
        }
    }

    return config_items;
}

// gets value of a config item and stores it in an object
function generateEnvVarConfigItem(key) {
    const value = process.env[key] !== undefined ? process.env[key] : process.env[key.toUpperCase()];
    return {key: key, value: value};
}

// youtube-dl functions

async function startYoutubeDL() {
    // auto update youtube-dl
    await youtubedl_api.checkForYoutubeDLUpdate();
}

app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Origin", getOrigin());
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

/*************************************************
 * The Public API key is deprecated and does not
 * restrict anything.
 *
 * It never did. This gate used to close the socket
 * unless the caller presented a hardcoded UUID --
 * one that ships in the frontend bundle and is
 * published in this repository, so everybody had
 * it. Nor can it be made to restrict anything
 * without taking the web UI down with it: the UI
 * has no configured key to send, and handing it one
 * would only publish that key to every page load.
 *
 * A key also never established *who* was calling,
 * so it could not authorize anything even when it
 * matched. What decides whether a request is
 * allowed is optionalJwt and the route guards, and
 * those run next.
 *
 * The apiKey query parameter is still accepted and
 * ignored, so scripts that send one keep working.
 * Per-user API tokens, which are the real
 * replacement, are tracked in #388.
 ************************************************/
app.use(function(req, res, next) {
    next();
});

app.use(compression());

const rateLimitValidateOptions = {
    xForwardedForHeader: false
};


const testCookiesRateLimitStore = new DelegatingRateLimitStore('ytdl:rate-limit:test-cookies:');
const apiRateLimitStore = new DelegatingRateLimitStore('ytdl:rate-limit:api:');
const authRateLimitStore = new DelegatingRateLimitStore('ytdl:rate-limit:auth:');
const docsRateLimitStore = new DelegatingRateLimitStore('ytdl:rate-limit:docs:');

const testCookiesRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    validate: rateLimitValidateOptions,
    store: testCookiesRateLimitStore,
    passOnStoreError: false,
    message: {
        success: false,
        error: 'Too many cookie test requests. Please wait a minute and try again.'
    }
});

const apiRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    validate: rateLimitValidateOptions,
    store: apiRateLimitStore,
    passOnStoreError: false,
    // Keep routine read-only browsing/status requests usable while protecting mutating/file-system routes.
    skip: skipApiRateLimit
});

const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 25,
    standardHeaders: true,
    legacyHeaders: false,
    validate: rateLimitValidateOptions,
    store: authRateLimitStore,
    passOnStoreError: false,
    skip: skipAuthRateLimit,
    message: {
        success: false,
        error: 'Too many authentication requests. Please wait and try again.'
    }
});

const docsRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    validate: rateLimitValidateOptions,
    store: docsRateLimitStore,
    passOnStoreError: false
});

function clearRedisRateLimitReconnectTimer() {
    if (!redisRateLimitReconnectTimer) return;
    clearTimeout(redisRateLimitReconnectTimer);
    redisRateLimitReconnectTimer = null;
}

function scheduleRedisRateLimitReconnect(delayMs = 5000) {
    if (!redisRateLimitConnectionString || redisRateLimitReconnectTimer) return;

    redisRateLimitReconnectTimer = setTimeout(async () => {
        redisRateLimitReconnectTimer = null;
        const connected = await connectRedisRateLimitClient(redisRateLimitConnectionString, { scheduleRetryOnFailure: true });
        if (!connected) scheduleRedisRateLimitReconnect(delayMs);
    }, delayMs);
}

function attachRedisRateLimitClientEventHandlers(client) {
    client.on('ready', () => {
        logger.info('Redis rate-limit client ready.');
    });
    client.on('reconnecting', () => {
        logger.warn('Redis rate-limit client reconnecting. Using in-memory rate limiting until Redis is ready again.');
    });
    client.on('end', () => {
        logger.warn('Redis rate-limit client connection ended.');
    });
}

async function connectRedisRateLimitClient(connectionString, options = {}) {
    const { scheduleRetryOnFailure = false } = options;

    try {
        const client = await redis_store.createConnection(connectionString, {
            onError: error => {
                logger.warn(`Redis rate-limit client error: ${error.message}`);
            }
        });

        attachRedisRateLimitClientEventHandlers(client);
        clearRedisRateLimitReconnectTimer();
        redisRateLimitClient = client;
        await testCookiesRateLimitStore.useRedisStore(redisRateLimitClient);
        await apiRateLimitStore.useRedisStore(redisRateLimitClient);
        await authRateLimitStore.useRedisStore(redisRateLimitClient);
        await docsRateLimitStore.useRedisStore(redisRateLimitClient);
        logger.info('Redis-backed rate limiting enabled.');
        return true;
    } catch (error) {
        logger.warn(`Redis rate-limit store initialization failed. Using in-memory rate limiting instead. ${error.message}`);
        if (scheduleRetryOnFailure) scheduleRedisRateLimitReconnect();
        return false;
    }
}

async function initializeRateLimiters() {
    await testCookiesRateLimitStore.useMemoryStore();
    await apiRateLimitStore.useMemoryStore();
    await authRateLimitStore.useMemoryStore();
    await docsRateLimitStore.useMemoryStore();
    clearRedisRateLimitReconnectTimer();

    if (redisRateLimitClient) {
        await redis_store.closeConnection(redisRateLimitClient).catch(() => null);
        redisRateLimitClient = null;
    }

    const redisConnectionString = config_api.getConfigItem('ytdl_redis_connection_string');
    redisRateLimitConnectionString = typeof redisConnectionString === 'string' ? redisConnectionString.trim() : '';
    if (!redisRateLimitConnectionString) {
        return true;
    }

    return connectRedisRateLimitClient(redisRateLimitConnectionString, { scheduleRetryOnFailure: true });
}

app.use('/api', apiRateLimiter);
app.use('/api/auth', authRateLimiter);

// Reachable before login on purpose: the frontend cannot render a login page without
// knowing the auth method, whether registration is open, and the theme. It cannot use
// optionalJwt for that reason -- an anonymous caller has to get a smaller answer rather
// than a 401 -- so entitlement is resolved here instead, and everyone else gets the file
// with the integration secrets removed.
app.get('/api/config', async function(req, res) {
    const multi_user_mode = !!config_api.getConfigItem('ytdl_multi_user_mode');
    const caller = multi_user_mode ? await auth_api.getUserFromJWT(req.query.jwt) : null;

    let config_file;
    if (!multi_user_mode) {
        // No accounts exist, so there is nobody to withhold anything from.
        config_file = config_api.getConfigFile();
    } else if (!caller) {
        config_file = config_api.getAnonymousConfigFile();
    } else if (caller.role === 'admin') {
        // Admin rather than the 'settings' permission: /api/setConfig is admin-only, so a
        // delegated user cannot save these anyway -- there is no reason to show them every
        // integration credential on the way to a page they cannot submit.
        config_file = config_api.getConfigFile();
    } else {
        config_file = config_api.getRedactedConfigFile();
    }
    res.send({
        config_file: config_file,
        ytdlp_impersonation_available: config_api.isYtDlpImpersonationDependencyEnvEnabled(),
        transcoding_status: transcoding_api.getStatus(),
        success: !!config_file
    });
});

app.post('/api/setConfig', optionalJwt, requireAdmin, function(req, res) {
    let new_config_file = normalizeConfigRoot(req.body.new_config_file);
    if (new_config_file && new_config_file[CONFIG_ROOT_KEY]) {
        let success = config_api.setConfigFile(new_config_file);
        loadConfigValues(); // reloads config values that exist as variables
        res.send({
            success: success
        });
    } else {
        logger.error('Tried to save invalid config file!')
        res.sendStatus(400);
    }
});

app.get('/api/versionInfo', (req, res) => {
    res.send({
        version_info: version_info,
        downloader_info: youtubedl_api.getAllYoutubeDLDetails()
    });
});

app.get('/openapi.yaml', docsRateLimiter, (req, res) => {
    if (!documentation_api_enabled || !openapi_spec_path) {
        res.sendStatus(404);
        return;
    }

    res.type('application/yaml');
    res.sendFile(openapi_spec_path);
});

app.use('/docs', docsRateLimiter, (req, res, next) => {
    if (!documentation_api_enabled || !documentation_api_handler) {
        res.sendStatus(404);
        return;
    }

    documentation_api_handler(req, res, next);
});

app.post('/api/restartServer', optionalJwt, requireAdmin, (req, res) => {
    // delayed by a little bit so that the client gets a response
    setTimeout(() => {utils.restartServer()}, 100);
    res.send({success: true});
});

app.get('/api/getDBInfo', optionalJwt, requireAdmin, async (req, res) => {
    const db_info = await db_api.getDBStats();
    res.send(db_info);
});

app.post('/api/transferDB', optionalJwt, requireAdmin, async (req, res) => {
    const local_to_remote = req.body.local_to_remote;
    let success = null;
    let error = '';
    const configured_remote_db_type = db_api.getConfiguredRemoteDBType({ preferMigrationTarget: true });
    const configured_remote_db_label = db_api.getDBLabel(configured_remote_db_type);
    if (local_to_remote === config_api.getConfigItem('ytdl_use_local_db')) {
        success = await db_api.transferDB(local_to_remote);
        if (!success) error = 'Unknown error';
        else config_api.setConfigItem('ytdl_use_local_db', !local_to_remote);
    } else {
        success = false;
        error = `Failed to transfer DB as it cannot transition into its current status: ${local_to_remote ? configured_remote_db_label : 'Local DB'}`;
        logger.error(error);
    }

    res.send({success: success, error: error});
});

app.post('/api/testConnectionString', optionalJwt, requireAdmin, async (req, res) => {
    const connection_string = req.body.connection_string;
    let success = null;
    let error = '';
    if (redis_store.isRedisConnectionString(connection_string)) {
        const result = await redis_store.testConnectionString(connection_string);
        success = result.success;
        error = result.error || '';
    } else {
        success = await db_api.connectToDB(0, true, connection_string);
        if (!success) error = 'Connection string failed.';
    }

    res.send({success: success, error: error});
});

/*************************************************
 * customArgs, additionalArgs and customOutput are
 * the advanced download feature. The permission
 * that names it was only ever checked on the dialog
 * that previews the arguments, not on the endpoints
 * that hand them to the downloader -- so it has to
 * be checked wherever they are accepted.
 *
 * The argument content is then checked regardless
 * of the answer: holding advanced_download is not
 * meant to include running commands as the server.
 ************************************************/
async function refuseUnsafeDownloadOptions(req, options, url = undefined) {
    if (utils.hasAdvancedDownloadOptions(options) && config_api.getConfigItem('ytdl_multi_user_mode')) {
        if (!req.user) return {status: 401, error: 'Authentication required'};
        if (!await auth_api.userHasPermission(req.user.uid, 'advanced_download')) {
            return {status: 403, error: 'Missing the \'advanced_download\' permission'};
        }
    }

    for (const field of ['customArgs', 'additionalArgs']) {
        const disallowed_args = utils.findDisallowedDownloadArgs(options[field]);
        if (disallowed_args.length) {
            logger.error(`Refusing a download: ${field} contained ${disallowed_args.join(', ')}.`);
            return {status: 400, error: `These arguments are not allowed: ${disallowed_args.join(', ')}`};
        }
    }

    // Rejected here as well as at the downloader, so the caller is told why rather than
    // watching a download quietly fail to appear.
    if (url !== undefined && !utils.isAllowedDownloadURL(url)) {
        return {status: 400, error: 'Only http and https URLs can be downloaded'};
    }

    return null;
}

app.post('/api/downloadFile', optionalJwt, requireAuthenticated, async function(req, res) {
    req.setTimeout(0); // remove timeout in case of long videos
    const url = req.body.url;
    const type = req.body.type ? req.body.type : 'video';
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const options = {
        customArgs: req.body.customArgs,
        additionalArgs: req.body.additionalArgs,
        customOutput: req.body.customOutput,
        selectedHeight: req.body.selectedHeight,
        maxHeight: req.body.maxHeight,
        customQualityConfiguration: req.body.customQualityConfiguration,
        selectedAudioLanguage: req.body.selectedAudioLanguage,
        selectedSubtitleLanguage: req.body.selectedSubtitleLanguage,
        selectedSubtitleType: req.body.selectedSubtitleType,
        youtubeUsername: req.body.youtubeUsername,
        youtubePassword: req.body.youtubePassword,
        ui_uid: req.body.ui_uid,
        cropFileSettings: req.body.cropFileSettings,
        ignoreArchive: req.body.ignoreArchive,
        disableSponsorBlock: req.body.disableSponsorBlock,
        channelSearchPlaylist: !!req.body.channelSearchPlaylist
    };

    const refusal = await refuseUnsafeDownloadOptions(req, options, url);
    if (refusal) {
        res.status(refusal.status).send({success: false, error: refusal.error});
        return;
    }

    const downloads = await downloader_api.createDownloads(url, type, options, user_uid);

    if (downloads && downloads.length > 0) {
        res.send({download: downloads[0], downloads: downloads});
    } else {
        res.sendStatus(500);
    }
});

app.post('/api/killAllDownloads', optionalJwt, requireAdmin, async function(req, res) {
    const result_obj = await killAllDownloads();
    res.send(result_obj);
});

app.post('/api/deleteOrphanFiles', optionalJwt, requireAdmin, async function(req, res) {
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const result = await files_api.deleteOrphanFiles(user_uid);
    res.send(result);
});

app.post('/api/generateArgs', optionalJwt, requirePermission('advanced_download'), async function(req, res) {
    const url = req.body.url;
    const type = req.body.type;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const options = {
        customArgs: req.body.customArgs,
        additionalArgs: req.body.additionalArgs,
        customOutput: req.body.customOutput,
        selectedHeight: req.body.selectedHeight,
        maxHeight: req.body.maxHeight,
        customQualityConfiguration: req.body.customQualityConfiguration,
        selectedAudioLanguage: req.body.selectedAudioLanguage,
        selectedSubtitleLanguage: req.body.selectedSubtitleLanguage,
        selectedSubtitleType: req.body.selectedSubtitleType,
        youtubeUsername: req.body.youtubeUsername,
        youtubePassword: req.body.youtubePassword,
        ui_uid: req.body.ui_uid,
        cropFileSettings: req.body.cropFileSettings,
        disableSponsorBlock: req.body.disableSponsorBlock
    };

    const refusal = await refuseUnsafeDownloadOptions(req, options, url);
    if (refusal) {
        res.status(refusal.status).send({success: false, error: refusal.error});
        return;
    }

    // The preview is generated without the administrator's global arguments unless the
    // caller is one: advanced_download is delegable, and those arguments are a secret the
    // settings page already withholds from everybody else.
    const caller_may_see_global_args = !config_api.getConfigItem('ytdl_multi_user_mode')
        || (req.isAuthenticated() && !!req.user && req.user.role === 'admin');

    const args = await downloader_api.generateArgs(url, type, options, user_uid, true, caller_may_see_global_args);
    res.send({args: args});
});

// gets all download mp3s
app.get('/api/getMp3s', optionalJwt, requireAuthenticated, async function(req, res) {
    // TODO: simplify
    let mp3s = await db_api.getRecords('files', {isAudio: true});
    let playlists = await db_api.getRecords('playlists');
    const is_authenticated = req.isAuthenticated();
    if (is_authenticated) {
        // get user audio files/playlists
        auth_api.passport.authenticate('jwt')
        mp3s = await db_api.getRecords('files', {user_uid: req.user.uid, isAudio: true});
        playlists = await db_api.getRecords('playlists', {user_uid: req.user.uid}); // TODO: remove?
    }

    mp3s = JSON.parse(JSON.stringify(mp3s));

    res.send({
        mp3s: mp3s,
        playlists: playlists
    });
});

// gets all download mp4s
app.get('/api/getMp4s', optionalJwt, requireAuthenticated, async function(req, res) {
    let mp4s = await db_api.getRecords('files', {isAudio: false});
    let playlists = await db_api.getRecords('playlists');

    const is_authenticated = req.isAuthenticated();
    if (is_authenticated) {
        // get user videos/playlists
        auth_api.passport.authenticate('jwt')
        mp4s = await db_api.getRecords('files', {user_uid: req.user.uid, isAudio: false});
        playlists = await db_api.getRecords('playlists', {user_uid: req.user.uid}); // TODO: remove?
    }

    mp4s = JSON.parse(JSON.stringify(mp4s));

    res.send({
        mp4s: mp4s,
        playlists: playlists
    });
});

app.post('/api/getFile', optionalJwt, requireAuthenticatedOrShared, async function (req, res) {
    const uid = req.body.uid;
    const uuid = req.body.uuid;
    let file = null;
    if (req.isAuthenticated()) {
        file = await files_api.getVideo(uid, req.user.uid);
    } else if (uuid) {
        file = await auth_api.getUserVideo(uuid, uid, true);
    } else {
        file = await files_api.getVideo(uid);
    }

    // check if chat exists for twitch videos
    if (file && file['url'].includes('twitch.tv')) file['chat_exists'] = fs.existsSync(file['path'].substring(0, file['path'].length - 4) + '.twitch_chat.json');
    if (file) file = await files_api.attachFilePlaybackMetadata(file, true);

    if (file) {
        res.send({
            success: true,
            file: file
        });
    } else {
        res.send({
            success: false
        });
    }
});

app.post('/api/getAllFiles', optionalJwt, requireAuthenticated, async function (req, res) {
    // these are returned
    const sort = req.body.sort;
    const range = req.body.range;
    const text_search = req.body.text_search;
    const file_type_filter = req.body.file_type_filter;
    const favorite_filter = req.body.favorite_filter;
    const category_filter_uids = req.body.category_filter_uids;
    const sub_id = req.body.sub_id;
    const include_chapters = req.body.include_chapters === true;
    const uuid = req.isAuthenticated() ? req.user.uid : null;

    const {files, file_count} = await files_api.getAllFiles(sort, range, text_search, file_type_filter, favorite_filter, sub_id, uuid, category_filter_uids);
    const parsed_files = include_chapters ? files_api.attachFileChaptersCollection(files) : files;

    res.send({
        files: parsed_files,
        file_count: file_count,
    });
});

app.post('/api/getDuplicateSummary', optionalJwt, requirePermission('filemanager'), async function (req, res) {
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const summary = await files_api.getDuplicateSummary(user_uid);
    res.send(summary);
});

app.post('/api/getDuplicates', optionalJwt, requirePermission('filemanager'), async function (req, res) {
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const duplicates = await files_api.getDuplicateGroups(user_uid);
    res.send({
        duplicates: duplicates
    });
});

app.post('/api/removeNewestDuplicates', optionalJwt, requirePermission('filemanager'), async function (req, res) {
    const duplicate_key = req.body.duplicate_key;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const result = await files_api.removeNewestDuplicates(duplicate_key, user_uid);
    res.send(result);
});

app.post('/api/removeDuplicates', optionalJwt, requirePermission('filemanager'), async function (req, res) {
    const duplicate_key = req.body.duplicate_key;
    const removal_mode = req.body.removal_mode;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const result = await files_api.removeDuplicates(duplicate_key, removal_mode, user_uid);
    res.send(result);
});

// Fields the video info dialog can edit. Anything else in change_obj is dropped rather
// than written: the record also holds ownership and identity fields, and this endpoint
// has no business letting a client rewrite those.
const EDITABLE_FILE_FIELDS = [
    'title', 'uploader', 'url', 'upload_date', 'description', 'view_count',
    'local_view_count', 'height', 'abr', 'size', 'isAudio', 'favorite',
    'category', 'thumbnailURL', 'thumbnailPath'
];

// path is deliberately absent: the video info dialog only displays it, and letting a
// caller write it turns this into a way to point a record at another user's media -- or
// at a directory, which the delete path then removes recursively.
//
// thumbnailPath is editable because the dialog really does edit it, so it is checked
// instead: it has to land inside a directory this server already serves.
const PATH_FILE_FIELDS = ['thumbnailPath'];

app.post('/api/updateFile', optionalJwt, requirePermission('filemanager'), async function (req, res) {
    const uid = req.body.uid;
    const change_obj = req.body.change_obj;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;

    if (!change_obj || typeof change_obj !== 'object' || Array.isArray(change_obj)) {
        res.send({success: false, error: 'No changes provided'});
        return;
    }

    const filtered_change_obj = {};
    for (const field of EDITABLE_FILE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(change_obj, field)) filtered_change_obj[field] = change_obj[field];
    }

    for (const field of PATH_FILE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(filtered_change_obj, field)) continue;
        if (!utils.isPathInsideMediaRoots(filtered_change_obj[field], user_uid)) {
            logger.error(`Refusing to set ${field} on file ${uid} to a path outside the caller's media folders.`);
            res.send({success: false, error: `${field} must be inside a configured media folder`});
            return;
        }
    }

    if (Object.keys(filtered_change_obj).length === 0) {
        res.send({success: false, error: 'No editable changes provided'});
        return;
    }

    // Scoped to the caller in multi-user mode, so one user cannot edit another's records.
    const file_filter = {uid: uid};
    if (config_api.getConfigItem('ytdl_multi_user_mode') && user_uid) file_filter['user_uid'] = user_uid;

    const file = await db_api.updateRecord('files', file_filter, filtered_change_obj);

    if (!file) {
        res.send({
            success: false,
            error: 'File could not be found'
        });
    } else {
        res.send({
            success: true
        });
    }
});

app.post('/api/checkConcurrentStream', async (req, res) => {
    const uid = req.body.uid;

    const DEAD_SERVER_THRESHOLD = 10;

    if (concurrentStreams[uid] && Date.now()/1000 - concurrentStreams[uid]['unix_timestamp'] > DEAD_SERVER_THRESHOLD) {
        logger.verbose( `Killing dead stream on ${uid}`);
        delete concurrentStreams[uid];
    }

    res.send({stream: concurrentStreams[uid]})
});

app.post('/api/updateConcurrentStream', optionalJwt, requireAuthenticated, async (req, res) => {
    const uid = req.body.uid;
    const playback_timestamp = req.body.playback_timestamp;
    const unix_timestamp = req.body.unix_timestamp;
    const playing = req.body.playing;

    concurrentStreams[uid] = {
        playback_timestamp: playback_timestamp,
        unix_timestamp: unix_timestamp,
        playing: playing
    }

    res.send({stream: concurrentStreams[uid]})
});

app.post('/api/getFullTwitchChat', optionalJwt, requireAuthenticated, async (req, res) => {
    var id = req.body.id;
    var type = req.body.type;
    var uuid = req.body.uuid;
    var sub = req.body.sub;
    var user_uid = null;

    if (req.isAuthenticated()) {
        user_uid = req.user.uid;
        uuid = req.user.uid;
    }

    const chat_file = await twitch_api.getTwitchChatByFileID(id, type, user_uid, uuid, sub);

    res.send({
        chat: chat_file
    });
});

app.post('/api/downloadTwitchChatByVODID', optionalJwt, requireAuthenticated, async (req, res) => {
    var id = req.body.id;
    var type = req.body.type;
    var vodId = req.body.vodId;
    var uuid = req.body.uuid;
    var sub = req.body.sub;
    var user_uid = null;

    if (req.isAuthenticated()) {
        user_uid = req.user.uid;
        uuid = req.user.uid;
    }

    // check if file already exists. if so, send that instead
    const file_exists_check = await twitch_api.getTwitchChatByFileID(id, type, user_uid, uuid, sub);
    if (file_exists_check) {
        res.send({chat: file_exists_check});
        return;
    }

    const full_chat = await twitch_api.downloadTwitchChatByVODID(vodId, id, type, user_uid, sub);

    res.send({
        chat: full_chat
    });
});

// video sharing
app.post('/api/enableSharing', optionalJwt, requirePermission('sharing'), async (req, res) => {
    var uid = req.body.uid;
    var is_playlist = req.body.is_playlist;
    let success = false;
    // multi-user mode
    if (req.isAuthenticated()) {
        // if multi user mode, use this method instead
        success = await auth_api.changeSharingMode(req.user.uid, uid, is_playlist, true);
        res.send({success: success});
        return;
    }

    // single-user mode
    try {
        success = true;
        if (!is_playlist) {
            await db_api.updateRecord('files', {uid: uid}, {sharingEnabled: true})
        } else if (is_playlist) {
            await db_api.updateRecord(`playlists`, {id: uid}, {sharingEnabled: true});
        } else if (false) {
            // TODO: Implement.
        } else {
            // error
            success = false;
        }

    } catch(err) {
        logger.error(err);
        success = false;
    }

    res.send({
        success: success
    });
});

app.post('/api/disableSharing', optionalJwt, requirePermission('sharing'), async function(req, res) {
    var type = req.body.type;
    var uid = req.body.uid;
    var is_playlist = req.body.is_playlist;
    let success = null;

    // Was unscoped in exactly the way enableSharing was, and is fixed the same way: the
    // owner check lives in changeSharingMode so both directions go through it.
    if (req.isAuthenticated()) {
        success = await auth_api.changeSharingMode(req.user.uid, uid, is_playlist, false);
        res.send({success: success});
        return;
    }

    try {
        success = true;
        if (!is_playlist && type !== 'subscription') {
            await db_api.updateRecord('files', {uid: uid}, {sharingEnabled: false})
        } else if (is_playlist) {
            await db_api.updateRecord(`playlists`, {id: uid}, {sharingEnabled: false});
        } else {
            // error
            success = false;
        }

    } catch(err) {
        success = false;
    }

    res.send({
        success: success
    });
});

/*************************************************
 * Unauthenticated by necessity: the player calls it
 * for a shared video, and a share link carries no
 * session. That is not a reason to accept any uid
 * that is named, though.
 *
 * An authenticated caller writes to their own
 * records. Anybody else has to demonstrate the same
 * capability a share link does -- the file is
 * shared, or it belongs to a shared playlist --
 * rather than merely knowing an owner uid and a
 * file uid, both of which appear in ordinary URLs.
 ************************************************/
app.post('/api/incrementViewCount', resolveJwtIfPresent, async (req, res) => {
    const file_uid = req.body.file_uid;
    const sub_id = req.body.sub_id;
    const playlist_id = req.body.playlist_id;
    const multi_user_mode = !!config_api.getConfigItem('ytdl_multi_user_mode');
    const authenticated_uid = req.isAuthenticated() && req.user ? req.user.uid : null;

    let file_obj = null;
    if (authenticated_uid || !multi_user_mode) {
        file_obj = await files_api.getVideo(file_uid, authenticated_uid, sub_id);
    } else {
        const uuid = req.body.uuid;
        if (!uuid) {
            res.sendStatus(401);
            return;
        }

        if (playlist_id) {
            const playlist = await files_api.getPlaylist(playlist_id, uuid, true);
            const playlist_uids = playlist && Array.isArray(playlist['uids']) ? playlist['uids'] : [];
            if (playlist_uids.includes(file_uid)) file_obj = await files_api.getVideo(file_uid, uuid, sub_id);
        } else {
            // Requires sharingEnabled, which is what a share link actually proves.
            file_obj = await auth_api.getUserVideo(uuid, file_uid, true);
        }

        if (!file_obj) {
            res.sendStatus(401);
            return;
        }
    }

    if (!file_obj) {
        // Used to fall through and write anyway, which incremented a counter on a record
        // the caller could not even read.
        res.sendStatus(404);
        return;
    }

    const current_view_count = file_obj['local_view_count'] ? file_obj['local_view_count'] : 0;
    const new_view_count = current_view_count + 1;

    await db_api.setVideoProperty(file_uid, {local_view_count: new_view_count}, file_obj['user_uid']);

    res.send({
        success: true
    });
});

// categories

app.post('/api/getAllCategories', optionalJwt, requireAuthenticated, async (req, res) => {
    const categories = await db_api.getRecords('categories');
    res.send({categories: categories});
});

app.post('/api/createCategory', optionalJwt, requirePermission('settings'), async (req, res) => {
    const name = req.body.name;
    const new_category = {
        name: name,
        uid: uuid(),
        rules: [],
        show_as_filter: false,
        custom_output: ''
    };

    await db_api.insertRecordIntoTable('categories', new_category);

    res.send({
        new_category: new_category,
        success: !!new_category
    });
});

app.post('/api/createDefaultCategories', optionalJwt, requirePermission('settings'), async (req, res) => {
    const existing_categories = await db_api.getRecords('categories');
    if (existing_categories && existing_categories.length > 0) {
        res.send({
            success: false,
            categories: existing_categories,
            error: 'Default categories can only be added when no categories exist.'
        });
        return;
    }

    const categories = await categories_api.createDefaultCategories();
    res.send({
        success: true,
        categories: categories
    });
});

app.post('/api/deleteCategory', optionalJwt, requirePermission('settings'), async (req, res) => {
    const category_uid = req.body.category_uid;

    await db_api.removeRecord('categories', {uid: category_uid});

    res.send({
        success: true
    });
});

app.post('/api/updateCategory', optionalJwt, requirePermission('settings'), async (req, res) => {
    const category = req.body.category;
    await db_api.updateRecord('categories', {uid: category.uid}, category)
    res.send({success: true});
});

app.post('/api/updateCategories', optionalJwt, requirePermission('settings'), async (req, res) => {
    const categories = req.body.categories;
    await db_api.removeAllRecords('categories');
    await db_api.insertRecordsIntoTable('categories', categories);
    res.send({success: true});
});

// subscriptions

app.post('/api/subscribe', optionalJwt, requirePermission('subscriptions'), async (req, res) => {
    let name = req.body.name;
    let url = req.body.url;
    let maxQuality = req.body.maxQuality;
    let timerange = req.body.timerange;
    let audioOnly = req.body.audioOnly;
    let customArgs = req.body.customArgs;
    let customOutput = req.body.customFileOutput;
    let useSubfolder = req.body.useSubfolder;
    let user_uid = req.isAuthenticated() ? req.user.uid : null;
    const new_sub = {
                        name: name,
                        url: url,
                        maxQuality: maxQuality,
                        id: uuid(),
                        user_uid: user_uid,
                        type: audioOnly ? 'audio' : 'video',
                        use_subfolder: useSubfolder !== false
                    };

    // adds timerange if it exists, otherwise all videos will be downloaded
    if (timerange) {
        new_sub.timerange = timerange;
    }

    if (customArgs && customArgs !== '') {
        new_sub.custom_args = customArgs;
    }

    if (customOutput && customOutput !== '') {
        new_sub.custom_output = customOutput;
    }

    const refusal = await refuseUnsafeDownloadOptions(req, {customArgs: customArgs, customOutput: customOutput}, url);
    if (refusal) {
        res.status(refusal.status).send({success: false, error: refusal.error});
        return;
    }

    const result_obj = await subscriptions_api.subscribe(new_sub, user_uid);

    if (result_obj.success) {
        res.send({
            new_sub: new_sub
        });
    } else {
        res.send({
            new_sub: null,
            error: result_obj.error
        })
    }
});

app.post('/api/unsubscribe', optionalJwt, requirePermission('subscriptions'), async (req, res) => {
    let deleteMode = req.body.deleteMode
    let sub_id = req.body.sub_id;
    let user_uid = req.isAuthenticated() ? req.user.uid : null;

    let result_obj = await subscriptions_api.unsubscribe(sub_id, deleteMode, user_uid);
    if (result_obj.success) {
        res.send({
            success: result_obj.success
        });
    } else {
        res.send({
            success: false,
            error: result_obj.error
        });
    }
});

app.post('/api/deleteSubscriptionFile', optionalJwt, requirePermission('subscriptions'), async (req, res) => {
    let deleteForever = req.body.deleteForever;
    let file_uid = req.body.file_uid;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;

    let success = await files_api.deleteFile(file_uid, deleteForever, user_uid);

    if (success) {
        res.send({
            success: success
        });
    } else {
        res.sendStatus(500);
    }

});

app.post('/api/getSubscription', optionalJwt, requirePermission('subscriptions'), async (req, res) => {
    let subID = req.body.id;
    let subName = req.body.name; // if included, subID is optional
    const include_videos = req.body.include_videos !== false;
    let user_uid = req.isAuthenticated() ? req.user.uid : null;

    // get sub from db
    let subscription = null;
    if (subID) {
        subscription = await subscriptions_api.getSubscription(subID, user_uid)
    } else if (subName) {
        subscription = await subscriptions_api.getSubscriptionByName(subName, user_uid)
    }

    if (!subscription) {
        // failed to get subscription from db, send 400 error
        res.sendStatus(400);
        return;
    }

    subscription = JSON.parse(JSON.stringify(subscription));
    if (!include_videos) delete subscription['videos'];

    // get sub videos
    if (subscription.name) {
        const sub_files_filter = {sub_id: subscription.id, ...getScopedFilterByUser(user_uid)};
        const file_count = await db_api.getRecords('files', sub_files_filter, true);
        subscription['file_count'] = file_count;

        if (include_videos) {
            var parsed_files = files_api.attachFileChaptersCollection(await db_api.getRecords('files', sub_files_filter)); // subscription.videos;
            subscription['videos'] = parsed_files;
            // loop through files for extra processing
            for (let i = 0; i < parsed_files.length; i++) {
                const file = parsed_files[i];
                // check if chat exists for twitch videos
                if (file && file['url'].includes('twitch.tv')) file['chat_exists'] = fs.existsSync(file['path'].substring(0, file['path'].length - 4) + '.twitch_chat.json');
            }

            res.send({
                subscription: subscription,
                files: parsed_files
            });
            return;
        }

        res.send({
            subscription: subscription,
            files: []
        });
    } else {
        res.sendStatus(500);
    }
});

app.post('/api/downloadVideosForSubscription', optionalJwt, requirePermission('subscriptions'), async (req, res) => {
    const subID = req.body.subID;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;

    const sub = await subscriptions_api.getSubscription(subID, user_uid);
    if (!sub) {
        res.send({success: false});
        return;
    }
    subscriptions_api.getVideosForSub(sub.id);
    res.send({
        success: true
    });
});

app.post('/api/updateSubscription', optionalJwt, requirePermission('subscriptions'), async (req, res) => {
    const updated_sub = req.body.subscription;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;

    const refusal = await refuseUnsafeDownloadOptions(req, {
        customArgs: updated_sub && updated_sub['custom_args'],
        customOutput: updated_sub && updated_sub['custom_output']
    });
    if (refusal) {
        res.status(refusal.status).send({success: false, error: refusal.error});
        return;
    }

    const success = await subscriptions_api.updateSubscription(updated_sub, user_uid);
    res.send({
        success: success
    });
});

app.post('/api/checkSubscription', optionalJwt, requirePermission('subscriptions'), async (req, res) => {
    let sub_id = req.body.sub_id;
    let user_uid = req.isAuthenticated() ? req.user.uid : null;

    const success = await subscriptions_api.getVideosForSub(sub_id, user_uid);
    res.send({
        success: success
    });
});

app.post('/api/redownloadSubscription', optionalJwt, requirePermission('subscriptions'), async (req, res) => {
    let sub_id = req.body.sub_id;
    let user_uid = req.isAuthenticated() ? req.user.uid : null;

    const result = await subscriptions_api.redownloadSubscription(sub_id, user_uid);
    res.send(result);
});

app.post('/api/cancelCheckSubscription', optionalJwt, requirePermission('subscriptions'), async (req, res) => {
    let sub_id = req.body.sub_id;
    let user_uid = req.isAuthenticated() ? req.user.uid : null;

    const success = await subscriptions_api.cancelCheckSubscription(sub_id, user_uid);
    res.send({
        success: success
    });
});

app.post('/api/cancelSubscriptionCheck', optionalJwt, requirePermission('subscriptions'), async (req, res) => {
    let sub_id = req.body.sub_id;
    let user_uid = req.isAuthenticated() ? req.user.uid : null;

    const success = await subscriptions_api.getVideosForSub(sub_id, user_uid);
    res.send({
        success: success
    });
});

app.post('/api/getSubscriptions', optionalJwt, requirePermission('subscriptions'), async (req, res) => {
    let user_uid = req.isAuthenticated() ? req.user.uid : null;

    // get subs from api
    let subscriptions = await subscriptions_api.getSubscriptions(user_uid);

    res.send({
        subscriptions: subscriptions
    });
});

app.post('/api/createPlaylist', optionalJwt, requireAuthenticated, async (req, res) => {
    let playlistName = req.body.playlistName;
    let uids = req.body.uids;

    const new_playlist = await files_api.createPlaylist(playlistName, uids, req.isAuthenticated() ? req.user.uid : null);

    res.send({
        new_playlist: new_playlist,
        success: !!new_playlist // always going to be true
    })
});

app.post('/api/getPlaylist', optionalJwt, requireAuthenticatedOrShared, async (req, res) => {
    let playlist_id = req.body.playlist_id;
    let uuid = req.body.uuid ? req.body.uuid : (req.user && req.user.uid ? req.user.uid : null);
    let include_file_metadata = req.body.include_file_metadata;
    if (req.user && req.user.uid) uuid = req.user.uid;

    const playlist = await files_api.getPlaylist(playlist_id, uuid);
    const file_objs = [];

    if (playlist && include_file_metadata) {
        file_objs.push(...files_api.attachFileChaptersCollection(await files_api.getVideosByUIDs(playlist['uids'], uuid)));
        // TODO: remove file from playlist if could not be found
    }

    res.send({
        playlist: playlist,
        file_objs: file_objs,
        success: !!playlist
    });
});

app.post('/api/getPlaylists', optionalJwt, requireAuthenticated, async (req, res) => {
    const uuid = req.isAuthenticated() ? req.user.uid : null;
    const include_categories = req.body.include_categories;
    const filter_obj = getScopedFilterByUser(uuid);

    let playlists = await db_api.getRecords('playlists', filter_obj);
    if (include_categories) {
        const categories = await categories_api.getCategoriesAsPlaylists(uuid);
        if (categories) {
            playlists = playlists.concat(categories);
        }
    }

    res.send({
        playlists: playlists
    });
});

app.post('/api/addFileToPlaylist', optionalJwt, requireAuthenticated, async (req, res) => {
    let playlist_id = req.body.playlist_id;
    let file_uid = req.body.file_uid;
    
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const playlist = await files_api.getPlaylist(playlist_id, user_uid);
    if (!playlist) {
        res.send({
            success: false
        });
        return;
    }
    const file_obj = await files_api.getVideo(file_uid, user_uid);
    if (!file_obj) {
        res.send({
            success: false
        });
        return;
    }

    playlist.uids.push(file_uid);

    let success = await files_api.updatePlaylist(playlist, user_uid);
    res.send({
        success: success
    });
});

app.post('/api/updatePlaylist', optionalJwt, requireAuthenticated, async (req, res) => {
    let playlist = req.body.playlist;
    let success = await files_api.updatePlaylist(playlist, req.user && req.user.uid);
    res.send({
        success: success
    });
});

app.post('/api/deletePlaylist', optionalJwt, requireAuthenticated, async (req, res) => {
    let playlistID = req.body.playlist_id;
    const delete_files = req.body.delete_files === true;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const playlist_filter = {id: playlistID, ...getScopedFilterByUser(user_uid)};

    const playlist = await db_api.getRecord('playlists', playlist_filter);
    if (!playlist) {
        res.send({
            success: false,
            playlist_removed: false,
            deleted_file_count: 0,
            failed_file_count: 0
        });
        return;
    }

    let success = false;
    let playlist_removed = false;
    let deleted_file_count = 0;
    let failed_file_count = 0;
    try {
        // removes playlist from playlists
        playlist_removed = await db_api.removeRecord('playlists', playlist_filter);

        if (playlist_removed && delete_files) {
            const delete_results = await files_api.deleteFilesInBatches(playlist.uids || [], false, user_uid);
            deleted_file_count = delete_results.deleted_count;
            failed_file_count = delete_results.failed_count;
        }

        success = playlist_removed && failed_file_count === 0;
    } catch(e) {
        success = false;
    }

    res.send({
        success: success,
        playlist_removed: playlist_removed,
        deleted_file_count: deleted_file_count,
        failed_file_count: failed_file_count
    })
});

// deletes non-subscription files
app.post('/api/deleteFile', optionalJwt, requirePermission('filemanager'), async (req, res) => {
    const uid = req.body.uid;
    const blacklistMode = req.body.blacklistMode;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;

    let wasDeleted = false;
    wasDeleted = await files_api.deleteFile(uid, blacklistMode, user_uid);
    res.send(wasDeleted);
});

// creates a new file containing only the selected range of an existing file
app.post('/api/snipFile', optionalJwt, requirePermission('filemanager'), async (req, res) => {
    const uid = req.body.uid;
    const start = req.body.start;
    const end = req.body.end;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;

    if (!uid) {
        res.send({success: false, error: 'uid is required'});
        return;
    }

    pruneSnipJobs();

    if (countActiveSnipJobs() >= MAX_ACTIVE_SNIP_JOBS) {
        res.send({success: false, error: 'Too many snips are already running. Please wait for one to finish.'});
        return;
    }

    const job_uid = uuid();
    snipJobs[job_uid] = {
        uid: job_uid,
        file_uid: uid,
        user_uid: user_uid,
        status: 'snipping',
        percent: 0,
        started: Date.now(),
        finished: null,
        error: null,
        file: null
    };

    // Kick the work off without awaiting it so the request returns immediately with a
    // handle the client can poll.
    files_api.snipFile(uid, start, end, user_uid, (percent) => {
        if (snipJobs[job_uid]) snipJobs[job_uid]['percent'] = percent;
    }).then(result => {
        const job = snipJobs[job_uid];
        if (!job) return;
        job['status'] = result['success'] ? 'complete' : 'failed';
        job['percent'] = result['success'] ? 100 : job['percent'];
        job['error'] = result['error'] || null;
        job['file'] = result['file'] || null;
        job['finished'] = Date.now();
    }).catch(err => {
        logger.error(`Snip job ${job_uid} threw an unexpected error.`);
        logger.error(err);
        const job = snipJobs[job_uid];
        if (!job) return;
        job['status'] = 'failed';
        job['error'] = 'Snip failed unexpectedly';
        job['finished'] = Date.now();
    });

    res.send({success: true, job_uid: job_uid});
});

app.post('/api/getSnipStatus', optionalJwt, requirePermission('filemanager'), async (req, res) => {
    const job_uid = req.body.job_uid;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const job = typeof job_uid === 'string' ? snipJobs[job_uid] : null;

    if (!job) {
        res.send({success: false, error: 'Snip job could not be found'});
        return;
    }

    // Job handles are unguessable, but scoping to the requesting user keeps one user's
    // snip from being observable by another in multi-user mode.
    if (job['user_uid'] && job['user_uid'] !== user_uid) {
        res.send({success: false, error: 'Snip job could not be found'});
        return;
    }

    res.send({
        success: true,
        status: job['status'],
        percent: job['percent'],
        error: job['error'],
        file: job['file']
    });
});

app.post('/api/deleteAllFiles', optionalJwt, requirePermission('filemanager'), async (req, res) => {
    const blacklistMode = false;
    const uuid = req.isAuthenticated() ? req.user.uid : null;

    let files = null;
    let text_search = req.body.text_search;
    let file_type_filter = req.body.file_type_filter;

    const filter_obj = getScopedFilterByUser(uuid);
    const regex = true;
    if (text_search) {
        if (regex) {
            filter_obj['title'] = {$regex: `.*${text_search}.*`, $options: 'i'};
        } else {
            filter_obj['$text'] = { $search: utils.createEdgeNGrams(text_search) };
        }
    }

    if (file_type_filter === 'audio_only') filter_obj['isAudio'] = true;
    else if (file_type_filter === 'video_only') filter_obj['isAudio'] = false;
    
    files = await db_api.getRecords('files', filter_obj);

    let file_count = await db_api.getRecords('files', filter_obj, true);
    let delete_count = 0;

    for (let i = 0; i < files.length; i++) {    
        let wasDeleted = false;
        wasDeleted = await files_api.deleteFile(files[i].uid, blacklistMode, uuid);
        if (wasDeleted) {
            delete_count++;
        }
    }

    res.send({
        file_count: file_count,
        delete_count: delete_count
    });
});

app.post('/api/downloadFileFromServer', optionalJwt, requireAuthenticatedOrShared, async (req, res) => {
    let uid = req.body.uid;
    let uuid = req.body.uuid;
    let playlist_id = req.body.playlist_id;
    let sub_id = req.body.sub_id;

    let file_path_to_download = null;
    // The container's own name is now only ever a display name -- the archive on disk is
    // named by the server -- so it is carried separately and used for the header.
    let download_display_name = null;

    if (req.user && req.user.uid) uuid = req.user.uid;

    let zip_file_generated = false;
    if (playlist_id) {
        zip_file_generated = true;
        const playlist_files_to_download = [];
        const playlist = await files_api.getPlaylist(playlist_id, uuid);
        if (!playlist) {
            res.sendStatus(404);
            return;
        }
        for (let i = 0; i < playlist['uids'].length; i++) {
            const playlist_file_uid = playlist['uids'][i];
            const file_obj = await files_api.getVideo(playlist_file_uid, uuid);
            if (file_obj) playlist_files_to_download.push(file_obj);
        }

        // generate zip
        download_display_name = playlist['name'];
        file_path_to_download = await utils.createContainerZipFile(playlist['name'], playlist_files_to_download, uuid);
    } else if (sub_id && !uid) {
        zip_file_generated = true;
        const sub = await subscriptions_api.getSubscription(sub_id, req.isAuthenticated() ? req.user.uid : null);
        if (!sub) {
            res.sendStatus(404);
            return;
        }
        const sub_files_to_download = await db_api.getRecords('files', {sub_id: sub_id, ...getScopedFilterByUser(req.isAuthenticated() ? req.user.uid : null)});

        // generate zip
        download_display_name = sub['name'];
        file_path_to_download = await utils.createContainerZipFile(sub['name'], sub_files_to_download,
            req.isAuthenticated() ? req.user.uid : null);
    } else {
        const file_obj = await files_api.getVideo(uid, uuid, sub_id)
        if (!file_obj) {
            res.sendStatus(404);
            return;
        }
        file_path_to_download = file_obj.path;
        // Same reasoning as /api/stream: this is the point where a stored string becomes
        // a filesystem read. The generated-zip branches above are exempt because their
        // paths are built here rather than read out of a record.
        if (!utils.isServableMediaFile(file_path_to_download, file_obj['user_uid'])) {
            logger.error(`Refusing to send ${uid}: its path is not a regular file inside its owner's media folder.`);
            res.sendStatus(404);
            return;
        }
    }
    if (!file_path_to_download) {
        // The archive could not be built -- every record was refused, or the write failed.
        logger.error('Failed to build an archive to send.');
        res.sendStatus(500);
        return;
    }

    if (!path.isAbsolute(file_path_to_download)) file_path_to_download = path.join(__dirname, file_path_to_download);

    const afterSend = function (err) {
        if (err) {
          logger.error(err);
        }
        if (zip_file_generated) {
          try {
            // delete generated zip file, whether or not the send succeeded
            fs.unlinkSync(file_path_to_download);
          } catch(e) {
            logger.error(`Failed to remove file after sending to client: ${file_path_to_download}`);
          }
        }
    };

    if (download_display_name) {
        // res.download builds the Content-Disposition header itself, which is where the
        // caller's chosen name belongs -- it names the file in their browser and never
        // touches a path on this machine.
        res.download(file_path_to_download, `${download_display_name}.zip`, afterSend);
    } else {
        res.sendFile(file_path_to_download, afterSend);
    }
});

app.post('/api/getArchives', optionalJwt, requirePermission('filemanager'), async (req, res) => {
    const uuid = req.isAuthenticated() ? req.user.uid : null;
    const sub_id = req.body.sub_id;
    const filter_obj = {sub_id: sub_id, ...getScopedFilterByUser(uuid)};
    const type = req.body.type;

    // we do this for file types because if type is null, that means get files of all types
    if (type) filter_obj['type'] = type;

    const archives = await db_api.getRecords('archives', filter_obj);

    res.send({
        archives: archives
    });
});

app.post('/api/downloadArchive', optionalJwt, requirePermission('filemanager'), async (req, res) => {
    const uuid = req.isAuthenticated() ? req.user.uid : null;
    const sub_id = req.body.sub_id; 
    const type = req.body.type;

    const archive_text = await archive_api.generateArchive(type, uuid, sub_id);

    if (archive_text !== null && archive_text !== undefined) {
        res.setHeader('Content-type', "application/octet-stream");
        res.setHeader('Content-disposition', 'attachment; filename=archive.txt');
        res.send(archive_text);
    } else {
        res.sendStatus(400);
    }

});

app.post('/api/importArchive', optionalJwt, requirePermission('filemanager'), async (req, res) => {
    const uuid = req.isAuthenticated() ? req.user.uid : null;
    const archive = req.body.archive;
    const sub_id = req.body.sub_id; 
    const type = req.body.type;

    const archive_text = Buffer.from(archive.split(',')[1], 'base64').toString();

    const imported_count = await archive_api.importArchiveFile(archive_text, type, uuid, sub_id);

    res.send({
        success: !!imported_count,
        imported_count: imported_count
    });
});

app.post('/api/deleteArchiveItems', optionalJwt, requirePermission('filemanager'), async (req, res) => {
    const uuid = req.isAuthenticated() ? req.user.uid : null;
    const archives = req.body.archives;

    let success = true;
    for (const archive of archives) {
        success &= await archive_api.removeFromArchive(archive['extractor'], archive['id'], archive['type'], uuid, archive['sub_id']);
    }

    res.send({
        success: success
    });
});

// The limit matters as much as the guard: multer writes the body to disk while it parses,
// so without one an upload is a way to fill the volume before any handler runs.
const MAX_COOKIE_UPLOAD_BYTES = 2 * 1024 * 1024;
var upload_multer = multer({
    dest: __dirname + '/appdata/',
    limits: {fileSize: MAX_COOKIE_UPLOAD_BYTES, files: 1}
});

// cookies.txt is one file shared by every download on the server, so replacing it is an
// administrator's action. The guards run before multer, so an unauthenticated request is
// refused before its body is written anywhere.
app.post('/api/uploadCookies', optionalJwt, requireAdmin, upload_multer.single('cookies'), async (req, res) => {
    if (!req.file || !req.file.path) {
        res.sendStatus(400);
        return;
    }

    const new_path = path.join(__dirname, 'appdata', 'cookies.txt');
    const uploadBasePath = path.join(__dirname, 'appdata');
    const resolvedUploadedPath = path.resolve(req.file.path);
    const relativeUploadedPath = path.relative(uploadBasePath, resolvedUploadedPath);
    if (relativeUploadedPath.startsWith('..') || path.isAbsolute(relativeUploadedPath)) {
        logger.error(`Refusing to move uploaded cookies file outside appdata: ${req.file.path}`);
        res.sendStatus(400);
        return;
    }

    if (await fs.pathExists(resolvedUploadedPath)) {
        await fs.rename(resolvedUploadedPath, new_path);
    } else {
        res.sendStatus(500);
        return;
    }

    if (await fs.pathExists(new_path)) {
        res.send({success: true});
    } else {
        res.sendStatus(500);
    }

});

function getCookiesFileSummary(cookies_text) {
    const lines = cookies_text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
    const cookie_lines = lines.filter(line => !line.startsWith('#') || line.startsWith('#HttpOnly_'));
    let invalid_entries = 0;

    for (const line of cookie_lines) {
        // Netscape cookie format should contain at least 7 tab-separated values.
        if (line.split('\t').length < 7) invalid_entries++;
    }

    return {
        total_lines: lines.length,
        cookie_entries: cookie_lines.length,
        invalid_entries: invalid_entries
    };
}

function normalizeCookieTestError(err) {
    if (!err) return 'Unknown error.';

    let message = null;
    if (typeof err === 'string') {
        message = err;
    } else if (err.stderr) {
        message = err.stderr.toString();
    } else if (err.message) {
        message = err.message.toString();
    } else {
        message = JSON.stringify(err);
    }

    if (!message) return 'Unknown error.';
    const max_error_length = 1200;
    return message.length > max_error_length ? message.substring(0, max_error_length) + '...' : message;
}

app.post('/api/testCookies', testCookiesRateLimiter, optionalJwt, requireAdmin, async (req, res) => {
    const logs = [];
    const use_cookies_enabled = config_api.getConfigItem('ytdl_use_cookies');
    const downloader = config_api.getConfigItem('ytdl_default_downloader');
    const test_url = req.body && req.body.url ? req.body.url.trim() : '';
    const cookie_path = path.join(__dirname, 'appdata', 'cookies.txt');
    const relative_cookie_path = path.join('appdata', 'cookies.txt');

    logs.push('Starting cookie test.');
    logs.push(`Downloader: ${downloader}`);
    logs.push(`Use Cookies setting is ${use_cookies_enabled ? 'enabled' : 'disabled'}.`);

    if (!test_url) {
        logs.push('No URL was provided for cookie testing.');
        res.status(400).send({
            success: false,
            error: 'Missing URL to test.',
            logs: logs,
            use_cookies_enabled: use_cookies_enabled,
            cookie_file_found: false
        });
        return;
    }

    let parsed_test_url = null;
    try {
        parsed_test_url = new URL(test_url);
    } catch (err) {
        parsed_test_url = null;
    }

    if (!parsed_test_url || (parsed_test_url.protocol !== 'http:' && parsed_test_url.protocol !== 'https:')) {
        logs.push(`Invalid test URL provided: ${test_url}`);
        res.status(400).send({
            success: false,
            error: 'Invalid URL. Only http/https URLs are allowed.',
            logs: logs,
            use_cookies_enabled: use_cookies_enabled,
            cookie_file_found: false
        });
        return;
    }

    if (!(await fs.pathExists(cookie_path))) {
        logs.push(`Cookie file was not found at ${cookie_path}.`);
        res.send({
            success: false,
            error: 'Cookies file not found.',
            logs: logs,
            use_cookies_enabled: use_cookies_enabled,
            cookie_file_found: false
        });
        return;
    }

    const cookie_stats = await fs.stat(cookie_path);
    logs.push(`Cookie file found (${cookie_stats.size} bytes).`);

    if (cookie_stats.size === 0) {
        logs.push('Cookie file is empty.');
        res.send({
            success: false,
            error: 'Cookies file is empty.',
            logs: logs,
            use_cookies_enabled: use_cookies_enabled,
            cookie_file_found: true,
            cookie_file_size: cookie_stats.size
        });
        return;
    }

    const cookies_text = await fs.readFile(cookie_path, 'utf8');
    const cookie_summary = getCookiesFileSummary(cookies_text);

    logs.push(`Detected ${cookie_summary.cookie_entries} cookie entries from ${cookie_summary.total_lines} non-empty lines.`);
    if (cookie_summary.invalid_entries > 0) {
        logs.push(`Detected ${cookie_summary.invalid_entries} entries that may not be valid Netscape cookie rows.`);
    }

    const args = [
        '--skip-download',
        '--no-warnings',
        '--no-playlist',
        '--dump-single-json',
        '--cookies',
        relative_cookie_path
    ];
    logs.push(`Testing URL: ${test_url}`);
    logs.push(`Executing test command with cookies at ${relative_cookie_path}.`);

    let run_response = null;
    try {
        run_response = await youtubedl_api.runYoutubeDL(test_url, args);
    } catch (err) {
        const error_message = normalizeCookieTestError(err);
        logs.push(`Failed to start downloader process. ${error_message}`);
        res.status(500).send({
            success: false,
            error: error_message,
            logs: logs,
            use_cookies_enabled: use_cookies_enabled,
            cookie_file_found: true,
            cookie_summary: cookie_summary
        });
        return;
    }

    if (!run_response || !run_response.callback) {
        logs.push('Downloader process did not initialize correctly.');
        res.status(500).send({
            success: false,
            error: 'Failed to initialize downloader process.',
            logs: logs,
            use_cookies_enabled: use_cookies_enabled,
            cookie_file_found: true,
            cookie_summary: cookie_summary
        });
        return;
    }

    const {parsed_output, err} = await run_response.callback;
    if (parsed_output && parsed_output.length > 0) {
        const info_obj = parsed_output[0];
        const title = info_obj && info_obj.title ? info_obj.title : null;
        const extractor = info_obj && info_obj.extractor ? info_obj.extractor : null;

        if (title) logs.push(`Metadata fetch succeeded: "${title}".`);
        else logs.push('Metadata fetch succeeded.');

        if (extractor) logs.push(`Extractor used: ${extractor}.`);

        res.send({
            success: true,
            logs: logs,
            use_cookies_enabled: use_cookies_enabled,
            cookie_file_found: true,
            cookie_file_size: cookie_stats.size,
            cookie_summary: cookie_summary,
            result: {
                title: title,
                extractor: extractor
            }
        });
        return;
    }

    const error_message = normalizeCookieTestError(err);
    logs.push('Metadata fetch failed while using cookies.');
    logs.push(error_message);
    res.send({
        success: false,
        error: error_message,
        logs: logs,
        use_cookies_enabled: use_cookies_enabled,
        cookie_file_found: true,
        cookie_file_size: cookie_stats.size,
        cookie_summary: cookie_summary
    });
});

// Updater API calls

app.get('/api/updaterStatus', optionalJwt, requireAdmin, async (req, res) => {
    let status = updaterStatus;

    if (status) {
        res.send(updaterStatus);
    } else {
        res.sendStatus(404);
    }

});

app.post('/api/updateServer', optionalJwt, requireAdmin, async (req, res) => {
    let tag = req.body.tag;

    updateServer(tag);

    res.send({
        success: true
    });

});

// API Key API calls

app.post('/api/generateNewAPIKey', optionalJwt, requireAdmin, function (req, res) {
    const new_api_key = uuid();
    config_api.setConfigItem('ytdl_api_key', new_api_key);
    res.send({new_api_key: new_api_key});
});

// Streaming API calls

app.get('/api/stream', optionalJwt, requireAuthenticatedOrShared, async (req, res) => {
    const type = req.query.type;
    const uuid = req.user ? req.user.uid : (req.query.uuid ? req.query.uuid : null);
    const sub_id = req.query.sub_id;
    var head;
    const requestedUID = typeof req.query.uid === 'string' ? req.query.uid : '';
    const uid = requestedUID ? decodeURIComponent(requestedUID) : '';

    if (!uid) {
        res.status(400).type('text/plain').send('Missing media uid');
        return;
    }

    let file_path = null;
    let file_obj = null;

    const multiUserMode = config_api.getConfigItem('ytdl_multi_user_mode');
    if (!multiUserMode || req.isAuthenticated() || req.can_watch) {
        file_obj = await files_api.getVideo(uid, uuid, sub_id);
        if (file_obj) file_path = file_obj['path'];
        else file_path = null;
    }
    if (!file_path || !file_obj) {
        logger.warn(`Stream lookup failed for UID ${uid}.`);
        res.status(404).type('text/plain').send('Media file not found');
        return;
    }
    // The path comes out of the database, so it is checked here as well as where it is
    // written. This route turns a stored string into a filesystem read, which makes it
    // the last place the check is still cheap.
    if (!utils.isServableMediaFile(file_path, file_obj['user_uid'])) {
        logger.error(`Refusing to stream ${uid}: its path is not a regular file inside its owner's media folder.`);
        res.status(404).type('text/plain').send('Media file not found');
        return;
    }
    if (!fs.existsSync(file_path)) {
        logger.error(`File ${file_path} could not be found! UID: ${uid}, ID: ${file_obj && file_obj.id}`);
        res.status(404).type('text/plain').send('Media file not found');
        return;
    }
    const mimetype = mime.lookup(file_path) || (type === 'audio' ? 'audio/mpeg' : 'video/mp4');
    const stat = fs.statSync(file_path);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-")
        const start = parseInt(parts[0], 10)
        const end = parts[1]
        ? parseInt(parts[1], 10)
        : fileSize-1
        const chunksize = (end-start)+1
        const file = fs.createReadStream(file_path, {start, end})
        if (config_api.descriptors[uid]) config_api.descriptors[uid].push(file);
        else                            config_api.descriptors[uid] = [file];
        file.on('close', function() {
            let index = config_api.descriptors[uid].indexOf(file);
            config_api.descriptors[uid].splice(index, 1);
            logger.debug('Successfully closed stream and removed file reference.');
        });
        head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimetype,
        }
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        head = {
        'Content-Length': fileSize,
        'Content-Type': mimetype,
        }
        res.writeHead(200, head)
        fs.createReadStream(file_path).pipe(res)
    }
});

app.get('/api/streamSubtitle', optionalJwt, requireAuthenticatedOrShared, async (req, res) => {
    const uuid = req.user ? req.user.uid : (req.query.uuid ? req.query.uuid : null);
    const sub_id = req.query.sub_id;
    const requestedUID = typeof req.query.uid === 'string' ? req.query.uid : '';
    const uid = requestedUID ? decodeURIComponent(requestedUID) : '';
    const subtitle_track_index = Number.isInteger(Number(req.query.index)) && Number(req.query.index) >= 0
        ? Number(req.query.index)
        : 0;

    if (!uid) {
        res.status(400).type('text/plain').send('Missing media uid');
        return;
    }

    let file_obj = null;
    const multiUserMode = config_api.getConfigItem('ytdl_multi_user_mode');
    if (!multiUserMode || req.isAuthenticated() || req.can_watch) {
        file_obj = await files_api.getVideo(uid, uuid, sub_id);
    }
    if (!file_obj) {
        logger.warn(`Subtitle stream lookup failed for UID ${uid}.`);
        res.status(404).type('text/plain').send('Subtitle track not found');
        return;
    }

    const subtitle_sidecar_path = await files_api.ensureSubtitleSidecarForFile(file_obj, subtitle_track_index);
    if (!subtitle_sidecar_path) {
        res.status(404).type('text/plain').send('Subtitle track not found');
        return;
    }

    const resolved_subtitle_path = path.isAbsolute(subtitle_sidecar_path)
        ? subtitle_sidecar_path
        : path.join(__dirname, subtitle_sidecar_path);
    if (!fs.existsSync(resolved_subtitle_path)) {
        res.status(404).type('text/plain').send('Subtitle track not found');
        return;
    }

    res.type('text/vtt; charset=utf-8');
    res.sendFile(resolved_subtitle_path);
});

app.get('/api/thumbnail/:uid', optionalJwt, requireAuthenticated, async (req, res) => {
    /*************************************************
     * Identifies the thumbnail by the uid of the file
     * it belongs to, never by a path off the URL.
     * files_api.getThumbnailPathForUser carries the
     * reasoning and the checks.
     *
     * One answer for "no such file", "not yours" and
     * "the record points somewhere it should not", so
     * the endpoint cannot be used to find out which
     * uids exist.
     ************************************************/
    const caller_uid = req.isAuthenticated() && req.user ? req.user.uid : null;
    const thumbnail_path = await files_api.getThumbnailPathForUser(req.params.uid, caller_uid);
    if (!thumbnail_path) {
        res.sendStatus(404);
        return;
    }

    res.sendFile(thumbnail_path, (err) => {
        if (!err) return;
        if (res.headersSent) return;
        if (err.statusCode === 404) {
            res.sendStatus(404);
            return;
        }
        logger.error(err);
        res.sendStatus(500);
    });
});

// Downloads management

const DOWNLOADS_DEFAULT_PAGE_SIZE = 20;
const DOWNLOADS_MAX_PAGE_SIZE = 100;
const DOWNLOADS_MAX_UID_FILTER_SIZE = 100;
const DOWNLOADS_MAX_ACTIVE_RESULTS = 100;
const DOWNLOAD_LIST_PROJECTION_FIELDS = Object.freeze([
    'uid',
    'ui_uid',
    'running',
    'finished',
    'paused',
    'cancelled',
    'finished_step',
    'url',
    'type',
    'title',
    'step_index',
    'percent_complete',
    'timestamp_start',
    'error_type',
    'error_summary',
    'sub_id',
    'sub_name',
    'playlist_item_progress',
    'file_uids',
    'container.id',
    'container.uid',
    'duplicate_skip_only',
    'duplicate_skip_count',
    'options.playlistBatchId',
    'options.playlistChunkRange',
    'options.playlistChunkIndex',
    'options.playlistChunkCount',
    'options.playlistChunkTitle'
]);

function clampDownloadsInteger(value, fallback, minimum, maximum) {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed_value = Number(value);
    if (!Number.isFinite(parsed_value)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(parsed_value)));
}

function normalizeDownloadContainerForList(container = null) {
    if (!container || typeof container !== 'object') return null;
    if (container.uid) return {uid: container.uid};
    if (container.id) return {id: container.id, uids: []};
    return null;
}

function getDownloadErrorPlaceholder(error_type = null) {
    const normalized_error_type = typeof error_type === 'string'
        ? error_type.trim().slice(0, 100)
        : '';
    return normalized_error_type
        ? `Download failed (${normalized_error_type}). Detailed output is unavailable for this legacy queue entry.`
        : 'Download failed. Detailed output is unavailable for this legacy queue entry.';
}

async function attachDownloadListErrorState(downloads = [], scoped_filter = {}) {
    if (!Array.isArray(downloads) || downloads.length === 0) return downloads;

    const download_uids = downloads.map(download => download && download.uid).filter(Boolean);
    if (download_uids.length === 0) {
        return downloads.map(download => ({
            ...download,
            container: normalizeDownloadContainerForList(download.container),
            error: null,
            error_details_omitted: false
        }));
    }
    const errored_downloads = await db_api.getRecords(
        'download_queue',
        {...scoped_filter, uid: {$in: download_uids}, error: {$ne: null}},
        false,
        null,
        [0, download_uids.length],
        ['uid']
    );
    const errored_uids = new Set(errored_downloads.map(download => download.uid));

    return downloads.map(download => {
        const normalized_download = {
            ...download,
            container: normalizeDownloadContainerForList(download.container)
        };
        const has_error_summary = typeof download.error_summary === 'string' && download.error_summary.trim() !== '';
        if (errored_uids.has(download.uid) || has_error_summary) {
            normalized_download.error = has_error_summary
                ? download.error_summary
                : getDownloadErrorPlaceholder(download.error_type);
            normalized_download.error_details_omitted = true;
        } else {
            normalized_download.error = null;
            normalized_download.error_details_omitted = false;
        }
        return normalized_download;
    });
}

async function hasScopedDownload(download_uid, user_uid) {
    if (typeof download_uid !== 'string' || download_uid.trim() === '') return false;
    const downloads = await db_api.getRecords(
        'download_queue',
        {uid: download_uid, ...getScopedFilterByUser(user_uid)},
        false,
        null,
        [0, 1],
        ['uid']
    );
    return downloads.length > 0;
}

app.post('/api/downloads', optionalJwt, requirePermission('downloads_manager'), async (req, res) => {
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const uids = req.body.uids;
    const only_unfinished = req.body.only_unfinished === true;
    const filter_obj = getScopedFilterByUser(user_uid);

    if (uids !== null && uids !== undefined && !Array.isArray(uids)) {
        res.status(400).send({error: 'Download UIDs must be provided as an array.'});
        return;
    }

    if (Array.isArray(uids)) {
        if (uids.length === 0) {
            res.send({downloads: [], total_count: 0, page: 0, page_size: 0});
            return;
        }
        const normalized_uids = [...new Set(
            uids
                .filter(uid => typeof uid === 'string')
                .map(uid => uid.trim())
                .filter(uid => uid !== '')
        )];
        if (normalized_uids.length > DOWNLOADS_MAX_UID_FILTER_SIZE) {
            res.status(400).send({
                error: `A maximum of ${DOWNLOADS_MAX_UID_FILTER_SIZE} download UIDs may be requested at once.`
            });
            return;
        }

        if (normalized_uids.length === 0) {
            res.send({downloads: [], total_count: 0, page: 0, page_size: 0});
            return;
        }
        filter_obj['uid'] = {$in: normalized_uids};
        const downloads = await db_api.getRecords(
            'download_queue',
            filter_obj,
            false,
            {by: 'timestamp_start', order: -1},
            [0, normalized_uids.length],
            DOWNLOAD_LIST_PROJECTION_FIELDS
        );
        const projected_downloads = await attachDownloadListErrorState(downloads, getScopedFilterByUser(user_uid));
        res.send({
            downloads: projected_downloads,
            total_count: projected_downloads.length,
            page: 0,
            page_size: normalized_uids.length
        });
        return;
    }

    if (only_unfinished) {
        filter_obj['finished'] = false;
        const [downloads, total_count] = await Promise.all([
            db_api.getRecords(
                'download_queue',
                filter_obj,
                false,
                {by: 'timestamp_start', order: -1},
                [0, DOWNLOADS_MAX_ACTIVE_RESULTS],
                DOWNLOAD_LIST_PROJECTION_FIELDS
            ),
            db_api.getRecords('download_queue', filter_obj, true)
        ]);
        const projected_downloads = await attachDownloadListErrorState(downloads, getScopedFilterByUser(user_uid));
        res.send({
            downloads: projected_downloads,
            total_count: total_count,
            page: 0,
            page_size: DOWNLOADS_MAX_ACTIVE_RESULTS
        });
        return;
    }

    const page_size = clampDownloadsInteger(req.body.page_size, DOWNLOADS_DEFAULT_PAGE_SIZE, 1, DOWNLOADS_MAX_PAGE_SIZE);
    const requested_page = clampDownloadsInteger(req.body.page, 0, 0, Number.MAX_SAFE_INTEGER);
    const total_count = await db_api.getRecords('download_queue', filter_obj, true);
    const last_page = total_count > 0 ? Math.floor((total_count - 1) / page_size) : 0;
    const page = Math.min(requested_page, last_page);
    const range_start = page * page_size;
    const downloads = await db_api.getRecords(
        'download_queue',
        filter_obj,
        false,
        {by: 'timestamp_start', order: -1},
        [range_start, range_start + page_size],
        DOWNLOAD_LIST_PROJECTION_FIELDS
    );
    const projected_downloads = await attachDownloadListErrorState(downloads, getScopedFilterByUser(user_uid));

    res.send({
        downloads: projected_downloads,
        total_count: total_count,
        page: page,
        page_size: page_size
    });
});

app.post('/api/download', optionalJwt, requirePermission('downloads_manager'), async (req, res) => {
    const download_uid = req.body.download_uid;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const scoped_filter = getScopedFilterByUser(user_uid);
    const filter_obj = {uid: download_uid, ...scoped_filter};
    const downloads = await db_api.getRecords(
        'download_queue',
        filter_obj,
        false,
        null,
        [0, 1],
        DOWNLOAD_LIST_PROJECTION_FIELDS
    );
    const projected_downloads = await attachDownloadListErrorState(downloads, scoped_filter);
    const download = projected_downloads.length > 0 ? projected_downloads[0] : null;

    if (download) {
        res.send({download: download});
    } else {
        res.send({download: null});
    }
});

app.post('/api/clearDownloads', optionalJwt, requirePermission('downloads_manager'), async (req, res) => {
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const scoped_filter = getScopedFilterByUser(user_uid);
    const clear_finished = req.body.clear_finished;
    const clear_paused = req.body.clear_paused;
    const clear_errors = req.body.clear_errors;
    let success = true;
    if (clear_finished) success &= await db_api.removeAllRecords('download_queue', {finished: true, ...scoped_filter, error: null});
    if (clear_paused) {
        const paused_downloads = await db_api.getRecords(
            'download_queue',
            {paused: true, ...scoped_filter},
            false,
            null,
            null,
            ['uid']
        );
        for (const paused_download of paused_downloads) {
            success &= await downloader_api.clearDownload(paused_download['uid']);
        }
    }
    if (clear_errors) {
        const errored_downloads = await db_api.getRecords(
            'download_queue',
            {error: {$ne: null}, ...scoped_filter},
            false,
            null,
            null,
            ['uid']
        );
        for (const errored_download of errored_downloads) {
            success &= await downloader_api.clearDownload(errored_download['uid']);
        }
    }
    res.send({success: success});
});

app.post('/api/clearDownload', optionalJwt, requirePermission('downloads_manager'), async (req, res) => {
    const download_uid = req.body.download_uid;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    if (!(await hasScopedDownload(download_uid, user_uid))) {
        res.send({success: false});
        return;
    }
    const success = await downloader_api.clearDownload(download_uid);
    res.send({success: success});
});

app.post('/api/pauseDownload', optionalJwt, requirePermission('downloads_manager'), async (req, res) => {
    const download_uid = req.body.download_uid;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    if (!(await hasScopedDownload(download_uid, user_uid))) {
        res.send({success: false});
        return;
    }
    const success = await downloader_api.pauseDownload(download_uid);
    res.send({success: success});
});

app.post('/api/pauseAllDownloads', optionalJwt, requirePermission('downloads_manager'), async (req, res) => {
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    let success = true;
    const all_running_downloads = await db_api.getRecords(
        'download_queue',
        {paused: false, finished: false, ...getScopedFilterByUser(user_uid)},
        false,
        null,
        null,
        ['uid']
    );
    for (let i = 0; i < all_running_downloads.length; i++) {
        success &= await downloader_api.pauseDownload(all_running_downloads[i]['uid']);
    }
    res.send({success: success});
});

app.post('/api/resumeDownload', optionalJwt, requirePermission('downloads_manager'), async (req, res) => {
    const download_uid = req.body.download_uid;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    if (!(await hasScopedDownload(download_uid, user_uid))) {
        res.send({success: false});
        return;
    }
    const success = await downloader_api.resumeDownload(download_uid);
    res.send({success: success});
});

app.post('/api/resumeAllDownloads', optionalJwt, requirePermission('downloads_manager'), async (req, res) => {
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    let success = true;
    const all_paused_downloads = await db_api.getRecords(
        'download_queue',
        {paused: true, ...getScopedFilterByUser(user_uid), error: null},
        false,
        null,
        null,
        ['uid']
    );
    for (let i = 0; i < all_paused_downloads.length; i++) {
        success &= await downloader_api.resumeDownload(all_paused_downloads[i]['uid']);
    }
    res.send({success: success});
});

app.post('/api/restartDownload', optionalJwt, requirePermission('downloads_manager'), async (req, res) => {
    const download_uid = req.body.download_uid;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    if (!(await hasScopedDownload(download_uid, user_uid))) {
        res.send({success: false, new_download_uid: null});
        return;
    }
    const new_download = await downloader_api.restartDownload(download_uid);
    res.send({success: !!new_download, new_download_uid: new_download ? new_download['uid'] : null});
});

app.post('/api/cancelDownload', optionalJwt, requirePermission('downloads_manager'), async (req, res) => {
    const download_uid = req.body.download_uid;
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    if (!(await hasScopedDownload(download_uid, user_uid))) {
        res.send({success: false});
        return;
    }
    const success = await downloader_api.cancelDownload(download_uid);
    res.send({success: success});
});

// tasks

app.post('/api/getTasks', optionalJwt, requirePermission('tasks_manager'), async (req, res) => {
    const tasks = await db_api.getRecords('tasks');
    for (let task of tasks) {
        if (!tasks_api.TASKS[task['key']]) {
            logger.verbose(`Task ${task['key']} does not exist!`);
            continue;
        }
        const job = tasks_api.TASKS[task['key']]['job'];
        const next_invocation = job && job.nextInvocation ? job.nextInvocation() : null;
        if (task['schedule'] && next_invocation) task['next_invocation'] = next_invocation.getTime();
    }
    res.send({tasks: tasks});
});

app.post('/api/resetTasks', optionalJwt, requirePermission('tasks_manager'), async (req, res) => {
    const tasks_keys = Object.keys(tasks_api.TASKS);
    for (let i = 0; i < tasks_keys.length; i++) {
        const task_key = tasks_keys[i];
        tasks_api.TASKS[task_key]['job'] = null;
    }
    await db_api.removeAllRecords('tasks');
    await tasks_api.setupTasks();
    res.send({success: true});
});

app.post('/api/getTask', optionalJwt, requirePermission('tasks_manager'), async (req, res) => {
    const task_key = req.body.task_key;
    const task = await db_api.getRecord('tasks', {key: task_key});
    const job = tasks_api.TASKS[task_key] && tasks_api.TASKS[task_key]['job'];
    const next_invocation = job && job.nextInvocation ? job.nextInvocation() : null;
    if (task['schedule'] && next_invocation) task['next_invocation'] = next_invocation.getTime();
    res.send({task: task});
});

app.post('/api/runTask', optionalJwt, requirePermission('tasks_manager'), async (req, res) => {
    const task_key = req.body.task_key;
    const task = await db_api.getRecord('tasks', {key: task_key});

    let success = true;
    if (task['running'] || task['confirming']) success = false;
    else await tasks_api.executeRun(task_key);

    res.send({success: success});
});

app.post('/api/confirmTask', optionalJwt, requirePermission('tasks_manager'), async (req, res) => {
    const task_key = req.body.task_key;
    const task = await db_api.getRecord('tasks', {key: task_key});

    let success = true;
    if (task['running'] || task['confirming'] || !task['data']) success = false;
    else await tasks_api.executeConfirm(task_key);

    res.send({success: success});
});

app.post('/api/updateTaskSchedule', optionalJwt, requirePermission('tasks_manager'), async (req, res) => {
    const task_key = req.body.task_key;
    const new_schedule = req.body.new_schedule;
  
    await tasks_api.updateTaskSchedule(task_key, new_schedule);

    res.send({success: true});
});

app.post('/api/updateTaskData', optionalJwt, requirePermission('tasks_manager'), async (req, res) => {
    const task_key = req.body.task_key;
    const new_data = req.body.new_data;
  
    const success = await db_api.updateRecord('tasks', {key: task_key}, {data: new_data});

    res.send({success: success});
});

app.post('/api/updateTaskOptions', optionalJwt, requirePermission('tasks_manager'), async (req, res) => {
    const task_key = req.body.task_key;
    const new_options = req.body.new_options;
  
    const success = await db_api.updateRecord('tasks', {key: task_key}, {options: new_options});

    res.send({success: success});
});

app.post('/api/getDBBackups', optionalJwt, requireAdmin, async (req, res) => {
    const backup_dir = path.join('appdata', 'db_backup');
    fs.ensureDirSync(backup_dir);
    const db_backups = [];

    const candidate_backups = await utils.recFindByExt(backup_dir, 'bak', null, [], false);
    for (let i = 0; i < candidate_backups.length; i++) {
        const candidate_backup = candidate_backups[i];

        // must have specific format
        if (candidate_backup.split('.').length - 1 !== 4) continue;

        const candidate_backup_path = candidate_backup;
        const stats = fs.statSync(candidate_backup_path);

        db_backups.push({ name: path.basename(candidate_backup), timestamp: parseInt(candidate_backup.split('.')[2]), size: stats.size, source: candidate_backup.includes('local') ? 'local' : 'remote' });
    }

    db_backups.sort((a,b) => b.timestamp - a.timestamp);

    res.send({db_backups: db_backups});
});

app.post('/api/restoreDBBackup', optionalJwt, requireAdmin, async (req, res) => {
    const file_name = req.body.file_name;

    const success = await db_api.restoreDB(file_name);

    res.send({success: success});
});

// logs management

app.post('/api/logs', optionalJwt, requireAdmin, async function(req, res) {
    let logs = null;
    let lines = req.body.lines;
    const logs_path = path.join('appdata', 'logs', 'combined.log')
    if (await fs.pathExists(logs_path)) {
        if (lines) logs = await read_last_lines.read(logs_path, lines);
        else       logs = await fs.readFile(logs_path, 'utf8');
    }
    else
        logger.error(`Failed to find logs file at the expected location: ${logs_path}`)

    res.send({
        logs: logs,
        success: !!logs
    });
});

app.post('/api/clearAllLogs', optionalJwt, requireAdmin, async function(req, res) {
    const logs_path = path.join('appdata', 'logs', 'combined.log');
    const logs_err_path = path.join('appdata', 'logs', 'error.log');
    let success = false;
    try {
        await Promise.all([
            fs.writeFile(logs_path, ''),
            fs.writeFile(logs_err_path, '')
        ])
        success = true;
    } catch(e) {
        logger.error(e);
    }

    res.send({
        success: success
    });
});

  app.post('/api/getFileFormats', optionalJwt, requireAuthenticated, async (req, res) => {
    const url = req.body.url;
    const result = await downloader_api.getVideoInfoByURL(url, [], null, {forceYtDlp: true});
    res.send({
        result: result && result.length === 1 ? result[0] : null,
        success: result && result.length === 0
    })
});

// user authentication

app.get('/api/auth/oidc/status', (req, res) => {
    res.send(oidc_api.getStatus());
});

app.get('/api/auth/oidc/login', async (req, res) => {
    if (!oidc_api.isEnabled()) {
        res.status(404).send('OIDC is disabled.');
        return;
    }

    try {
        const return_to = req.query.returnTo ? String(req.query.returnTo) : '/home';
        const authorization_url = await oidc_api.createAuthorizationURL(return_to);
        res.redirect(authorization_url);
    } catch (err) {
        logger.error(`OIDC login redirect failed: ${err.message}`);
        res.sendStatus(500);
    }
});

app.get('/api/auth/oidc/callback', async (req, res) => {
    if (!oidc_api.isEnabled()) {
        res.status(404).send('OIDC is disabled.');
        return;
    }

    try {
        const callback_result = await oidc_api.consumeAuthorizationCallback(req);
        const claims = callback_result.claims || {};
        if (!oidc_api.isClaimsAllowed(claims)) {
            logger.error('OIDC login rejected: user does not match allowed groups policy.');
            res.sendStatus(403);
            return;
        }

        const oidc_config = oidc_api.getConfiguration();
        const user_obj = await auth_api.upsertOIDCUser(claims, {
            auto_register: oidc_config.auto_register,
            admin_claim: oidc_config.admin_claim,
            admin_value: oidc_config.admin_value,
            groups_claim: oidc_config.groups_claim,
            username_claim: oidc_config.username_claim,
            display_name_claim: oidc_config.display_name_claim
        });
        if (!user_obj) {
            res.sendStatus(403);
            return;
        }

        const auth_response = await auth_api.getAuthResponseObject(user_obj);
        const return_to = callback_result.return_to ? callback_result.return_to : '/home';
        const redirect_path = `${getOrigin()}/#/login;oidc_token=${encodeURIComponent(auth_response.token)};redirect=${encodeURIComponent(return_to)}`;
        res.setHeader('Set-Cookie', 'ytdl_oidc_bootstrap=1; Path=/; Max-Age=60; HttpOnly; SameSite=Lax');
        res.redirect(redirect_path);
    } catch (err) {
        logger.error(`OIDC callback failed: ${err.message}`);
        res.sendStatus(401);
    }
});

app.post('/api/auth/register', optionalJwt, async (req, res) => {
    if (oidc_api.isEnabled()) {
        res.status(403).send('Registration is disabled when OIDC is enabled.');
        return;
    }

    const userid = req.body.userid;
    const username = req.body.username;
    const plaintextPassword = req.body.password;

    // Closing registration is meant to stop strangers signing themselves up, not to stop
    // an administrator adding an account from the settings page. That exception was
    // written as `exports.userHasPermission(...)`, which app.js does not define and never
    // awaited -- so it either threw or, more usually, was skipped entirely by the
    // short-circuit in front of it, and the settings page could not add users at all.
    // Admin rather than the 'settings' permission: every other user-management route
    // (getUsers, getRoles, changeUser, deleteUser) is admin-only, and creating an account
    // is no smaller a power than editing one.
    const registration_open = !!config_api.getConfigItem('ytdl_allow_registration');
    const caller_may_create_users = req.isAuthenticated() && !!req.user && req.user.role === 'admin';

    if (userid !== 'admin' && !registration_open && !caller_may_create_users) {
        logger.error(`Registration failed for user ${userid}. Registration is disabled.`);
        res.sendStatus(409);
        return;
    }

    if (plaintextPassword === "") {
        logger.error(`Registration failed for user ${userid}. A password must be provided.`);
        res.sendStatus(409);
        return;
    }

    if (!userid || !username) {
        logger.error(`Registration failed for user ${userid}. Username or userid is invalid.`);
    }
  
    const new_user = await auth_api.registerUser(userid, username, plaintextPassword);
  
    if (!new_user) {
      res.sendStatus(409);
      return;
    }
  
    res.send({
      user: auth_api.sanitizeUserForResponse(new_user)
    });
});
app.post('/api/auth/login'
        , (req, res, next) => {
            if (oidc_api.isEnabled()) {
                res.status(403).send('Password login is disabled when OIDC is enabled.');
                return;
            }
            next();
        }
        , auth_api.passport.authenticate(['local', 'ldap'], { session: false })
        , auth_api.generateJWT
        , auth_api.returnAuthResponse
);
app.post('/api/auth/jwtAuth'
        , auth_api.passport.authenticate('jwt', { session: false })
        , auth_api.passport.authorize('jwt')
        , auth_api.generateJWT
        , auth_api.returnAuthResponse
);
/*************************************************
 * Per-user API tokens: the replacement for the
 * Public API key.
 *
 * All three act on the calling account and take no
 * uid from the request, so there is no version of
 * these that touches somebody else's tokens.
 *
 * They are pointless in single-user mode, which has
 * no accounts and asks for no credentials, so they
 * say so rather than issuing a token that means
 * nothing.
 ************************************************/
function refuseTokensInSingleUserMode(res) {
    res.status(400).send({
        success: false,
        error: 'API tokens are only used in multi-user mode. Single-user mode does not require a credential.'
    });
}

app.post('/api/listAPITokens', optionalJwt, requireAuthenticated, requireJwtForTokenManagement, async (req, res) => {
    if (!config_api.getConfigItem('ytdl_multi_user_mode')) return refuseTokensInSingleUserMode(res);

    res.send({success: true, tokens: await api_tokens_api.listTokensForUser(req.user.uid)});
});

app.post('/api/generateAPIToken', optionalJwt, requireAuthenticated, requireJwtForTokenManagement, async (req, res) => {
    if (!config_api.getConfigItem('ytdl_multi_user_mode')) return refuseTokensInSingleUserMode(res);

    const token_request = req.body || {};
    const result = await api_tokens_api.generateTokenForUser(req.user.uid, token_request.label, token_request.type);
    if (!result || result.error) {
        res.status(400).send({success: false, error: result ? result.error : 'Could not generate a token'});
        return;
    }

    // The token itself appears here and nowhere else, ever again.
    res.send({success: true, ...result});
});

app.post('/api/revokeAPIToken', optionalJwt, requireAuthenticated, requireJwtForTokenManagement, async (req, res) => {
    if (!config_api.getConfigItem('ytdl_multi_user_mode')) return refuseTokensInSingleUserMode(res);

    const success = await api_tokens_api.revokeTokenForUser(req.user.uid, req.body && req.body.token_id);
    res.send({success: success});
});

/*************************************************
 * The uid used to come straight off the request
 * body and was written without any check at all, so
 * any account could reset any other -- including
 * admin. A caller changes their own password and
 * has to prove they know it; resetting somebody
 * else's is an administrator's job.
 ************************************************/
app.post('/api/auth/changePassword', optionalJwt, requireAuthenticated, async (req, res) => {
    const enforcing = !!config_api.getConfigItem('ytdl_multi_user_mode');
    const new_password = req.body.new_password;

    if (typeof new_password !== 'string' || new_password === '') {
        res.status(400).send({success: false, error: 'A new password must be provided'});
        return;
    }

    if (!enforcing) {
        const success = await auth_api.changeUserPassword(req.body.user_uid, new_password);
        res.send({success: success});
        return;
    }

    if (!req.user) {
        res.status(401).send({success: false, error: 'Authentication required'});
        return;
    }

    const target_uid = req.body.user_uid ? req.body.user_uid : req.user.uid;
    const changing_own_password = target_uid === req.user.uid;

    if (!changing_own_password && req.user.role !== 'admin') {
        logger.error(`User ${req.user.uid} tried to change the password of ${target_uid}.`);
        res.status(403).send({success: false, error: 'Only an administrator can change another user\'s password'});
        return;
    }

    const must_prove_current_password = changing_own_password && req.user.role !== 'admin';
    if (must_prove_current_password && !await auth_api.verifyUserPassword(req.user.uid, req.body.current_password)) {
        res.status(403).send({success: false, error: 'The current password is incorrect'});
        return;
    }

    const success = await auth_api.changeUserPassword(target_uid, new_password);
    res.send({success: success});
});
app.post('/api/auth/adminExists', async (req, res) => {
    let exists = await auth_api.adminExists();
    res.send({exists: exists});
});

// user management
app.post('/api/getUsers', optionalJwt, requireAdmin, async (req, res) => {
    let users = await db_api.getRecords('users');
    res.send({users: auth_api.sanitizeUsersForResponse(users)});
});
app.post('/api/getRoles', optionalJwt, requireAdmin, async (req, res) => {
    let roles = await db_api.getRecords('roles');
    res.send({roles: roles});
});

app.post('/api/updateUser', optionalJwt, requireAdmin, async (req, res) => {
    let change_obj = req.body.change_object;
    try {
        if (change_obj.name) {
            await db_api.updateRecord('users', {uid: change_obj.uid}, {name: change_obj.name});
        }
        if (change_obj.role) {
            await db_api.updateRecord('users', {uid: change_obj.uid}, {role: change_obj.role});
        }
        res.send({success: true});
    } catch (err) {
        logger.error(err);
        res.send({success: false});
    }
});

app.post('/api/deleteUser', optionalJwt, requireAdmin, async (req, res) => {
    let uid = req.body.uid;
    try {
        const success = await auth_api.deleteUser(uid);
        // A token must not outlive the account it belongs to. resolveToken cleans up an
        // orphan when it meets one, but that leaves a window where the credential is still
        // presentable, and nothing should have to rely on being asked.
        if (success) await api_tokens_api.revokeAllTokensForUser(uid);
        res.send({success: success});
    } catch (err) {
        logger.error(err);
        res.send({success: false});
    }
});

app.post('/api/changeUserPermissions', optionalJwt, requireAdmin, async (req, res) => {
    const user_uid = req.body.user_uid;
    const permission = req.body.permission;
    const new_value = req.body.new_value;

    if (!permission || !new_value) {
        res.sendStatus(400);
        return;
    }

    const success = await auth_api.changeUserPermissions(user_uid, permission, new_value);

    res.send({success: success});
});

app.post('/api/changeRolePermissions', optionalJwt, requireAdmin, async (req, res) => {
    const role = req.body.role;
    const permission = req.body.permission;
    const new_value = req.body.new_value;

    if (!permission || !new_value) {
        res.sendStatus(400);
        return;
    }

    const success = await auth_api.changeRolePermissions(role, permission, new_value);

    res.send({success: success});
});

// notifications

app.post('/api/getNotifications', optionalJwt, requireAuthenticated, async (req, res) => {
    const uuid = req.isAuthenticated() ? req.user.uid : null;

    const notifications = await db_api.getRecords('notifications', {user_uid: uuid});

    res.send({notifications: notifications});
});

// set notifications to read
app.post('/api/setNotificationsToRead', optionalJwt, requireAuthenticated, async (req, res) => {
    const uuid = req.isAuthenticated() ? req.user.uid : null;

    const success = await db_api.updateRecords('notifications', {user_uid: uuid}, {read: true});

    res.send({success: success});
});

app.post('/api/deleteNotification', optionalJwt, requireAuthenticated, async (req, res) => {
    const user_uid = req.isAuthenticated() ? req.user.uid : null;
    const notification_uid = req.body.uid;
    if (!notification_uid) {
        res.send({success: false});
        return;
    }

    const success = await db_api.removeRecord('notifications', {uid: notification_uid, user_uid: user_uid});

    res.send({success: success});
});

app.post('/api/deleteAllNotifications', optionalJwt, requireAuthenticated, async (req, res) => {
    const uuid = req.isAuthenticated() ? req.user.uid : null;

    const success = await db_api.removeAllRecords('notifications', {user_uid: uuid});

    res.send({success: success});
});

/*************************************************
 * Telegram's webhook. It was reachable by anybody
 * who knew the URL: no check that Telegram sent it,
 * none that the integration was even switched on,
 * and the user_uid it queued downloads against came
 * straight off the query string.
 *
 * The secret header is what proves the caller is
 * Telegram. Once it matches, the query string is
 * trustworthy too -- the webhook URL, and therefore
 * the uid in it, is configured by the administrator
 * on Telegram's side.
 ************************************************/
app.post('/api/telegramRequest', async (req, res) => {
    if (!config_api.getConfigItem('ytdl_use_telegram_API')) {
        logger.error('Rejecting a Telegram request: the Telegram integration is disabled.');
        res.sendStatus(404);
        return;
    }

    const expected_secret = config_api.getConfigItem('ytdl_telegram_webhook_secret');
    if (!expected_secret || !utils.timingSafeEquals(req.get('X-Telegram-Bot-Api-Secret-Token'), expected_secret)) {
        logger.error('Rejecting a Telegram request: the webhook secret did not match.');
        res.sendStatus(401);
        return;
    }

    if (!req.body.message || !req.body.message.text) {
        logger.error('Invalid Telegram request received!');
        res.sendStatus(400);
        return;
    }

    // The secret proves Telegram delivered this; it says nothing about who typed it.
    // Anybody who can find the bot can message it, so the chat has to match the one that
    // was configured.
    const configured_chat_id = config_api.getConfigItem('ytdl_telegram_chat_id');
    const message_chat_id = req.body.message.chat && req.body.message.chat.id;
    if (!configured_chat_id || `${message_chat_id}` !== `${configured_chat_id}`) {
        logger.error(`Rejecting a Telegram request from chat ${message_chat_id}: it is not the configured chat.`);
        res.sendStatus(403);
        return;
    }

    const text = req.body.message.text;
    const regex_exp = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)?/gi;
    const url_regex = new RegExp(regex_exp);
    const matched_urls = text.match(url_regex);
    if (matched_urls && matched_urls.length) {
        let parsed_url = null;
        try {
            parsed_url = new URL(matched_urls[0]);
        } catch {
            parsed_url = null;
        }

        if (!parsed_url || (parsed_url.protocol !== 'http:' && parsed_url.protocol !== 'https:')) {
            logger.error('Invalid Telegram request received! URL protocol is not allowed.');
            res.sendStatus(400);
            return;
        }

        const requested_user_uid = req.query.user_uid ? `${req.query.user_uid}` : null;
        if (requested_user_uid && !await db_api.getRecord('users', {uid: requested_user_uid})) {
            logger.error(`Rejecting a Telegram request: there is no user '${requested_user_uid}'.`);
            res.sendStatus(400);
            return;
        }

        downloader_api.createDownload(parsed_url.toString(), 'video', {}, requested_user_uid);
        res.sendStatus(200);
    } else {
        logger.error('Invalid Telegram request received! Make sure you only send a valid URL.');
        notifications_api.sendTelegramNotification({title: 'Invalid Telegram Request', body: 'Make sure you only send a valid URL.', url: text});
        res.sendStatus(400);
    }
});

// rss feed

app.get('/api/rss', optionalJwt, requireAuthenticated, async function (req, res) {
    if (!config_api.getConfigItem('ytdl_enable_rss_feed')) {
        logger.error('RSS feed is disabled! It must be enabled in the settings before it can be generated.');
        res.sendStatus(403);
        return;
    }

    // these are returned
    const sort = req.query.sort ? JSON.parse(decodeURIComponent(req.query.sort)) : {by: 'registered', order: -1};
    const range = req.query.range ? req.query.range.map(range_num => parseInt(range_num)) : null;
    const text_search = req.query.text_search ? decodeURIComponent(req.query.text_search) : null;
    const file_type_filter = req.query.file_type_filter;
    const favorite_filter = req.query.favorite_filter === 'true';
    const category_filter_uids = Array.isArray(req.query.category_filter_uids)
        ? req.query.category_filter_uids.map(category_uid => decodeURIComponent(category_uid))
        : req.query.category_filter_uids
            ? `${req.query.category_filter_uids}`.split(',').map(category_uid => decodeURIComponent(category_uid))
            : null;
    const sub_id = req.query.sub_id ? decodeURIComponent(req.query.sub_id) : null;
    // The credential, not a caller-supplied uid, decides whose feed this is. In
    // single-user mode the guard is intentionally inert and records have no owner.
    const uuid = req.isAuthenticated() ? req.user.uid : null;

    const {files} = await files_api.getAllFiles(sort, range, text_search, file_type_filter, favorite_filter, sub_id, uuid, category_filter_uids);

    const { Feed } = await import('feed');
    const feed = new Feed({
            title: 'Downloads',
            description: 'ytdl-material downloads',
            id: utils.getBaseURL(),
            link: utils.getBaseURL(),
            image: utils.getPublicAssetURL('assets/images/logo_128px.png'),
            favicon: utils.getPublicAssetURL('favicon.ico'),
            generator: 'ytdl-material'
    });

    files.forEach(file => {
        feed.addItem({
            title: file.title,
            link: `${utils.getBaseURL()}/#/player;uid=${file.uid}`,
            description: file.description,
            author: [
                {
                    name: file.uploader,
                    link: file.url
                }
            ],
            contributor: [],
            date: file.timestamp,
            // https://stackoverflow.com/a/45415677/8088021
            image: escapeXmlEntities(file.thumbnailURL)
        });
      });
    res.send(feed.rss2());
});

// web server

app.use(function(req, res, next) {
    if (!oidc_api.isEnabled() || !config_api.getConfigItem('ytdl_multi_user_mode')) {
        return next();
    }

    if (req.path.includes('/api/')) {
        return next();
    }

    // Hash routes (/#/...) are received as "/" on the server. Let the SPA load so
    // client-side routing can preserve return targets like /player;uid=... .
    if (req.path === '/') {
        return next();
    }

    const accept = req.accepts('html', 'json', 'xml');
    if (accept !== 'html') {
        return next();
    }

    const ext = path.extname(req.path);
    if (ext !== '') {
        return next();
    }

    const cookie_header = req.headers.cookie || '';
    const has_bootstrap_cookie = cookie_header.split(';').map(cookie => cookie.trim()).includes('ytdl_oidc_bootstrap=1');
    if (has_bootstrap_cookie) {
        res.setHeader('Set-Cookie', 'ytdl_oidc_bootstrap=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
        return next();
    }

    const return_to = req.path && req.path !== '/' ? req.path : '/home';
    const redirect_path = `/api/auth/oidc/login?returnTo=${encodeURIComponent(return_to)}`;
    return res.redirect(redirect_path);
});

app.use(function(req, res, next) {
    //if the request is not html then move along
    var accept = req.accepts('html', 'json', 'xml');
    if (accept !== 'html') {
        return next();
    }

    // if the request has a '.' assume that it's for a file, move along
    var ext = path.extname(req.path);
    if (ext !== '') {
        return next();
    }

    let index_path = path.join(__dirname, 'public', 'index.html');

    res.setHeader('Content-Type', 'text/html');

    fs.createReadStream(index_path).pipe(res);

});

let public_dir = path.join(__dirname, 'public');

app.use(express.static(public_dir));
