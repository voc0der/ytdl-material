const logger = require('./logger');

const fs = require('fs');
const { BehaviorSubject } = require('rxjs');

exports.CONFIG_ITEMS = require('./consts.js')['CONFIG_ITEMS'];
exports.descriptors = {}; // to get rid of file locks when needed, TODO: move to youtube-dl.js

const debugMode = process.env.YTDL_MODE === 'debug';

let configPath = debugMode ? '../src/assets/default.json' : 'appdata/default.json';
exports.config_updated = new BehaviorSubject();
const CONFIG_ROOT_KEY = 'YtdlMaterial';
const LEGACY_CONFIG_ROOT_KEY = ['Youtube', 'DLMaterial'].join('');
const YTDLP_IMPERSONATION_DEPENDENCY_ENV_KEYS = [
    'ytdl_enable_ytdlp_impersonation_dependencies',
    'YTDL_ENABLE_YTDLP_IMPERSONATION_DEPENDENCIES',
    'ytdl_enable_curl_cffi',
    'YTDL_ENABLE_CURL_CFFI'
];

function isTruthyEnvValue(value) {
    return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function isYtDlpImpersonationDependencyEnvEnabled() {
    return YTDLP_IMPERSONATION_DEPENDENCY_ENV_KEYS.some(env_key => isTruthyEnvValue(process.env[env_key]));
}
exports.isYtDlpImpersonationDependencyEnvEnabled = isYtDlpImpersonationDependencyEnvEnabled;

function getDefaultConfig() {
    const default_config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    if (isYtDlpImpersonationDependencyEnvEnabled()) {
        default_config.YtdlMaterial.Downloader.use_ytdlp_impersonation = true;
    }
    return default_config;
}

function getDefaultConfigItemValue(key) {
    const default_config = getDefaultConfig();
    return Object.byString(default_config, exports.CONFIG_ITEMS[key]['path']);
}

function normalizeConfigRoot(config_json) {
    if (!config_json || typeof config_json !== 'object') return {normalized_config: config_json, migrated: false};
    if (config_json[CONFIG_ROOT_KEY] !== undefined) return {normalized_config: config_json, migrated: false};
    if (config_json[LEGACY_CONFIG_ROOT_KEY] === undefined) return {normalized_config: config_json, migrated: false};

    config_json[CONFIG_ROOT_KEY] = config_json[LEGACY_CONFIG_ROOT_KEY];
    delete config_json[LEGACY_CONFIG_ROOT_KEY];
    return {normalized_config: config_json, migrated: true};
}

// Settings that no longer exist. They are stripped from the config on startup so they do
// not linger as dead keys, and anyone who had one enabled gets told what replaced it
// rather than silently losing the behavior.
const RETIRED_CONFIG_ITEMS = [
    {
        path: 'YtdlMaterial.Downloader.use_extractor_client_fallback',
        enabled_warning: 'The \'use extractor client fallback\' setting has been removed. It always applied a fixed'
            + ' yt-dlp client list (--extractor-args youtube:player_client=tv,web) which no longer works and now'
            + ' causes the HTTP 403 download errors it was meant to prevent. yt-dlp now selects its own clients.'
            + ' If you still need to pin one, add it to your global custom args, for example:'
            + ' --extractor-args,,youtube:player_client=default'
    },
    {
        path: 'YtdlMaterial.Advanced.allow_advanced_download',
        disabled_warning: 'The \'allow advanced download\' setting has been removed. Advanced download options are'
            + ' now always available from the Download button menu, so users who previously could not reach them'
            + ' will see them. Access is still controlled by the \'advanced_download\' user permission, which can'
            + ' be revoked per role under Settings if you want to keep it hidden.'
    }
];

exports.initialize = () => {
    ensureConfigFileExists();
    removeRetiredConfigItems();
    ensureConfigItemsExist();
}

function removeRetiredConfigItems() {
    const config_json = exports.getConfigFile();
    if (!config_json) return;

    let removed_any = false;
    for (const retired_item of RETIRED_CONFIG_ITEMS) {
        const parent_object = Object.byString(config_json, getParentPath(retired_item.path));
        const element_name = getElementNameInConfig(retired_item.path);
        if (!parent_object || !(element_name in parent_object)) continue;

        // Which stored value is worth warning about depends on the setting: removing an
        // opt-in matters to whoever turned it on, removing an opt-out matters to whoever
        // turned it off.
        const stored_warning = parent_object[element_name] ? retired_item.enabled_warning : retired_item.disabled_warning;
        if (stored_warning) logger.warn(stored_warning);
        delete parent_object[element_name];
        removed_any = true;
    }

    if (removed_any) exports.setConfigFile(config_json);
}

function ensureConfigItemsExist() {
    const config_keys = Object.keys(exports.CONFIG_ITEMS);
    for (let i = 0; i < config_keys.length; i++) {
        const config_key = config_keys[i];
        exports.getConfigItem(config_key);
    }
}

function ensureConfigFileExists() {
    if (!fs.existsSync(configPath)) {
        logger.info('Cannot find config file. Creating one with default values...');
        fs.writeFileSync(configPath, JSON.stringify(getDefaultConfig(), null, 2));
    }
}

// https://stackoverflow.com/questions/6491463/accessing-nested-javascript-objects-with-string-key
Object.byString = function(o, s) {
    s = s.replace(/\[(\w+)\]/g, '.$1'); // convert indexes to properties
    s = s.replace(/^\./, '');           // strip a leading dot
    var a = s.split('.');
    for (var i = 0, n = a.length; i < n; ++i) {
        var k = a[i];
        if (k in o) {
            o = o[k];
        } else {
            return;
        }
    }
    return o;
}

function getParentPath(path) {
    let elements = path.split('.');
    elements.splice(elements.length - 1, 1);
    return elements.join('.');
}

function getElementNameInConfig(path) {
    let elements = path.split('.');
    return elements[elements.length - 1];
}

/**
 * Check if config exists. If not, write default config to config path
 */
exports.configExistsCheck = () => {
    let exists = fs.existsSync(configPath);
    if (!exists) {
        exports.setConfigFile(getDefaultConfig());
    }
}

/*
* Gets config file and returns as a json
*/
exports.getConfigFile = () => {
    try {
        let raw_data = fs.readFileSync(configPath);
        let parsed_data = JSON.parse(raw_data);
        const {normalized_config, migrated} = normalizeConfigRoot(parsed_data);
        if (migrated) {
            fs.writeFileSync(configPath, JSON.stringify(normalized_config, null, 2));
            logger.info(`Migrated config root key to '${CONFIG_ROOT_KEY}'.`);
        }
        return normalized_config;
    } catch(e) {
        logger.error('Failed to get config file');
        return null;
    }
}

exports.setConfigFile = (config) => {
    try {
        const {normalized_config} = normalizeConfigRoot(config);
        const old_config = exports.getConfigFile();
        preserveRedactedSecrets(normalized_config, old_config);
        fs.writeFileSync(configPath, JSON.stringify(normalized_config, null, 2));
        const changes = exports.findChangedConfigItems(old_config, normalized_config);
        if (changes.length > 0) {
            for (const change of changes) exports.config_updated.next(change);
        }
        return true;
    } catch(e) {
        return false;
    }
}

exports.getConfigItem = (key) => {
    let config_json = exports.getConfigFile();
    if (!exports.CONFIG_ITEMS[key]) {
        logger.error(`Config item with key '${key}' is not recognized.`);
        return null;
    }
    let path = exports.CONFIG_ITEMS[key]['path'];
    const val = Object.byString(config_json, path);
    if (val === undefined && Object.byString(DEFAULT_CONFIG, path) !== undefined) {
        logger.warn(`Cannot find config with key '${key}'. Creating one with the default value...`);
        const default_value = getDefaultConfigItemValue(key);
        exports.setConfigItem(key, default_value);
        return default_value;
    }
    return Object.byString(config_json, path);
}

exports.setConfigItem = (key, value) => {
    let success = false;
    let config_json = exports.getConfigFile();
    let path = exports.CONFIG_ITEMS[key]['path'];
    let element_name = getElementNameInConfig(path);
    let parent_path = getParentPath(path);
    let parent_object = Object.byString(config_json, parent_path);
    if (!parent_object) {
        let parent_parent_path = getParentPath(parent_path);
        let parent_parent_object = Object.byString(config_json, parent_parent_path);
        let parent_path_arr = parent_path.split('.');
        let parent_parent_single_key = parent_path_arr[parent_path_arr.length-1];
        parent_parent_object[parent_parent_single_key] = {};
        parent_object = Object.byString(config_json, parent_path);
    }
    if (value === 'false') value = false;
    if (value === 'true') value = true;
    parent_object[element_name] = value;

    success = exports.setConfigFile(config_json);

    return success;
}

exports.setConfigItems = (items) => {
    let success = false;
    let config_json = exports.getConfigFile();
    for (let i = 0; i < items.length; i++) {
        let key = items[i].key;
        let value = items[i].value;

        // if boolean strings, set to booleans again
        if (value === 'false' || value === 'true') {
            value = (value === 'true');
        }

        let item_path = exports.CONFIG_ITEMS[key]['path'];
        let item_parent_path = getParentPath(item_path);
        let item_element_name = getElementNameInConfig(item_path);

        let item_parent_object = Object.byString(config_json, item_parent_path);
        item_parent_object[item_element_name] = value;
    }

    success = exports.setConfigFile(config_json);
    return success;
}

exports.globalArgsRequiresSafeDownload = () => {
    const globalArgs = exports.getConfigItem('ytdl_custom_args').split(',,');
    const argsThatRequireSafeDownload = ['--write-sub', '--write-srt', '--proxy'];
    const failedArgs = globalArgs.filter(arg => argsThatRequireSafeDownload.includes(arg));
    return failedArgs && failedArgs.length > 0;
}

exports.findChangedConfigItems = (old_config, new_config, path = '', changedConfigItems = [], depth = 0) => {
    if (typeof old_config === 'object' && typeof new_config === 'object' && depth < 3) {
        for (const key in old_config) {
            if (Object.prototype.hasOwnProperty.call(new_config, key)) {
                exports.findChangedConfigItems(old_config[key], new_config[key], `${path}${path ? '.' : ''}${key}`, changedConfigItems, depth + 1);
            }
        }
    } else {
        if (JSON.stringify(old_config) !== JSON.stringify(new_config)) {
            const key = getConfigItemKeyByPath(path);
            changedConfigItems.push({
                key: key ? key : path.split('.')[path.split('.').length - 1], // return key in CONFIG_ITEMS or the object key
                old_value: JSON.parse(JSON.stringify(old_config)),
                new_value: JSON.parse(JSON.stringify(new_config))
            });
        }
    }
    return changedConfigItems;
}

function getConfigItemKeyByPath(path) {
    const found_item = Object.values(exports.CONFIG_ITEMS).find(item => item.path === path);
    if (found_item) return found_item['key'];
    else return null;
}

const DEFAULT_CONFIG = {
    "YtdlMaterial": {
      "Host": {
        "url": "http://example.com",
        "port": "17442"
      },
      "Downloader": {
        "path-audio": "audio/",
        "path-video": "video/",
        "default_file_output": "",
        "replace_invalid_filename_chars": false,
        "invalid_filename_chars": "\\/:*?\"<>|",
        "invalid_filename_replacement": "_",
        "use_youtubedl_archive": false,
        "custom_args": "",
        "include_thumbnail": true,
        "include_metadata": true,
        "max_concurrent_downloads": 5,
        "min_sleep_between_downloads": 0,
        "playlist_chunk_size": 20,
        "download_rate_limit": "",
        "skip_join_only_videos": false,
        "use_ytdlp_impersonation": false,
        "js_runtimes": "",
        "transcoding": false
      },
      "Extra": {
        "title_top": "ytdl-material",
        "file_manager_enabled": true,
        "allow_quality_select": true,
        "warn_on_duplicate": false,
        "download_only_mode": false,
        "force_autoplay": false,
        "enable_downloads_manager": true,
        "allow_playlist_categorization": true,
        "enable_notifications": true,
        "enable_all_notifications": true,
        "allowed_notification_types": [],
        "enable_rss_feed": false,
      },
      "API": {
        "use_API_key": false,
        "API_key": "",
        "enable_documentation_api": false,
        "use_youtube_API": false,
        "youtube_API_key": "",
        "twitch_auto_download_chat": false,
        "use_sponsorblock_API": false,
        "generate_NFO_files": false,
        "use_ntfy_API": false,
        "ntfy_topic_URL": "",
        "use_gotify_API": false,
        "gotify_server_URL": "",
        "gotify_app_token": "",
        "use_telegram_API": false,
        "telegram_bot_token": "",
        "telegram_chat_id": "",
        "telegram_webhook_proxy": "",
        "telegram_webhook_secret": "",
        "webhook_URL": "",
        "use_custom_webhook_template": false,
        "custom_webhook_title_template": "{{event_name}}",
        "custom_webhook_body_template": "{{event_body}}",
        "discord_webhook_URL": "",
        "slack_webhook_URL": "",
      },
      "Themes": {
        "default_theme": "default",
        "allow_theme_change": true
      },
      "Subscriptions": {
        "allow_subscriptions": true,
        "subscriptions_base_path": "subscriptions/",
        "redownload_fresh_uploads": false
      },
      "Users": {
        "base_path": "users/",
        "allow_registration": true,
        "auth_method": "internal",
        "ldap_config": {
            "url": "ldap://localhost:389",
            "bindDN": "cn=root",
            "bindCredentials": "secret",
            "searchBase": "ou=people,dc=example,dc=com",
            "searchFilter": "(uid={{username}})"
        },
        "oidc": {
            "enabled": false,
            "issuer_url": "",
            "client_id": "",
            "client_secret": "",
            "redirect_uri": "",
            "scope": "openid profile email",
            "auto_register": true,
            "admin_claim": "groups",
            "admin_value": "admin",
            "group_claim": "groups",
            "allowed_groups": "",
            "username_claim": "preferred_username",
            "display_name_claim": "preferred_username"
        }
      },
      "Database": {
        "use_local_db": true,
        "remote_db_type": "",
        "mongodb_connection_string": "mongodb://127.0.0.1:27017/?compressors=zlib",
        "postgresdb_connection_string": "",
        "redis_connection_string": "",
        "db_migrate": ""
      },
      "Advanced": {
        "default_downloader": "yt-dlp",
        "ytdlp_update_channel": "stable",
        "use_default_downloading_agent": true,
        "custom_downloading_agent": "",
        "multi_user_mode": false,
        "use_cookies": false,
        "jwt_expiration": 86400,
        "logger_level": "info"
      }
    }
  }

/*************************************************
 * /api/config is reachable before login, because
 * the frontend needs to know things like the auth
 * method and whether registration is open before it
 * can render anything. The config file also holds
 * every integration secret the app has been given.
 *
 * So the file is redacted for callers who are not
 * entitled to the whole thing. Callers who can edit
 * settings get it intact, which is the only way the
 * settings page can work -- and means a redacted
 * value never round-trips back into setConfig.
 ************************************************/
const SENSITIVE_CONFIG_PATHS = [
    'YtdlMaterial.API.API_key',
    'YtdlMaterial.API.twitch_client_ID',
    'YtdlMaterial.API.twitch_client_secret',
    // The name this used to have. Installs that predate the client-ID/secret split still
    // carry it, and redaction that only knows the new names walks straight past it.
    'YtdlMaterial.API.twitch_API_key',
    'YtdlMaterial.API.ntfy_topic_URL',
    'YtdlMaterial.API.gotify_server_URL',
    'YtdlMaterial.API.gotify_app_token',
    'YtdlMaterial.API.telegram_bot_token',
    'YtdlMaterial.API.telegram_chat_id',
    'YtdlMaterial.API.telegram_webhook_proxy',
    'YtdlMaterial.API.telegram_webhook_secret',
    'YtdlMaterial.API.webhook_URL',
    'YtdlMaterial.API.discord_webhook_URL',
    'YtdlMaterial.API.slack_webhook_URL',
    'YtdlMaterial.Users.ldap_config.bindDN',
    'YtdlMaterial.Users.ldap_config.bindCredentials',
    'YtdlMaterial.Users.ldap_config.url',
    'YtdlMaterial.Users.ldap_config.searchBase',
    'YtdlMaterial.Users.ldap_config.searchFilter',
    'YtdlMaterial.Users.oidc.client_id',
    'YtdlMaterial.Users.oidc.client_secret',
    'YtdlMaterial.Users.oidc.issuer_url',
    // Connection strings carry a username and password in the URL itself, so the whole
    // value is the secret. A key-name heuristic would never have caught these.
    'YtdlMaterial.Database.mongodb_connection_string',
    'YtdlMaterial.Database.postgresdb_connection_string',
    'YtdlMaterial.Database.redis_connection_string',
    // Free-form yt-dlp arguments, which routinely hold --proxy and --username/--password.
    'YtdlMaterial.Downloader.custom_args'
];

exports.SENSITIVE_CONFIG_PATHS = SENSITIVE_CONFIG_PATHS;

/*************************************************
 * Fields that read like credentials but are handed
 * to every client on purpose, because something
 * outside the settings page needs them. Listed
 * explicitly so the redaction test can tell them
 * apart from an oversight.
 ************************************************/
exports.CLIENT_VISIBLE_CONFIG_PATHS = {
    'YtdlMaterial.API.youtube_API_key': 'the search runs in the browser, so the key has to reach it. Protecting it means moving search to the backend first.'
};

/*************************************************
 * Fields a logged-in client is given but an
 * anonymous one is not.
 *
 * youtube_API_key has to reach the browser because
 * search runs there -- but "a logged-in user may
 * see it" is not a reason to publish it to anybody
 * who can reach the login page.
 ************************************************/
const AUTHENTICATED_ONLY_CONFIG_PATHS = [
    'YtdlMaterial.API.youtube_API_key'
];

exports.AUTHENTICATED_ONLY_CONFIG_PATHS = AUTHENTICATED_ONLY_CONFIG_PATHS;

function resolveParent(root, dotted_path) {
    const parts = dotted_path.split('.');
    const field = parts.pop();
    let node = root;
    for (const part of parts) {
        if (!node || typeof node !== 'object') return {node: null, field: field};
        node = node[part];
    }
    return {node: node && typeof node === 'object' ? node : null, field: field};
}

function deletePath(root, dotted_path) {
    const {node, field} = resolveParent(root, dotted_path);
    if (node && field in node) delete node[field];
}

function hasPath(root, dotted_path) {
    const {node, field} = resolveParent(root, dotted_path);
    return !!node && field in node;
}

function getPath(root, dotted_path) {
    const {node, field} = resolveParent(root, dotted_path);
    return node ? node[field] : undefined;
}

function setPath(root, dotted_path, value) {
    const parts = dotted_path.split('.');
    const field = parts.pop();
    let node = root;
    for (const part of parts) {
        if (!node[part] || typeof node[part] !== 'object') node[part] = {};
        node = node[part];
    }
    node[field] = value;
}

/*************************************************
 * A client that was handed a redacted config must
 * not be able to erase the secrets it could not see
 * simply by saving the settings page back: the
 * settings page submits the whole document, and
 * setConfigFile replaces the whole document.
 *
 * Absence means "this was never shown to me", so
 * the stored value is carried forward. Clearing a
 * secret on purpose is done by sending an empty
 * value, which is present and therefore honoured.
 ************************************************/
function preserveRedactedSecrets(new_config, old_config) {
    if (!new_config || !old_config) return;
    // Both lists, not just the sensitive one: a field withheld from anonymous callers is
    // equally missing from a document one of them was handed, and would be erased the
    // same way if it were saved back.
    for (const sensitive_path of [...SENSITIVE_CONFIG_PATHS, ...AUTHENTICATED_ONLY_CONFIG_PATHS]) {
        if (hasPath(new_config, sensitive_path)) continue;
        if (!hasPath(old_config, sensitive_path)) continue;
        setPath(new_config, sensitive_path, getPath(old_config, sensitive_path));
    }
}

exports.preserveRedactedSecrets = preserveRedactedSecrets;

exports.getRedactedConfigFile = () => {
    const config_json = exports.getConfigFile();
    if (!config_json) return config_json;

    // Structured clone rather than a shallow copy: the paths below are nested, and the
    // caller must not be able to reach the live object the rest of the process is using.
    const redacted = JSON.parse(JSON.stringify(config_json));
    for (const sensitive_path of SENSITIVE_CONFIG_PATHS) deletePath(redacted, sensitive_path);
    return redacted;
}

/*************************************************
 * What an anonymous caller gets in multi-user mode.
 *
 * An allowlist is the safer shape and it was tried
 * first. The trouble is that the pre-login surface
 * is not only the login page: a share link renders
 * the player, and the application shell reads
 * Subscriptions, Extra and Downloader without
 * checking whether they are there -- so a
 * projection that withholds them white-screens
 * every anonymous visitor. Breaking every shared
 * link is a worse outcome than the one being
 * defended against.
 *
 * So this stays subtractive, and the compensating
 * control is that SENSITIVE_CONFIG_PATHS is
 * enumerated and tested rather than inferred. A
 * test also fails on any field whose name reads
 * like a credential, which is what catches a
 * setting added later by somebody who did not think
 * to update the list.
 ************************************************/
exports.getAnonymousConfigFile = () => {
    const config_json = exports.getRedactedConfigFile();
    if (!config_json) return config_json;

    for (const authenticated_path of AUTHENTICATED_ONLY_CONFIG_PATHS) deletePath(config_json, authenticated_path);
    return config_json;
}
