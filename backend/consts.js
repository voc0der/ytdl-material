exports.CONFIG_ITEMS = {
    // Host
    'ytdl_url': {
        'key': 'ytdl_url',
        'path': 'YtdlMaterial.Host.url'
    },
    'ytdl_port': {
        'key': 'ytdl_port',
        'path': 'YtdlMaterial.Host.port'
    },
    'ytdl_ssl_cert_path': {
        'key': 'ytdl_ssl_cert_path',
        'path': 'YtdlMaterial.Host.ssl_cert_path'
    },
    'ytdl_ssl_key_path': {
        'key': 'ytdl_ssl_key_path',
        'path': 'YtdlMaterial.Host.ssl_key_path'
    },
    'ytdl_reverse_proxy_whitelist': {
        'key': 'ytdl_reverse_proxy_whitelist',
        'path': 'YtdlMaterial.Host.reverse_proxy_whitelist'
    },

    // Downloader
    'ytdl_audio_folder_path': {
        'key': 'ytdl_audio_folder_path',
        'path': 'YtdlMaterial.Downloader.path-audio'
    },
    'ytdl_video_folder_path': {
        'key': 'ytdl_video_folder_path',
        'path': 'YtdlMaterial.Downloader.path-video'
    },
    'ytdl_default_file_output': {
        'key': 'ytdl_default_file_output',
        'path': 'YtdlMaterial.Downloader.default_file_output'
    },
    'ytdl_replace_invalid_filename_chars': {
        'key': 'ytdl_replace_invalid_filename_chars',
        'path': 'YtdlMaterial.Downloader.replace_invalid_filename_chars'
    },
    'ytdl_invalid_filename_chars': {
        'key': 'ytdl_invalid_filename_chars',
        'path': 'YtdlMaterial.Downloader.invalid_filename_chars'
    },
    'ytdl_invalid_filename_replacement': {
        'key': 'ytdl_invalid_filename_replacement',
        'path': 'YtdlMaterial.Downloader.invalid_filename_replacement'
    },
    'ytdl_use_youtubedl_archive': {
        'key': 'ytdl_use_youtubedl_archive',
        'path': 'YtdlMaterial.Downloader.use_youtubedl_archive'
    },
    'ytdl_custom_args': {
        'key': 'ytdl_custom_args',
        'path': 'YtdlMaterial.Downloader.custom_args'
    },
    'ytdl_include_thumbnail': {
        'key': 'ytdl_include_thumbnail',
        'path': 'YtdlMaterial.Downloader.include_thumbnail'
    },
    'ytdl_include_metadata': {
        'key': 'ytdl_include_metadata',
        'path': 'YtdlMaterial.Downloader.include_metadata'
    },
    'ytdl_max_concurrent_downloads': {
        'key': 'ytdl_max_concurrent_downloads',
        'path': 'YtdlMaterial.Downloader.max_concurrent_downloads'
    },
    'ytdl_playlist_chunk_size': {
        'key': 'ytdl_playlist_chunk_size',
        'path': 'YtdlMaterial.Downloader.playlist_chunk_size'
    },
    'ytdl_download_rate_limit': {
        'key': 'ytdl_download_rate_limit',
        'path': 'YtdlMaterial.Downloader.download_rate_limit'
    },

    // Extra
    'ytdl_title_top': {
        'key': 'ytdl_title_top',
        'path': 'YtdlMaterial.Extra.title_top'
    },
    'ytdl_file_manager_enabled': {
        'key': 'ytdl_file_manager_enabled',
        'path': 'YtdlMaterial.Extra.file_manager_enabled'
    },
    'ytdl_allow_quality_select': {
        'key': 'ytdl_allow_quality_select',
        'path': 'YtdlMaterial.Extra.allow_quality_select'
    },
    'ytdl_warn_on_duplicate': {
        'key': 'ytdl_warn_on_duplicate',
        'path': 'YtdlMaterial.Extra.warn_on_duplicate'
    },
    'ytdl_download_only_mode': {
        'key': 'ytdl_download_only_mode',
        'path': 'YtdlMaterial.Extra.download_only_mode'
    },
    'ytdl_force_autoplay': {
        'key': 'ytdl_force_autoplay',
        'path': 'YtdlMaterial.Extra.force_autoplay'
    },
    'ytdl_enable_downloads_manager': {
        'key': 'ytdl_enable_downloads_manager',
        'path': 'YtdlMaterial.Extra.enable_downloads_manager'
    },
    'ytdl_allow_playlist_categorization': {
        'key': 'ytdl_allow_playlist_categorization',
        'path': 'YtdlMaterial.Extra.allow_playlist_categorization'
    },
    'ytdl_enable_notifications': {
        'key': 'ytdl_enable_notifications',
        'path': 'YtdlMaterial.Extra.enable_notifications'
    },
    'ytdl_enable_all_notifications': {
        'key': 'ytdl_enable_all_notifications',
        'path': 'YtdlMaterial.Extra.enable_all_notifications'
    },
    'ytdl_allowed_notification_types': {
        'key': 'ytdl_allowed_notification_types',
        'path': 'YtdlMaterial.Extra.allowed_notification_types'
    },
    'ytdl_enable_rss_feed': {
        'key': 'ytdl_enable_rss_feed',
        'path': 'YtdlMaterial.Extra.enable_rss_feed'
    },

    // API
    'ytdl_use_api_key': {
        'key': 'ytdl_use_api_key',
        'path': 'YtdlMaterial.API.use_API_key'
    },
    'ytdl_api_key': {
        'key': 'ytdl_api_key',
        'path': 'YtdlMaterial.API.API_key'
    },
    'ytdl_enable_documentation_api': {
        'key': 'ytdl_enable_documentation_api',
        'path': 'YtdlMaterial.API.enable_documentation_api'
    },
    'ytdl_use_youtube_api': {
        'key': 'ytdl_use_youtube_api',
        'path': 'YtdlMaterial.API.use_youtube_API'
    },
    'ytdl_youtube_api_key': {
        'key': 'ytdl_youtube_api_key',
        'path': 'YtdlMaterial.API.youtube_API_key'
    },
    'ytdl_twitch_auto_download_chat': {
        'key': 'ytdl_twitch_auto_download_chat',
        'path': 'YtdlMaterial.API.twitch_auto_download_chat'
    },
    'ytdl_use_sponsorblock_api': {
        'key': 'ytdl_use_sponsorblock_api',
        'path': 'YtdlMaterial.API.use_sponsorblock_API'
    },
    'ytdl_generate_nfo_files': {
        'key': 'ytdl_generate_nfo_files',
        'path': 'YtdlMaterial.API.generate_NFO_files'
    },
    'ytdl_use_ntfy_API': {
        'key': 'ytdl_use_ntfy_API',
        'path': 'YtdlMaterial.API.use_ntfy_API'
    },
    'ytdl_ntfy_topic_url': {
        'key': 'ytdl_ntfy_topic_url',
        'path': 'YtdlMaterial.API.ntfy_topic_URL'
    },
    'ytdl_use_gotify_API': {
        'key': 'ytdl_use_gotify_API',
        'path': 'YtdlMaterial.API.use_gotify_API'
    },
    'ytdl_gotify_server_url': {
        'key': 'ytdl_gotify_server_url',
        'path': 'YtdlMaterial.API.gotify_server_URL'
    },
    'ytdl_gotify_app_token': {
        'key': 'ytdl_gotify_app_token',
        'path': 'YtdlMaterial.API.gotify_app_token'
    },
    'ytdl_use_telegram_API': {
        'key': 'ytdl_use_telegram_API',
        'path': 'YtdlMaterial.API.use_telegram_API'
    },
    'ytdl_telegram_bot_token': {
        'key': 'ytdl_telegram_bot_token',
        'path': 'YtdlMaterial.API.telegram_bot_token'
    },
    'ytdl_telegram_chat_id': {
        'key': 'ytdl_telegram_chat_id',
        'path': 'YtdlMaterial.API.telegram_chat_id'
    },
    'ytdl_telegram_webhook_proxy': {
        'key': 'ytdl_telegram_webhook_proxy',
        'path': 'YtdlMaterial.API.telegram_webhook_proxy'
    },
    'ytdl_webhook_url': {
        'key': 'ytdl_webhook_url',
        'path': 'YtdlMaterial.API.webhook_URL'
    },
    'ytdl_use_custom_webhook_template': {
        'key': 'ytdl_use_custom_webhook_template',
        'path': 'YtdlMaterial.API.use_custom_webhook_template'
    },
    'ytdl_custom_webhook_title_template': {
        'key': 'ytdl_custom_webhook_title_template',
        'path': 'YtdlMaterial.API.custom_webhook_title_template'
    },
    'ytdl_custom_webhook_body_template': {
        'key': 'ytdl_custom_webhook_body_template',
        'path': 'YtdlMaterial.API.custom_webhook_body_template'
    },
    'ytdl_discord_webhook_url': {
        'key': 'ytdl_discord_webhook_url',
        'path': 'YtdlMaterial.API.discord_webhook_URL'
    },
    'ytdl_slack_webhook_url': {
        'key': 'ytdl_slack_webhook_url',
        'path': 'YtdlMaterial.API.slack_webhook_URL'
    },


    // Themes
    'ytdl_default_theme': {
        'key': 'ytdl_default_theme',
        'path': 'YtdlMaterial.Themes.default_theme'
    },
    'ytdl_allow_theme_change': {
        'key': 'ytdl_allow_theme_change',
        'path': 'YtdlMaterial.Themes.allow_theme_change'
    },

    // Subscriptions
    'ytdl_allow_subscriptions': {
        'key': 'ytdl_allow_subscriptions',
        'path': 'YtdlMaterial.Subscriptions.allow_subscriptions'
    },
    'ytdl_subscriptions_base_path': {
        'key': 'ytdl_subscriptions_base_path',
        'path': 'YtdlMaterial.Subscriptions.subscriptions_base_path'
    },
    'ytdl_subscriptions_check_interval': {
        'key': 'ytdl_subscriptions_check_interval',
        'path': 'YtdlMaterial.Subscriptions.subscriptions_check_interval'
    },
    'ytdl_subscriptions_redownload_fresh_uploads': {
        'key': 'ytdl_subscriptions_redownload_fresh_uploads',
        'path': 'YtdlMaterial.Subscriptions.redownload_fresh_uploads'
    },

    // Users
    'ytdl_users_base_path': {
        'key': 'ytdl_users_base_path',
        'path': 'YtdlMaterial.Users.base_path'
    },
    'ytdl_allow_registration': {
        'key': 'ytdl_allow_registration',
        'path': 'YtdlMaterial.Users.allow_registration'
    },
    'ytdl_auth_method': {
        'key': 'ytdl_auth_method',
        'path': 'YtdlMaterial.Users.auth_method'
    },
    'ytdl_ldap_config': {
        'key': 'ytdl_ldap_config',
        'path': 'YtdlMaterial.Users.ldap_config'
    },
    'ytdl_oidc_enabled': {
        'key': 'ytdl_oidc_enabled',
        'path': 'YtdlMaterial.Users.oidc.enabled'
    },
    'ytdl_oidc_issuer_url': {
        'key': 'ytdl_oidc_issuer_url',
        'path': 'YtdlMaterial.Users.oidc.issuer_url'
    },
    'ytdl_oidc_client_id': {
        'key': 'ytdl_oidc_client_id',
        'path': 'YtdlMaterial.Users.oidc.client_id'
    },
    'ytdl_oidc_client_secret': {
        'key': 'ytdl_oidc_client_secret',
        'path': 'YtdlMaterial.Users.oidc.client_secret'
    },
    'ytdl_oidc_redirect_uri': {
        'key': 'ytdl_oidc_redirect_uri',
        'path': 'YtdlMaterial.Users.oidc.redirect_uri'
    },
    'ytdl_oidc_scope': {
        'key': 'ytdl_oidc_scope',
        'path': 'YtdlMaterial.Users.oidc.scope'
    },
    'ytdl_oidc_auto_register': {
        'key': 'ytdl_oidc_auto_register',
        'path': 'YtdlMaterial.Users.oidc.auto_register'
    },
    'ytdl_oidc_admin_claim': {
        'key': 'ytdl_oidc_admin_claim',
        'path': 'YtdlMaterial.Users.oidc.admin_claim'
    },
    'ytdl_oidc_admin_value': {
        'key': 'ytdl_oidc_admin_value',
        'path': 'YtdlMaterial.Users.oidc.admin_value'
    },
    'ytdl_oidc_group_claim': {
        'key': 'ytdl_oidc_group_claim',
        'path': 'YtdlMaterial.Users.oidc.group_claim'
    },
    'ytdl_oidc_allowed_groups': {
        'key': 'ytdl_oidc_allowed_groups',
        'path': 'YtdlMaterial.Users.oidc.allowed_groups'
    },
    'ytdl_oidc_username_claim': {
        'key': 'ytdl_oidc_username_claim',
        'path': 'YtdlMaterial.Users.oidc.username_claim'
    },
    'ytdl_oidc_display_name_claim': {
        'key': 'ytdl_oidc_display_name_claim',
        'path': 'YtdlMaterial.Users.oidc.display_name_claim'
    },

    // Database
    'ytdl_use_local_db': {
        'key': 'ytdl_use_local_db',
        'path': 'YtdlMaterial.Database.use_local_db'
    },
    'ytdl_remote_db_type': {
        'key': 'ytdl_remote_db_type',
        'path': 'YtdlMaterial.Database.remote_db_type'
    },
    'ytdl_mongodb_connection_string': {
        'key': 'ytdl_mongodb_connection_string',
        'path': 'YtdlMaterial.Database.mongodb_connection_string'
    },
    'ytdl_postgresdb_connection_string': {
        'key': 'ytdl_postgresdb_connection_string',
        'path': 'YtdlMaterial.Database.postgresdb_connection_string'
    },
    'ytdl_redis_connection_string': {
        'key': 'ytdl_redis_connection_string',
        'path': 'YtdlMaterial.Database.redis_connection_string'
    },
    'ytdl_db_migrate': {
        'key': 'ytdl_db_migrate',
        'path': 'YtdlMaterial.Database.db_migrate'
    },

    // Advanced
    'ytdl_default_downloader': {
        'key': 'ytdl_default_downloader',
        'path': 'YtdlMaterial.Advanced.default_downloader'
    },
    'ytdl_use_default_downloading_agent': {
        'key': 'ytdl_use_default_downloading_agent',
        'path': 'YtdlMaterial.Advanced.use_default_downloading_agent'
    },
    'ytdl_custom_downloading_agent': {
        'key': 'ytdl_custom_downloading_agent',
        'path': 'YtdlMaterial.Advanced.custom_downloading_agent'
    },
    'ytdl_multi_user_mode': {
        'key': 'ytdl_multi_user_mode',
        'path': 'YtdlMaterial.Advanced.multi_user_mode'
    },
    'ytdl_allow_advanced_download': {
        'key': 'ytdl_allow_advanced_download',
        'path': 'YtdlMaterial.Advanced.allow_advanced_download'
    },
    'ytdl_use_cookies': {
        'key': 'ytdl_use_cookies',
        'path': 'YtdlMaterial.Advanced.use_cookies'
    },
    'ytdl_jwt_expiration': {
        'key': 'ytdl_jwt_expiration',
        'path': 'YtdlMaterial.Advanced.jwt_expiration'
    },
    'ytdl_logger_level': {
        'key': 'ytdl_logger_level',
        'path': 'YtdlMaterial.Advanced.logger_level'
    }
};

