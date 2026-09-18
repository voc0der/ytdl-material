# Features

## Download and automate

- Save video or audio from links supported by yt-dlp.
- Select quality, audio language, and available subtitles before downloading.
- Process playlists in batches and control concurrency, bandwidth, and spacing between queued downloads.
- Use cookies, custom arguments, and optional browser impersonation when a source requires them.
- Subscribe to channels and playlists with a quality limit, date range, custom output, and optional automatic playlist.
- Check subscriptions manually or on a schedule, and pause subscriptions without removing their files.

[Start downloading](usage/downloads.md) · [Set up subscriptions](usage/subscriptions.md)

## Browse, play, and organize

- Search and filter your library by media type, favorites, categories, and subscriptions.
- Sort by upload date or when an item entered the library.
- Build playlists and continue playback through the player's Autoplay queue.
- Use available chapters and subtitles, theater mode, and video blackout for listening.
- Save a selected time range from a library item as a new snip, or crop a new download before it enters the library.
- Share individual files or playlists with a link.
- Apply rule-based categories and custom filenames, and manage download history through the Archive.

[Library](usage/library.md) · [Player](usage/player.md) · [Categories](usage/categories.md)

## Run it your way

| Area | Available choices |
| --- | --- |
| Installation | Docker on amd64/arm64, or a local source build |
| Database | PostgreSQL, MongoDB, or local JSON |
| Accounts | Single-user mode, internal accounts, LDAP, or OpenID Connect |
| Processing | Software ffmpeg, VAAPI, QSV, NVENC, or AMF when supported by the host |
| Automation | Scheduled tasks, per-user API tokens, RSS feeds |
| Notifications | In-app alerts, custom webhooks, Discord, Slack, Telegram, Gotify, ntfy |
| Browser integration | Chromium package, Firefox package, bookmarklet |

Feature availability also depends on the administrator's settings, your account permissions, and what the source provides. Selecting subtitles or a quality level cannot create tracks or formats that are absent upstream.
