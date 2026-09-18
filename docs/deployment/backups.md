# Backups and restore

A complete backup contains **database records, application configuration, and media files**. The app's Backup DB task covers the database records only.

## Database snapshots

Run **Tasks → Backup DB**. It snapshots the active backend, including PostgreSQL or MongoDB, into `appdata/db_backup`. Filenames identify a local or remote snapshot and its timestamp.

Schedule this task if you want regular snapshots. Copy the resulting files off the server; a snapshot stored beside the live database is still lost if that disk fails. Monitor available storage as snapshots accumulate.

The **Restore database from backup** button on Tasks reads these snapshot files and requires an administrator in multi-user mode. Restoring changes the active database's records; first stop downloads and subscription checks, take a current snapshot, and choose the intended backup. Verify users, library paths, playlists, and subscriptions afterward.

## Files and configuration

Back up all five app mounts:

- `appdata`, including `default.json`, snapshots, and any cookies you need to retain.
- `audio` and `video` for ordinary single-user downloads.
- `subscriptions` for single-user subscription data.
- `users` for multi-user media and subscriptions.

Include additional mounts used by custom output paths, plus your Compose file and deployment configuration. Preserve ownership and permissions.

For a consistent filesystem backup, stop the app after its database snapshot finishes, copy the app directories, then start it again. If backing up a raw PostgreSQL or MongoDB data directory, stop that database cleanly first or use its native backup tools; copying a live database directory is not a reliable snapshot.

## Restore onto a new host

1. Install the same app and database versions used for the backup.
2. Restore the app directories and mount them at the same container paths.
3. Restore your database using its native backup, or start a compatible empty database and use the app's database snapshot restore action.
4. Restore connection settings and file ownership.
5. Start the app, check logs, and verify several files play before resuming scheduled work.

When recovering with an app snapshot, retain that snapshot in `appdata/db_backup` so the task can find it. A database snapshot alone cannot recover missing video or audio files.

## Import and rebuild are recovery tools

**Import missing DB records** can register media found on disk. **Rebuild database** reconstructs file records using available files and metadata. Neither replaces a complete backup of account details, playlists, history, and configuration.

Rebuild can also recreate missing users and paused subscriptions from their storage directories. Recreated users receive the password `password`; change those credentials before reopening access. The rebuild confirmation calls out this behavior.

Keep `.info.json` sidecars with the media. They preserve source metadata used during import and recovery. The [Archive](../usage/archive.md) only tracks items to skip and is not a media backup.
