# Environment variables

Add these under the app service's `environment` in Compose. Quote boolean and numeric values. Recreate the container with `docker compose up -d ytdl-material` after editing it.

The [complete configuration mapping](configuration.md) is generated from the backend's setting registry and defaults. This page explains the deployment variables and options most likely to need context.

## Startup and container behavior

| Variable | Purpose / default |
| --- | --- |
| `ytdl_uid`, `ytdl_gid` | App user and group; container defaults to `1000:1000` |
| `ytdl_umask` | File creation mask; for example `'022'` or `'002'` |
| `ytdl_log_level` | Logging override: `error`, `warn`, `info`, `verbose`, `debug`; overrides the saved log-level setting |
| `ytdl_trust_proxy` | Real visitor IP from behind a reverse proxy: number of proxies in front (usually `'1'`), or their IPs/subnets, comma-separated |
| `ytdl_max_playlist_chunks` | Maximum automatic playlist chunks; default `20`, minimum `1` |
| `ytdl_enable_ytdlp_impersonation_dependencies` | Installs optional impersonation support, exposes the setting, and enables it in newly created configs |
| `ytdl_oidc_migrate_videos` | Startup ownership assignment for unowned files/playlists to an existing account; remove after use |
| `YTDL_CONFIG_PATH` | Overrides the backend configuration-file path |
| `YTDL_MODE` | `debug` selects the development configuration and local frontend URL |

The first seven options are consumed directly by startup/runtime code rather than all being ordinary saved settings. `YTDL_CONFIG_PATH` and `YTDL_MODE` use their uppercase names exactly.

`write_ytdl_config` remains in some Compose examples for historical compatibility. Current startup writes recognized config environment values regardless of that flag.

## Server and database

| Variable | Default | Notes |
| --- | --- | --- |
| `ytdl_url` | `http://example.com` | Host URL used by the app; see the [public-link limitation](../deployment/reverse-proxy.md#public-urls-and-oidc) |
| `ytdl_port` | `17442` | Backend listening port |
| `ytdl_ssl_cert_path`, `ytdl_ssl_key_path` | Unset | Mounted files for direct HTTPS |
| `ytdl_reverse_proxy_whitelist` | Unset | Allowed proxy peers, comma-separated IPs/CIDRs |
| `ytdl_use_local_db` | `true` | Compose overrides it to `false` |
| `ytdl_remote_db_type` | Empty | Explicit `postgres` or `mongo` |
| `ytdl_postgresdb_connection_string` | Empty | PostgreSQL connection URI |
| `ytdl_mongodb_connection_string` | Local MongoDB URI | MongoDB connection URI |
| `ytdl_redis_connection_string` | Empty | Optional shared rate-limiter store |
| `ytdl_db_migrate` | Empty | One-time remote migration target: `postgres` or `mongo` |

See [databases](../deployment/databases.md) and [migration](../deployment/migration.md) before changing the engine or connection strings on a populated installation.

## Downloads

| Variable | Default | Notes |
| --- | --- | --- |
| `ytdl_max_concurrent_downloads` | `5` | Simultaneous download limit |
| `ytdl_min_sleep_between_downloads` | `0` | Seconds before the next queued step |
| `ytdl_playlist_chunk_size` | `20` | Automatic batch size, minimum 1 |
| `ytdl_warn_on_duplicate` | `false` | Duplicate warning and playlist reuse behavior |
| `ytdl_custom_args` | Empty | Arguments separated by `,,` |
| `ytdl_js_runtimes` | Empty | Leave auto-detection enabled unless pinning an installed runtime |
| `ytdl_use_ytdlp_impersonation` | `false` | Uses optional impersonation support when installed |
| `ytdl_ytdlp_update_channel` | `stable` | `stable`, `nightly`, or `master` |
| `ytdl_transcoding` | `false` | Software, or `vaapi`, `qsv`, `nvenc`, `amf` |
| `ytdl_use_cookies` | `false` | Uses the uploaded cookie file |

Folder paths, filename normalization, metadata, thumbnails, archive settings, notification variables, and other options are listed in [configuration defaults](configuration.md).

## Accounts and integrations

| Variable | Purpose |
| --- | --- |
| `ytdl_multi_user_mode` | Enables accounts and authentication; default `false` |
| `ytdl_allow_registration` | Enables internal self-registration; default `true` |
| `ytdl_auth_method` | `internal` or `ldap` |
| `ytdl_oidc_enabled` and `ytdl_oidc_*` | [OIDC setup and claim mapping](../deployment/authentication.md#openid-connect) |
| `ytdl_enable_documentation_api` | Serves `/docs` and `/openapi.yaml`; restart required |
| `ytdl_enable_rss_feed` | Enables `/api/rss`; default `false` |

For saved settings, lowercase and uppercase environment names are accepted. Lowercase wins if both are defined. A UI change to an environment-controlled setting lasts only until the next startup reapplies the environment.

Structured objects and arrays should be edited through the UI or JSON configuration. Passing a serialized object as an environment variable does not generally parse it into the setting's expected type.
