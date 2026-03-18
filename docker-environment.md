# Docker Environment Variables

The default [docker-compose.yml](./docker-compose.yml) now ships with PostgreSQL as the default remote database.

For a fully commented example with PostgreSQL, optional MongoDB support, OIDC, reverse proxy, and other advanced options, see [docker-compose-extended.yml](./docker-compose-extended.yml).

Docker examples here use lowercase environment variable names consistently.

## Common Variables

These apply to many Docker setups regardless of which database or login method you choose:

* `write_ytdl_config`: set to `'true'` to write env-backed settings into `appdata/default.json` on startup
* `ytdl_uid` / `ytdl_gid`: app user/group IDs used inside the container
* `ytdl_log_level`: backend log level (`error`, `warn`, `info`, `verbose`, `debug`), default `info`
* `ytdl_umask`: set the process umask before startup (for example `'022'`)

For most setups, prefer Docker's `user: "<uid>:<gid>"` directly in your compose file together with `ytdl_uid` and `ytdl_gid` for clearer container isolation and ownership behavior.

## Database Variables

If you use the provided default compose files, PostgreSQL is already wired up for you. If you want to stay on the local JSON database, you can skip most of this section.

### Core Variables

* `ytdl_use_local_db`: set to `'false'` to use a remote database instead of the local JSON DB
* `ytdl_remote_db_type`: optional explicit remote DB engine (`postgres` or `mongo`). When omitted, PostgreSQL is preferred when `ytdl_postgresdb_connection_string` is set, otherwise MongoDB is used.

### PostgreSQL

* `ytdl_postgresdb_connection_string`: PostgreSQL connection string (the default compose file points to `postgresql://PlaceholderUser:PlaceholderPassword@ytdl-postgres-db:5432/PlaceholderDB`)

Example:

```yaml
environment:
  ytdl_use_local_db: 'false'
  ytdl_remote_db_type: 'postgres'
  ytdl_postgresdb_connection_string: 'postgresql://PlaceholderUser:PlaceholderPassword@ytdl-postgres-db:5432/PlaceholderDB'
  write_ytdl_config: 'true'
```

### MongoDB

* `ytdl_mongodb_connection_string`: MongoDB connection string for optional MongoDB support

Example:

```yaml
environment:
  ytdl_use_local_db: 'false'
  ytdl_remote_db_type: 'mongo'
  ytdl_mongodb_connection_string: 'mongodb://ytdl-mongo-db:27017'
  write_ytdl_config: 'true'
```

### Database Migration

* `ytdl_db_migrate`: optional one-time DB-to-DB migration mode (`postgres` to move MongoDB to PostgreSQL, `mongo` to move PostgreSQL to MongoDB). Requires both remote connection strings plus `ytdl_use_local_db='false'`.

For local JSON to PostgreSQL, set `ytdl_use_local_db='false'` and provide `ytdl_postgresdb_connection_string`. For local JSON to MongoDB, set `ytdl_use_local_db='false'` and provide `ytdl_mongodb_connection_string`.

On startup, if the configured remote database is empty and the local DB contains records, ytdl-material will copy the local DB into that remote database automatically.

A successful DB-to-DB migration clears the config setting automatically, but you should still remove `ytdl_db_migrate` from your environment so it is not reapplied on the next boot.

## Redis Variables

Redis is optional. It is only used for shared Express rate-limiter state.

* `ytdl_redis_connection_string`: optional Redis connection string (`redis://` or `rediss://`)

If `ytdl_redis_connection_string` is configured, ytdl-material will attempt to use Redis during startup. If Redis is unreachable or the connection string is invalid, the backend logs a warning, continues with the default in-memory limiter store, and keeps retrying the Redis connection in the background until Redis becomes available.

When using env-managed Docker setups with `write_ytdl_config='true'`, you can clear a previously written Redis connection string by setting `ytdl_redis_connection_string=''` for one startup, then removing the line entirely afterward.

## Public API Variables

* `ytdl_use_api_key`: set to `'true'` to require `apiKey` for public API endpoints
* `ytdl_api_key`: public API key value used when `ytdl_use_api_key` is enabled
* `ytdl_enable_documentation_api`: set to `'true'` to expose local API docs at `/docs` (requires `ytdl_use_api_key` and restart)

## HTTPS and Reverse Proxy Variables

* `ytdl_ssl_cert_path` and `ytdl_ssl_key_path`: enable HTTPS by pointing to mounted cert/key files
* `ytdl_reverse_proxy_whitelist`: comma-separated CIDR ranges allowed to connect (reverse proxy IPs, not client IPs)
* `ytdl_trust_proxy`: override Express `trust proxy` directly (for example `true`, `false`, `1`, or a comma-separated list)

