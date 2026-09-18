# Documentation audit

Reviewed on **2026-09-18** against app version **1.2.0**, repository commit `b3291b8e`, and the wiki available on that date. The wiki's most recent edit was 2026-07-28, but many individual pages still described earlier behavior.

This site rewrites the retained material around the current implementation. The wiki remains a historical source; it is not imported wholesale into the build.

## Wiki disposition

| Wiki page / topic | Decision and current home |
| --- | --- |
| Home | Replace with a task-oriented [home page](../index.md) and navigation |
| Features | Retain verified capabilities and add current [features](../features.md) |
| Configuration | Replace stale tables with [configuration guidance](../getting-started/configuration.md) and generated [source defaults](../reference/configuration.md) |
| Environment Variables | Replace the old configuration-library workaround with [current variables](../reference/environment.md) |
| API | Replace shared-key query examples with [per-user Bearer tokens](../integrations/api.md) |
| RSS Feed | Retain filters; replace user-ID selection and unauthenticated private-feed examples with [RSS token behavior](../integrations/rss.md) |
| Archive | Retain the skip-history concept; replace text-file storage guidance with [database archive behavior](../usage/archive.md) |
| Categories | Retain rules and templates; replace unrestricted absolute-path advice, and add existing-file reclassification in [current category behavior](../usage/categories.md) |
| Notifications | Retain service integrations; add [custom templates and event behavior](../integrations/notifications.md) |
| Reverse Proxy Setup | Replace old ports and incomplete subpath recipes with [current proxy setup](../deployment/reverse-proxy.md) |
| Setting a MongoDB backend | Replace MongoDB-only assumptions with [all supported database choices](../deployment/databases.md) |
| Migrating between MongoDB and PostgreSQL | Retain empty-target and one-time migration rules; add explicit engine selection and [verification steps](../deployment/migration.md) |
| Update MongoDB to 8.x | Retain the need for a vendor-supported staged upgrade; do not reproduce version-specific shell/FCV recipes as universal instructions |
| Chrome Extension | Retain local installation; document [current Manifest V3 packaging](../integrations/browser.md) |
| Firefox Extension | Replace old store/Android collection assumptions with the current package, identity, and temporary-install limitations |
| iOS Shortcuts Workflow | Retire the unverified shared shortcut; use the [current API](../integrations/api.md) for a shortcut that sends Bearer headers |
| Fixing 403 errors | Retain format/runtime/cookie diagnosis; correct downloader-update behavior in [troubleshooting](../reference/troubleshooting.md) |
| Fixing 429 errors | Retain pacing and waiting; replace the old interval setting and cookie-extension links |
| Synology | Retain the useful firewall diagnosis in [NAS and ARM hosts](../deployment/platforms.md) |
| unRAID | Replace pre-release/MongoDB-only instructions with current storage and database guidance |
| Raspberry Pi 4 | Retire the old 32-bit image and MongoDB 4 workaround as a new-install recipe |
| Contributing | Replace obsolete CLI and incomplete architecture sections with [current development](contributing.md) |
| Translate | Retain XLIFF workflow; use current extraction scripts and avoid assuming an external translation service tracks this fork |

## Added coverage and implementation evidence

| Area | Primary implementation checked | Guide |
| --- | --- | --- |
| Configuration precedence and retired settings | [Config](https://github.com/voc0der/ytdl-material/blob/main/backend/config.js), [startup](https://github.com/voc0der/ytdl-material/blob/main/backend/app.js) | [Configuration](../getting-started/configuration.md) |
| Permissions, API tokens, feed tokens, shared media | [Authentication modules](https://github.com/voc0der/ytdl-material/tree/main/backend/authentication), [API spec](https://github.com/voc0der/ytdl-material/blob/main/Public%20API%20v1.yaml) | [Accounts](../deployment/authentication.md), [API](../integrations/api.md), [RSS](../integrations/rss.md) |
| OIDC, LDAP, ownership assignment | Authentication modules and startup ownership migration | [Users, OIDC, and LDAP](../deployment/authentication.md) |
| PostgreSQL, migration, remote snapshots | [Database layer](https://github.com/voc0der/ytdl-material/blob/main/backend/db.js), [PostgreSQL adapter](https://github.com/voc0der/ytdl-material/blob/main/backend/postgres-store.js) | [Databases](../deployment/databases.md), [migration](../deployment/migration.md), [backups](../deployment/backups.md) |
| Redis and proxy trust | [Redis store](https://github.com/voc0der/ytdl-material/blob/main/backend/redis-store.js), startup and route configuration | [Databases](../deployment/databases.md), [reverse proxy](../deployment/reverse-proxy.md) |
| Download pacing, chunks, cookies, runtime selection | [Downloader](https://github.com/voc0der/ytdl-material/blob/main/backend/downloader.js), [entrypoint](https://github.com/voc0der/ytdl-material/blob/main/backend/entrypoint.sh) | [Downloads](../usage/downloads.md), [updates](../deployment/updates.md) |
| Subscription state and automatic playlists | [Subscriptions](https://github.com/voc0der/ytdl-material/blob/main/backend/subscriptions.js), [files](https://github.com/voc0der/ytdl-material/blob/main/backend/files.js), [settings model](https://github.com/voc0der/ytdl-material/blob/main/src/app/components/subscription-settings/subscription-settings.ts) | [Subscriptions](../usage/subscriptions.md) |
| Tasks, confirmations, schedules and timezones | [Task engine](https://github.com/voc0der/ytdl-material/blob/main/backend/tasks.js), [task interface](https://github.com/voc0der/ytdl-material/tree/main/src/app/components/tasks) | [Tasks](../usage/tasks.md) |
| Autoplay queue, theater, blackout, chapters, snips | [Player](https://github.com/voc0der/ytdl-material/tree/main/src/app/player), files module | [Player](../usage/player.md) |
| GPU encode/decode checks and fallback | [Transcoding](https://github.com/voc0der/ytdl-material/blob/main/backend/transcoding.js), entrypoint | [Hardware acceleration](../deployment/hardware.md) |
| Category rules and archive records | [Categories](https://github.com/voc0der/ytdl-material/blob/main/backend/categories.js), [archive](https://github.com/voc0der/ytdl-material/blob/main/backend/archive.js) | [Categories](../usage/categories.md), [Archive](../usage/archive.md) |
| Webhook templates | [Notifications](https://github.com/voc0der/ytdl-material/blob/main/backend/notifications.js) | [Notifications](../integrations/notifications.md) |
| Separate browser manifests and packages | [Extension source](https://github.com/voc0der/ytdl-material/tree/main/chrome-extension) | [Browser integration](../integrations/browser.md) |

## Limits kept visible

- Public RSS and notification links can append the backend port behind a reverse proxy. The proxy guide records this behavior rather than claiming full external-origin support.
- The default and extended Compose examples use different PostgreSQL volume targets. The database guide ties the mount to the chosen image major version.
- The generated setting table guarantees parity with registered source defaults, not live provider compatibility or the semantics of every combination of options.
- Historical hosted shortcuts, extension listings, and host-specific recipes are not treated as verified just because the wiki linked to them.
- Docker is the documented deployment baseline. The repository's Helm chart is not presented as a validated current deployment guide in this audit.

Validation of this site covers its static build, internal links, assets, navigation, and browser rendering. Database migrations, external login providers, notification services, and GPU passthrough still need testing against the operator's actual environment.
