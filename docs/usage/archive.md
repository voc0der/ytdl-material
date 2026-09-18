# Archive and duplicates

The **Archive** records source items that should be skipped on future downloads. It is not a copy of the media and cannot restore a deleted file.

## How the archive works

Archive entries are stored in the active database. Each entry identifies an extractor and source item, media type, and subscription, plus the owner in multi-user mode. The same source can therefore belong to different users or appear in an audio and video collection independently.

The app generates the downloader's archive data from these records. Old `archive_*.txt` and `blacklist_*.txt` files are legacy import sources; editing them is not how you manage the current database archive.

Enable download archiving in **Settings → Downloader** for one-off downloads. Subscriptions also consult their own archive history when deciding what to queue.

## Inspect or remove an entry

Open **Archive** from the app's menu. Search by title or source ID, filter by subscription and type, and select entries to remove.

Removing an archive entry does not delete a media file. It removes the instruction to skip that source item. If you want a subscription to download a previously removed item again, remove the matching entry and check the subscription.

If you want a deleted subscription item to stay deleted, retain its archive entry when removing the media.

## Import history

Choose a `.txt` archive in the Archive dialog, select its target subscription or media type, and import it. The expected format is one extractor and ID per line:

```text
example-extractor source-item-id
```

Use the original extractor names and IDs from an actual yt-dlp archive; the line above only illustrates the format. For old installations with archive files in their original locations, **Tasks → Import legacy archives** imports those records.

## Duplicate handling

**Warn on duplicate** (`ytdl_warn_on_duplicate`) controls duplicate-download warnings and reusing existing files when adding media to playlists. It is separate from archive-based skipping.

**Tasks → Find duplicate files in DB** finds duplicate library records. Review its findings before confirming removal. A library record, a physical file, a download-history entry, and an archive record serve different purposes; deleting one does not mean every other record should also disappear.
