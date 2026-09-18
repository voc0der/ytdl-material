# Users, OIDC, and LDAP

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
