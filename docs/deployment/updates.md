# Updates

The app image and the yt-dlp binary have separate release cycles. Changing one does not select the other's channel.

## Update the app

Back up the database and media configuration, read the [release notes](https://github.com/voc0der/ytdl-material/releases), then update only the app service:

```bash
docker compose pull ytdl-material
docker compose up -d --no-deps ytdl-material
docker compose logs --tail=100 ytdl-material
```

Verify sign-in, a library item, and subscription/task state after startup. The app checks subscriptions during startup as well as through their schedule, so expect activity unless they are paused.

Use a published version tag or recorded image digest when you need to reproduce a particular build. Keep the previous image reference with your backup for recovery. A rollback of the container is not necessarily a rollback of database or configuration changes.

Do not unintentionally upgrade PostgreSQL or MongoDB by pulling every service with floating tags. Upgrade database majors separately using their supported process.

## Update yt-dlp

The app checks the downloader at startup. You can also use its update task from **Tasks**. Select its channel under **Settings → Advanced**, or through:

```yaml
environment:
  ytdl_ytdlp_update_channel: 'nightly'
```

| Channel | Purpose |
| --- | --- |
| `stable` | Default released yt-dlp builds |
| `nightly` | More recent upstream fixes |
| `master` | Upstream development builds |

Recreate the container after changing the environment. An unrecognized channel is rejected and the existing binary is retained.

When browser impersonation is enabled, startup installs yt-dlp with its Python dependencies. That path uses PyPI prereleases for nightly; `master` falls back to nightly because PyPI does not provide that channel.

An app image tagged `latest` still uses stable yt-dlp unless you select another channel. Conversely, pulling an image alone is not a reliable way to test a particular downloader version; inspect the version and startup logs.

## Retired settings

The shared API key, server-wide advanced-download visibility switch, and fixed extractor-client fallback have been removed. The abandoned legacy downloader fork is migrated to yt-dlp. Use [API tokens](../integrations/api.md), role permissions, and current downloader options instead of restoring those old settings.