exports.AVAILABLE_PERMISSIONS = [
    'filemanager',
    'settings',
    'subscriptions',
    'sharing',
    'advanced_download',
    'downloads_manager',
    'tasks_manager'
];

exports.DETAILS_BIN_PATH = 'appdata/youtube-dl.json'
exports.OUTDATED_YOUTUBEDL_VERSION = "2020.00.00";

// args that have a value after it (e.g. -o <output> or -f <format>)
const YTDL_ARGS_WITH_VALUES = [
    '--default-search',
    '--config-location',
    '--proxy',
    '--socket-timeout',
    '--source-address',
    '--geo-verification-proxy',
    '--geo-bypass-country',
    '--geo-bypass-ip-block',
    '--playlist-start',
    '--playlist-end',
    '--playlist-items',
    '--match-title',
    '--reject-title',
    '--max-downloads',
    '--min-filesize',
    '--max-filesize',
    '--date',
    '--datebefore',
    '--dateafter',
    '--min-views',
    '--max-views',
    '--match-filter',
    '--age-limit',
    '--download-archive',
    '-r',
    '--limit-rate',
    '-R',
    '--retries',
    '--fragment-retries',
    '--buffer-size',
    '--http-chunk-size',
    '--external-downloader',
    '--external-downloader-args',
    '-a',
    '--batch-file',
    '-o',
    '--output',
    '--output-na-placeholder',
    '--autonumber-start',
    '--load-info-json',
    '--cookies',
    '--cache-dir',
    '--encoding',
    '--user-agent',
    '--referer',
    '--add-header',
    '--sleep-interval',
    '--max-sleep-interval',
    '-f',
    '--format',
    '--merge-output-format',
    '--sub-format',
    '--sub-lang',
    '-u',
    '--username',
    '-p',
    '--password',
    '-2',
    '--twofactor',
    '--video-password',
    '--ap-mso',
    '--ap-username',
    '--ap-password',
    '--audio-format',
    '--audio-quality',
    '--recode-video',
    '--postprocessor-args',
    '--metadata-from-title',
    '--fixup',
    '--ffmpeg-location',
    '--exec',
    '--convert-subs'
];

exports.SUBSCRIPTION_BACKUP_PATH = 'subscription_backup.json'

// we're using a Set here for performance
exports.YTDL_ARGS_WITH_VALUES = new Set(YTDL_ARGS_WITH_VALUES);

exports.ICON_URL = 'https://i.imgur.com/IKOlr0N.png';

exports.CURRENT_VERSION = 'v4.3.2';
