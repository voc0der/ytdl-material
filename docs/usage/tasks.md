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

## Run and review

Choose **Run** to execute a task. Some tasks finish immediately; others leave findings that need a second action, such as removing missing records, deleting old files, or installing a downloader update. Review the count and result before selecting that action.

The **Auto confirm** option applies a task's findings without manual review. Leave it disabled until you have run the task and verified its selection, especially for retention and duplicate removal. A disconnected media mount can make many existing files appear missing.

## Schedule a task

Open the task's schedule dialog and select a one-time or recurring schedule. The UI saves the browser's timezone; recurring tasks use that timezone when calculating their next run. Old schedules without a timezone use server time. If a timezone is invalid, the server logs a warning and falls back to its local timezone; resave the schedule to correct it.

The default **Check subscriptions** schedule runs daily at midnight in server time. An unset recurring field means every value of that field: leaving the minute unspecified can run a task every minute during the selected hour. Select both hour and minute for a once-daily schedule.

A task that is already running or waiting for confirmation is skipped at its next scheduled invocation. Complete or dismiss pending work if the schedule appears to stop running.

## Retention

Set the age threshold for **Delete old files** in its options. Age is measured from when a file was **registered in the library**, not its source upload date. The archive/blacklist choices control retaining download history; inspect the resulting Archive before relying on retention to prevent subscription redownloads.

Database snapshots do not include media files. Follow [backups and restore](../deployment/backups.md) before using rebuild, retention, or bulk cleanup.
