# Downloads

## Save a link

Paste a media URL on **Home**, choose video or audio, set the quality, and select **Download**. When available, choose an audio language and subtitles. These choices depend on the formats and tracks offered by the source.

Open the Download button menu for advanced options. They are available to accounts with the `advanced_download` permission; the old server-wide advanced-download toggle has been removed.

The app can also search upstream when the administrator has enabled the search integration and configured its API key. A direct URL does not need that search key.

## Follow progress

The **Downloads** page shows queued, running, completed, and failed work. Inspect a failed download's error before retrying it. Cancellation stops the associated downloader processes; removing an entry from history is separate from managing the saved media in your library.

Playlist URLs may create several batches. The defaults are **20 items per chunk** and a maximum of **20 automatically created chunks**. That cap can leave a large playlist only partially queued; increase `ytdl_max_playlist_chunks` when you intentionally want more, or use a subscription for recurring collection.

## Control load

In **Settings → Downloader**, adjust:

| Setting | Effect |
| --- | --- |
| Max concurrent downloads | Limits simultaneous downloads; default 5 |
| Minimum sleep between downloads | Adds seconds before the next queued step; default 0 |
| Download rate limit | Passes a bandwidth limit to the downloader |
| Playlist chunk size | Controls automatic playlist batch size |
| Include metadata / thumbnail | Saves information and artwork alongside the media |

If the source reports HTTP 429, reduce concurrency and check frequency, then allow time before retrying. Repeated immediate retries can extend the problem. See [troubleshooting](../reference/troubleshooting.md#http-429-or-too-many-requests).

## Custom arguments

**Global custom args** applies to downloads across the app. Subscriptions can also carry their own arguments. Separate arguments and values with **two commas**, not shell quoting:

```text
--sleep-interval,,5,,--max-sleep-interval,,10
```

This supplies four arguments to yt-dlp. Use the [yt-dlp options reference](https://github.com/yt-dlp/yt-dlp#usage-and-options) to check the syntax and effect of an option. Prefer the app's quality, filename, and subtitle controls when they already express what you need.

Per-download and subscription argument strings are checked at the downloader boundary. Restricted process and file-control options can cause the custom string to be discarded, with a log entry explaining why. A stored subscription does not bypass that check.

## Filenames and metadata

Set **Default file output** under **Downloader → Paths and filenames**. Use yt-dlp placeholders relative to the configured audio or video path, and **omit the extension**, which the app adds:

```text
%(uploader)s/%(title)s [%(id)s]
```

Including the source ID helps distinguish uploads with the same title. Category and subscription templates provide more specific output choices; custom outputs must stay inside their download folder.

Enable **Replace invalid filename characters** when files need to work across filesystems. Configure the characters to replace and their replacement text; `_` is the default replacement. With yt-dlp, this rewrites the metadata fields used to form filenames. Explicit filename-related custom arguments take precedence over this automatic handling.

Keep metadata and thumbnails alongside the media for library details and later import. **Generate NFO files** under Extra creates additional metadata for compatible library tools. Moving a media file without its sidecars can lose artwork, subtitles, and source information during recovery.

## Cookies and browser impersonation

For sources requiring a signed-in session, upload a Netscape-format `cookies.txt` in **Settings → Advanced**, enable cookies, and use the cookie test with the failing URL. Cookies grant access as the account they came from; replace expired cookies when testing reports a login failure.

Browser impersonation requires startup dependencies. Set `ytdl_enable_ytdlp_impersonation_dependencies: 'true'`, recreate the container, then check the option under **Downloader**. Existing configurations may still need **Use browser impersonation** enabled. This is separate from cookies and does not guarantee access to every source.

Completed items appear in the [library](library.md). If an item was skipped as already downloaded, inspect its [archive entry](archive.md).
