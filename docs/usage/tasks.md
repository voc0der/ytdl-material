# Tasks and schedules

Open **Tasks** for maintenance and recurring work. Each task shows its current state, last result, and schedule. Access requires the `tasks_manager` permission in multi-user mode; database administration operations also have administrator restrictions.

## Available tasks

| Task | What it does |
| --- | --- |
| Backup DB | Writes a snapshot of the active database to `appdata/db_backup` |
| Missing files check | Finds database records whose files are absent from disk; review before removing records |
| Import missing DB records | Registers supported media found in managed directories |
| Find duplicate files in DB | Finds duplicate entries for review and removal |
| Update yt-dlp | Checks the selected downloader for an update and offers to apply it; the title names the downloader chosen in **Settings → Advanced** |
| Delete old files | Finds files older than the configured retention threshold; confirmation deletes them |
| Import legacy archives | Imports older archive and blacklist text files into the database |
| Rebuild database | Backs up the database and rebuilds file records from stored media and metadata |
| Apply categories to existing files | Re-evaluates category membership using current rules |
| Check subscriptions | Checks active subscriptions and queues eligible missing items |
| Delete old playback transcodes | Deletes copies made for transcoding playback links once they are over six hours old and no unexpired link, queued or running transcode uses them |
| Codec discovery | Records the video and audio codec of files that have none; with a preferred codec set, converts other videos to it. See [codec discovery](#codec-discovery) |

## Run and review

Choose **Run** to execute a task. Some tasks finish immediately; others leave findings that need a second action, such as removing missing records, deleting old files, or installing a downloader update. Review the count and result before selecting that action.

The **Auto confirm** option applies a task's findings without manual review. Leave it disabled until you have run the task and verified its selection, especially for retention and duplicate removal. A disconnected media mount can make many existing files appear missing.

## Schedule a task

Open the task's schedule dialog and select a one-time or recurring schedule. The UI saves the browser's timezone; recurring tasks use that timezone when calculating their next run. Old schedules without a timezone use server time. If a timezone is invalid, the server logs a warning and falls back to its local timezone; resave the schedule to correct it.

The default **Check subscriptions** and **Delete old playback transcodes** schedules run daily at midnight in server time. An unset recurring field means every value of that field: leaving the minute unspecified can run a task every minute during the selected hour. Select both hour and minute for a once-daily schedule.

A task that is already running or waiting for confirmation is skipped at its next scheduled invocation. Complete or dismiss pending work if the schedule appears to stop running.

## Codec discovery

Every run probes library files whose records have no codec yet and stores it. New downloads record their codec as they finish, so this mostly catches up files from before the feature existed. The codec shows as a badge in the file's **Info** dialog, including from the player.

With a **Preferred codec** set in **Settings → Downloader** (`ytdl_preferred_codec`: `h264`, `hevc`, `av1` or `vp9`), the run then converts every other video, one at a time:

1. If the file has a source URL and the source offers the codec at the file's resolution or better, it is downloaded again in that format, with the same audio format as before when that is still offered.
2. Otherwise it is transcoded, on the GPU when [hardware acceleration](../deployment/hardware.md) is set up and its encoder for that codec passes a flight test, on the CPU otherwise.

A file is never downloaded again if it runs shorter than its source, since it was trimmed, snipped or had SponsorBlock segments cut after download; it is transcoded instead. HDR video is left as it is, because converting it without tone mapping would flatten it to SDR. A container that cannot hold the codec is replaced with MP4, for example a VP9 `.webm` converted to HEVC becomes `.mp4`. Every converted file is checked for codec, length and audio before it replaces the original. Transcoding from H.264 loses less than transcoding from AV1 or VP9, which also tend to come out larger.

New downloads also prefer the codec when the source offers it at the best available resolution, so they rarely need converting later.

Task options:

- **Convert to the preferred codec**: turn off to only record codecs, even with a preferred codec set.
- **Conversions per run**: stops after this many files, counting downloads and transcodes. `0`, the default, means no limit. The rest wait for the next run. Files that failed before go last, so they cannot use up a limited run.

A run can take hours on a large library. It keeps going after the Tasks page is closed, and a second run started meanwhile does not start another conversion. A file that fails keeps its original, and the reason is in the log. Converted files replace the originals, so take a [backup](../deployment/backups.md) of media you cannot download again before the first run.

If the container stops during a conversion, the next start discards the unfinished copy and keeps the original, or finishes deleting the original if the new file had already been saved. The task is left idle; nothing resumes on its own. Work files live beside each original as `*.codec-part` and under `appdata/codec-work`, which lite server backups skip.

## Retention

Set the age threshold for **Delete old files** in its options. Age is measured from when a file was **registered in the library**, not its source upload date. The archive/blacklist choices control retaining download history; inspect the resulting Archive before relying on retention to prevent subscription redownloads.

Database snapshots do not include media files. Follow [backups and restore](../deployment/backups.md) before using rebuild, retention, or bulk cleanup.
