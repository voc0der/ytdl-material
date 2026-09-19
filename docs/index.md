# Your media, in your library

Download video and audio, follow channels and playlists, and play what you save from your own server. ytdl-material brings yt-dlp, a searchable library, and scheduled downloads into one web interface.
{ .docs-intro }

[Get started](getting-started/quick-start.md){ .md-button .md-button--primary }
[Explore the features](features.md){ .md-button }
[Gallery](gallery.md){ .md-button }

![The ytdl-material library, with video thumbnails and upload-date sorting](images/readme-home.png){ .library-preview }

## Find your way

<div class="grid cards" markdown>

- **Set up your server**

    Start with Docker, connect storage, and choose how people sign in.

    [Installation](getting-started/quick-start.md) · [Configuration](getting-started/configuration.md) · [Users and SSO](deployment/authentication.md)

- **Build your library**

    Save a link, organize files, and let subscriptions collect new uploads.

    [Downloads](usage/downloads.md) · [Subscriptions](usage/subscriptions.md) · [Player](usage/player.md)

- **Keep it running**

    Back up your files and database, schedule maintenance, and update the app.

    [Backups](deployment/backups.md) · [Tasks](usage/tasks.md) · [Updates](deployment/updates.md)

- **Connect other tools**

    Send downloads through the API and receive notifications or RSS updates.

    [API tokens](integrations/api.md) · [Notifications](integrations/notifications.md) · [RSS](integrations/rss.md)

</div>

## Coming from an older installation?

Start with [migration](deployment/migration.md). The current app supports PostgreSQL, MongoDB, and local JSON storage; API clients use per-user Bearer tokens; and subscription checks are scheduled from **Tasks**.

These guides describe the current repository, reviewed against **v1.2.0**. The [documentation audit](development/audit.md) records which wiki material was retained, rewritten, or retired. See [releases](https://github.com/voc0der/ytdl-material/releases) for changes between versions.

## Need help?

Check [troubleshooting](reference/troubleshooting.md) for failed downloads, permissions, login, and database problems. If you report a bug, include the app version, deployment method, and relevant logs with credentials removed.

[Source code](https://github.com/voc0der/ytdl-material) · [Report an issue](https://github.com/voc0der/ytdl-material/issues) · [Contribute](development/contributing.md)
