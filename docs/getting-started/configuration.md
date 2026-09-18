# Configuration

Open **Settings** from the navigation menu. Changes show a save bar; choose **Save** to apply them. In multi-user mode, the settings permission controls access and an administrator is required to save server configuration.

## Where to find a setting

| Settings section | What it controls |
| --- | --- |
| Main | Server URL and port, multi-user mode, subscriptions, appearance |
| Downloader | Paths, filenames, metadata, custom arguments, categories, download limits, hardware processing |
| Extra | Library and player behavior, API documentation, integrations, RSS, browser extensions |
| Database | Active database, connection tests, Redis, transfers and migration |
| Notifications | Event selection and notification services |
| Advanced | Downloader selection and update channel, logging, sessions, cookies, server actions |
| Users | Registration, internal/LDAP login, OIDC status, accounts and permissions |
| Logs | Server logs for diagnosing problems |

Some controls appear only when the relevant feature is enabled. The Users section requires multi-user mode. OIDC values are shown for inspection; configure them in the server environment.

## File and environment settings

Production configuration lives at **`appdata/default.json`**, relative to the backend working directory (`/app` inside the container). The JSON root is `YtdlMaterial`. Debug mode uses `src/assets/default.json`; `YTDL_CONFIG_PATH` can override the path.

At startup, recognized environment variables are written into the saved configuration. Lowercase names are used in these guides; uppercase equivalents also work, and the lowercase value wins if both are present. Use quoted `'true'` and `'false'` in Compose.

```yaml
environment:
  ytdl_title_top: 'My media library'
  ytdl_max_concurrent_downloads: '3'
  ytdl_min_sleep_between_downloads: '5'
```

**An environment value is reapplied on every startup.** If a UI change seems to revert, check Compose or your container manager for the same setting. Removing an environment variable leaves its last saved value in the JSON file. To clear a saved connection string, set it to `''` for one startup, then remove it.

Older Compose examples include `write_ytdl_config`. Current startup code applies recognized variables without that flag; it is no longer the switch controlling persistence.

Use [environment variables](../reference/environment.md) for deployment options and [configuration defaults](../reference/configuration.md) for the complete mapping to JSON paths. Configure structured settings such as LDAP objects and notification-type arrays through the UI or JSON; environment strings are not a general JSON parser.

## Changes that need a restart

Restart after changing server binding, TLS, authentication, database selection, API documentation, or startup dependency options. Recreate the container after changing Compose environment variables:

```bash
docker compose up -d ytdl-material
```

`docker compose restart` restarts the existing container with its existing environment.
