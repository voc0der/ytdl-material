# FAQ

## Do I need an upstream API key to download a link?

No. Direct downloads use yt-dlp. The optional search integration has its own API key; it is separate from the tokens scripts use to access your instance.

## Which database is the default?

The supplied Docker Compose deployment uses PostgreSQL. An app started without those environment settings defaults to local JSON. MongoDB remains supported. See [databases](../deployment/databases.md).

## Where do I change the subscription interval?

Schedule **Check subscriptions** on the **Tasks** page. The old subscription-interval environment setting is no longer used.

## Why did a deleted subscription item come back?

It was still eligible and no longer marked as downloaded. Keep its [Archive](../usage/archive.md) entry when deleting it if you want future checks to skip it.

## Does a date range delete older downloads?

No. It filters what a subscription downloads. Configure and review **Delete old files** for retention.

## Is a database backup enough?

No. It contains records, not media. Back up configuration and all media mounts too. See [backups](../deployment/backups.md).

## Can a feed reader authenticate with a token in the URL?

No. Private feeds require an Authorization Bearer header. Use a reader that supports custom headers and generate an RSS token in the feed dialog.

## Does the latest app image include the newest nightly downloader?

No. The downloader defaults to stable. Select its channel explicitly under Advanced settings or with `ytdl_ytdlp_update_channel`.

## Why does a button disappear for one account?

The feature may be disabled globally or the account may lack its permission. The same permission checks also apply to API requests. See [users](../deployment/authentication.md).

## Can I run the app under a URL subpath?

Use a dedicated hostname for the documented setup. Root-level API, asset, and authentication paths make the historical subpath snippets incomplete for the current app.

## What is the difference between crop and snip?

A snip creates another library item from a selected time range and retains the source. The Home page's advanced **Crop file** option trims a new download before adding it to the library. See [player and editing](../usage/player.md).
