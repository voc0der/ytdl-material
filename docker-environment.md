# Docker Environment Variables

The default [docker-compose.yml](./docker-compose.yml) now ships with PostgreSQL as the default remote database.

For a fully commented example with PostgreSQL, optional MongoDB support, OIDC, reverse proxy, and other advanced options, see [docker-compose-extended.yml](./docker-compose-extended.yml).

Docker examples here use lowercase environment variable names consistently. For user and group IDs, prefer `ytdl_uid` and `ytdl_gid`; legacy `uid`/`gid` and `UID`/`GID` aliases remain supported.

Common Docker environment variables you can use with the provided compose files:

* `ytdl_use_local_db`: set to `'false'` to use a remote database instead of the local JSON DB
* `ytdl_remote_db_type`: optional explicit remote DB engine (`postgres` or `mongo`). When omitted, PostgreSQL is preferred when `ytdl_postgresdb_connection_string` is set, otherwise MongoDB is used.
* `ytdl_postgresdb_connection_string`: PostgreSQL connection string (default compose file points to `postgresql://ytdl-material:ytdl-material@ytdl-postgres-db:5432/ytdl-material`)
* `ytdl_mongodb_connection_string`: MongoDB connection string for optional MongoDB support
* `ytdl_db_migrate`: optional one-time DB-to-DB migration mode (`postgres` to move MongoDB to PostgreSQL, `mongo` to move PostgreSQL to MongoDB). Requires both remote connection strings plus `ytdl_use_local_db='false'`.
* `write_ytdl_config`: set to `'true'` to write env-backed settings into `appdata/default.json` on startup
* `ytdl_uid` / `ytdl_gid`: app user/group IDs used inside the container (default behavior drops to `1000:1000`)
* `ytdl_log_level`: backend log level (`error`, `warn`, `info`, `verbose`, `debug`), default `info`
* `ytdl_use_api_key`: set to `'true'` to require `apiKey` for public API endpoints
* `ytdl_api_key`: public API key value used when `ytdl_use_api_key` is enabled
* `ytdl_ssl_cert_path` and `ytdl_ssl_key_path`: enable HTTPS by pointing to mounted cert/key files
* `ytdl_reverse_proxy_whitelist`: comma-separated CIDR ranges allowed to connect (reverse proxy IPs, not client IPs)
* `ytdl_trust_proxy`: override Express `trust proxy` directly (for example `true`, `false`, `1`, or a comma-separated list)
* `ytdl_umask`: set the process umask before startup (for example `'022'`)
* `ytdl_multi_user_mode`: set to `'true'` to enable user-scoped media; required when OIDC is enabled
* `ytdl_enable_documentation_api`: set to `'true'` to expose local API docs at `/docs` (requires `ytdl_use_api_key` and restart)
* `ytdl_playlist_chunk_size`: playlist batch size for automatic playlist chunking (default `20`, min `1`)
* `ytdl_warn_on_duplicate`: set to `'true'` to warn on duplicate downloads and reuse existing files in playlists instead of downloading them again (default `'false'`)
* `ytdl_max_playlist_chunks`: cap automatic playlist chunk creation (default `20`, min `1`)

## OIDC required variables

* `ytdl_oidc_enabled`: set to `'true'`
* `ytdl_oidc_issuer_url`: OIDC issuer URL
* `ytdl_oidc_client_id`: OIDC client ID
* `ytdl_oidc_client_secret`: OIDC client secret
* `ytdl_oidc_redirect_uri`: callback URL (must end with `/api/auth/oidc/callback`)

## OIDC optional variables

* `ytdl_oidc_scope` (default `openid profile email`)
* `ytdl_oidc_allowed_groups` (comma-separated allow-list)
* `ytdl_oidc_group_claim` (default `groups`)
* `ytdl_oidc_admin_claim` / `ytdl_oidc_admin_value` (defaults `groups` / `admin`)
* `ytdl_oidc_auto_register` (default `'true'`)
* `ytdl_oidc_username_claim` / `ytdl_oidc_display_name_claim`
* `ytdl_oidc_migrate_videos`: optional one-time startup migration target (uid or username) for unassigned media ownership

## Example `docker-compose-extended.yml` environment block

```yaml
environment:
  ytdl_use_local_db: 'false'
  ytdl_remote_db_type: 'postgres'
  ytdl_postgresdb_connection_string: 'postgresql://ytdl-material:ytdl-material@ytdl-postgres-db:5432/ytdl-material'
  # ytdl_mongodb_connection_string: 'mongodb://ytdl-mongo-db:27017'
  # ytdl_db_migrate: 'postgres'
  write_ytdl_config: 'true'
  # ytdl_uid: 1000
  # ytdl_gid: 1000
  # ytdl_log_level: debug
  # ytdl_use_api_key: 'true'
  # ytdl_api_key: 'replace-with-api-key'
  # ytdl_enable_documentation_api: 'true'
  # ytdl_ssl_cert_path: /mnt/keys/fullchain.pem
  # ytdl_ssl_key_path: /mnt/keys/privkey.pem
  # ytdl_reverse_proxy_whitelist: 172.28.0.100/32
  # ytdl_trust_proxy: '1'
  # ytdl_umask: '022'
  # ytdl_multi_user_mode: 'true'
  # ytdl_playlist_chunk_size: '20'
  # ytdl_warn_on_duplicate: 'false'
  # ytdl_max_playlist_chunks: '20'
  # ytdl_oidc_enabled: 'true'
  # ytdl_oidc_issuer_url: 'https://idp.example.com/realms/ytdl'
  # ytdl_oidc_client_id: 'ytdl-material'
  # ytdl_oidc_client_secret: 'replace-with-secret'
  # ytdl_oidc_redirect_uri: 'https://ytdl.example.com/api/auth/oidc/callback'
  # ytdl_oidc_scope: 'openid profile email'
  # ytdl_oidc_allowed_groups: 'media,admins'
  # ytdl_oidc_group_claim: 'groups'
  # ytdl_oidc_admin_claim: 'groups'
  # ytdl_oidc_admin_value: 'admin'
  # ytdl_oidc_auto_register: 'true'
  # ytdl_oidc_username_claim: 'preferred_username'
  # ytdl_oidc_display_name_claim: 'name'
  # ytdl_oidc_migrate_videos: 'admin'
```

Prefer using Docker's `user: "<uid>:<gid>"` together with `ytdl_uid`/`ytdl_gid`.

When `ytdl_oidc_enabled` is `'true'`, `ytdl_multi_user_mode` must also be `'true'` or backend startup will fail.

For local JSON to PostgreSQL, set `ytdl_use_local_db='false'` and provide `ytdl_postgresdb_connection_string`. For local JSON to MongoDB, set `ytdl_use_local_db='false'` and provide `ytdl_mongodb_connection_string`.