## Download and Playlist Variables

* `ytdl_playlist_chunk_size`: playlist batch size for automatic playlist chunking (default `20`, min `1`)
* `ytdl_warn_on_duplicate`: set to `'true'` to warn on duplicate downloads and reuse existing files in playlists instead of downloading them again (default `'false'`)
* `ytdl_max_playlist_chunks`: cap automatic playlist chunk creation (default `20`, min `1`)

## OIDC

Only use this section if you want users to sign in through an external identity provider such as Authelia, Authentik, Keycloak, or another SSO provider. If you are happy with ytdl-material's built-in login, you do not need any OIDC settings.

### Required Variables

* `ytdl_multi_user_mode`: set to `'true'`
* `ytdl_oidc_enabled`: set to `'true'`
* `ytdl_oidc_issuer_url`: issuer URL for your provider
* `ytdl_oidc_client_id`: OIDC client ID
* `ytdl_oidc_client_secret`: OIDC client secret
* `ytdl_oidc_redirect_uri`: callback URL (must end with `/api/auth/oidc/callback`)

When `ytdl_oidc_enabled` is `'true'`, `ytdl_multi_user_mode` must also be `'true'` or backend startup will fail.

### Optional Variables

* `ytdl_oidc_scope`: scopes to request from the provider (default `openid profile email`)
* `ytdl_oidc_allowed_groups`: comma-separated allow-list
* `ytdl_oidc_group_claim`: claim containing group membership (default `groups`)
* `ytdl_oidc_admin_claim`: claim used to detect admin users (default `groups`)
* `ytdl_oidc_admin_value`: value inside the admin claim that grants admin access (default `admin`)
* `ytdl_oidc_auto_register`: set to `'false'` to require users to already exist locally before OIDC login (default `'true'`)
* `ytdl_oidc_username_claim`: claim used for the local username/uid (default `preferred_username`)
* `ytdl_oidc_display_name_claim`: claim used for the local display name (default `preferred_username`)
* `ytdl_oidc_migrate_videos`: optional one-time startup migration target (uid or username) for unassigned media ownership

### Example: ytdl-material Env Block for Authelia

This is a realistic example of the ytdl-material side when Authelia is your identity provider:

```yaml
environment:
  ytdl_multi_user_mode: 'true'
  ytdl_oidc_enabled: 'true'
  ytdl_oidc_issuer_url: 'https://auth.mydomain.com'
  ytdl_oidc_client_id: 'r7k2p9v4m8q1x6t3n5w2z0fjchangeme'
  ytdl_oidc_client_secret: 'replace-with-the-plain-client-secret'
  ytdl_oidc_redirect_uri: 'https://ytdl.mydomain.com/api/auth/oidc/callback'
  ytdl_oidc_scope: 'openid profile email groups'
  ytdl_oidc_allowed_groups: 'media,admins'
  ytdl_oidc_group_claim: 'groups'
  ytdl_oidc_admin_claim: 'groups'
  ytdl_oidc_admin_value: 'admin'
  ytdl_oidc_username_claim: 'preferred_username'
  ytdl_oidc_display_name_claim: 'preferred_username'
```

### Matching Authelia `configuration.yml` Client Example

ytdl-material already uses authorization code flow with PKCE S256 and `client_secret_post`, so the following Authelia client definition lines up with the env block above:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: 'r7k2p9v4m8q1x6t3n5w2z0fjchangeme'
        client_name: 'ytdl-material'
        client_secret: '$pbkdf2-sha512$310000$J8m2Qx7nP4vK9sT1cW6yRg$A5mL9xQv2fT8pJ4nR7wK1zYc6uB3dE0hN5sV2qX8tM4yP7rL1kC9wF6gH3jD8uS2'
        public: false
        authorization_policy: two_factor
        require_pkce: true
        pkce_challenge_method: S256
        consent_mode: implicit
        pre_configured_consent_duration: 1M
        redirect_uris:
          - 'https://ytdl.mydomain.com/api/auth/oidc/callback'
        scopes:
          - openid
          - profile
          - email
          - groups
        response_types:
          - code
        grant_types:
          - authorization_code
        access_token_signed_response_alg: none
        userinfo_signed_response_alg: none
        token_endpoint_auth_method: client_secret_post
```

If your Authelia client stores a hashed secret in `configuration.yml`, set `ytdl_oidc_client_secret` in ytdl-material to the original plain client secret value for that client, not the stored hash.
