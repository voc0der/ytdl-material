# Users and sign-in

## Single-user and multi-user modes

Single-user mode has no login barrier. Anyone who can reach the app can use its administrative functions. Enable **Settings → Main → Multi-user mode** when you need separate accounts and libraries.

Complete the initial administrator-password dialog, then sign in as `admin`. Under **Settings → Users**, decide whether to allow registration and create or manage other accounts. Existing single-user media is not automatically assigned to every new account.

Roles and per-user overrides control file management, settings access, subscriptions, sharing, advanced downloads, the download manager, and the task manager. These permissions are enforced on the backend as well as in the interface. Saving server configuration, user management, database administration, and server control require an administrator even if another account can open Settings.

## OpenID Connect

OIDC requires multi-user mode and a reachable identity provider. Register a confidential web client with authorization-code flow, **PKCE S256**, and **`client_secret_post`** authentication. Set its redirect URI to exactly match the app configuration:

```yaml
environment:
  ytdl_multi_user_mode: 'true'
  ytdl_oidc_enabled: 'true'
  ytdl_oidc_issuer_url: 'https://id.example.com'
  ytdl_oidc_client_id: 'ytdl-material'
  ytdl_oidc_client_secret: 'REPLACE_WITH_CLIENT_SECRET'
  ytdl_oidc_redirect_uri: 'https://media.example.com/api/auth/oidc/callback'
  ytdl_oidc_scope: 'openid profile email'
  ytdl_oidc_auto_register: 'true'
```

Use the provider's actual issuer URL, including a realm path if it has one. The app discovers the provider at startup. Missing required fields or provider initialization failures can prevent startup; inspect the server log if the container exits.

For Authelia clients with a hashed secret stored on the provider, put the original **plain client secret** in the app's `ytdl_oidc_client_secret`, not the provider's stored hash.

### Claims and access

| Variable | Default / purpose |
| --- | --- |
| `ytdl_oidc_username_claim` | `preferred_username`; identity/name mapping |
| `ytdl_oidc_display_name_claim` | `preferred_username`; displayed name |
| `ytdl_oidc_group_claim` | `groups`; claim used for the allowed-group check |
| `ytdl_oidc_allowed_groups` | Empty allows all otherwise valid provider accounts; comma-separated groups restrict access |
| `ytdl_oidc_admin_claim` | `groups`; claim used for administrator mapping |
| `ytdl_oidc_admin_value` | `admin`; matching value grants the administrator role |
| `ytdl_oidc_auto_register` | `true`; creates app accounts for accepted new identities |

Your provider must actually issue the claims you select. If groups need an additional scope, add it to both the client registration and `ytdl_oidc_scope`. Test an ordinary account as well as an administrator to verify both mappings.

OIDC state in **Settings → Users** is read-only and shows whether provider discovery succeeded. Change the environment and recreate the container to update it.

### Assign unowned media

`ytdl_oidc_migrate_videos` can assign unowned files and playlists to an existing user's UID or name at startup. Create the target account first, back up the database, set the variable to that account, and inspect the migration log. Remove the variable after the intended assignment.

This operation concerns unassigned files and playlists. It does not move all user data, reassign other users' media, or migrate subscriptions wholesale.

## Reverse proxy header sign-in

A forward-auth proxy such as Authelia, Authentik, or oauth2-proxy can sign people in before they reach the app and pass on who they are in a header. With header sign-in on, the app signs each request's named user in to the account with that user ID. It is off by default.

```yaml
environment:
  ytdl_multi_user_mode: 'true'
  ytdl_header_auth_enabled: 'true'
  ytdl_header_auth_trusted_proxies: '172.28.0.10'
  ytdl_header_auth_admin_users: 'alice'
```

| Variable | Default / purpose |
| --- | --- |
| `ytdl_header_auth_enabled` | `false`; turns header sign-in on |
| `ytdl_header_auth_trusted_proxies` | Required: comma-separated IPs or CIDR ranges of the proxy that sets the header. Host names, and ranges that cover every address such as `0.0.0.0/0`, are refused |
| `ytdl_header_auth_user_header` | `Remote-User`; the header that names the user, for example `X-authentik-username` for Authentik |
| `ytdl_header_auth_auto_register` | `true`; creates an account for a name that has none yet. When `false`, only existing accounts can sign in |
| `ytdl_header_auth_admin_users` | Empty; comma-separated names that are administrators. Applied at every sign-in: listed names become administrators, everyone else an ordinary user |

The server does not start if header sign-in is enabled together with OIDC or LDAP, without multi-user mode, or without a usable list of trusted proxies; the server log says which. While it is on, password sign-in and registration are disabled. **Settings → Users** shows the setup read-only, with the header and value the page's own request arrived with, and the address it came from.

### Keep the header trustworthy

Whoever can send the header from a trusted address can sign in as anyone, so:

- **List only the proxy.** The app checks the address of the connection itself and ignores `X-Forwarded-For`. Prefer the proxy's fixed address on a Docker network that only it and the app share: every address in a listed range is trusted.
- **Leave no way around the proxy.** Remove the app's published port, or publish it on `127.0.0.1` only when the proxy runs on the host. `ytdl_reverse_proxy_whitelist` can refuse every other connection as well.
- **Have the proxy set the header on every request**, replacing any value the browser sent. A request that carries the header twice is refused.
- **Names must equal a user ID exactly**, including case, and can only contain letters, digits, and `. _ @ -`. An existing account with that ID is signed in to, whatever its sign-in method, and keeps its password for when header sign-in is off again. If your identity provider lets people pick their own user name, someone could register the name of an existing account and receive it.

With Nginx and `auth_request`, copy the name from the authentication response into the header. `proxy_set_header` replaces whatever the browser sent, and sends nothing when the value is empty:

```nginx
location / {
    auth_request /internal/authelia/authz;
    auth_request_set $user $upstream_http_remote_user;
    proxy_set_header Remote-User $user;
    proxy_pass http://ytdl-material:17442;
}
```

With Traefik's `forwardAuth` or Caddy's `forward_auth`, list the header among the response headers copied to the request (`authResponseHeaders`, `copy_headers`). Check your provider's documentation for the authentication endpoint and the header it returns.

### Limits

- Signing out of the app does not sign you out of the proxy, so the next visit signs you straight back in. Sign out at the identity provider.
- Deleting an account does not stop its owner signing in again: with `ytdl_header_auth_auto_register` on, their next visit creates a new one. Remove their access at the proxy.
- API tokens, RSS feeds, and share links do not use the header. If the proxy guards every path, those clients need a rule that lets them through to the paths they use.

## LDAP

Enable multi-user mode, select `ldap` as the auth method in **Settings → Users**, and fill in:

| Field | Example |
| --- | --- |
| LDAP URL | `ldaps://directory.example.com:636` |
| Bind DN | `cn=media-reader,ou=services,dc=example,dc=com` |
| Bind credentials | Service-account password |
| Search base | `ou=people,dc=example,dc=com` |
| Search filter | `(uid={{username}})` |

The backend binds as the service account, finds the user, then binds as that user to check the password. The returned directory entry must have a usable `uid`. Missing or path-unsafe UIDs are rejected because user IDs also identify storage directories.

LDAP users receive app accounts on first successful login. Manage their app permissions in ytdl-material; LDAP group-to-role mapping is not implemented. Local accounts remain available through the local login strategy.

For additional TLS or connection options, edit the structured `Users.ldap_config` in the JSON configuration. Do not pass a JSON string through `ytdl_ldap_config` and assume it will become an object. Deprecated group-search, cache, and reconnect options are ignored with a warning.
