# Migrating an installation

Preserve the existing installation until you have verified the replacement. Take a [database snapshot and media backup](backups.md), record the image versions and mount paths, and stop new downloads during the move.

## Move from an older app image

Keep your current database service and its data directory for the first app upgrade. Mount the same `appdata`, `audio`, `video`, `subscriptions`, and `users` directories into the new app image at their existing container paths.

If the existing database is MongoDB, explicitly select `mongo` and keep its connection string. The current default Compose file selects PostgreSQL; replacing an old Compose file wholesale would select a different database and can make the library appear empty. [docker-compose-youtubedl-material.yml](https://github.com/voc0der/ytdl-material/blob/main/docker-compose-youtubedl-material.yml) is a starting point that keeps MongoDB and the original mount paths; compare it with your existing file before replacing anything.

Start the replacement app, review logs, and verify files, users, playlists, subscriptions, and archive history. Current startup normalizes the legacy configuration root and removes retired settings. Update scripts that used the shared `apiKey` query parameter to [per-user Bearer tokens](../integrations/api.md).

Do an app upgrade and a database-engine migration as separate steps so a failure has a clear cause.

## Local JSON to a remote database

1. Preserve the populated local `appdata` directory and take a backup.
2. Create an **empty** target PostgreSQL or MongoDB database.
3. Set `ytdl_use_local_db: 'false'`, the remote type, and its connection string.
4. Start the app and check the startup log for the local-data bootstrap result.
5. Verify record counts and library contents in **Settings → Database**.

If the target is empty and local records exist, startup copies the local data automatically and writes a local snapshot to `appdata/db_backup`. **Do not set `ytdl_db_migrate` for this move.**

## MongoDB to PostgreSQL

Both databases must be reachable and the target must be empty. Apply these settings to the app service, replacing the placeholders:

```yaml
environment:
  ytdl_use_local_db: 'false'
  ytdl_remote_db_type: 'postgres'
  ytdl_mongodb_connection_string: 'mongodb://ytdl-mongo-db:27017'
  ytdl_postgresdb_connection_string: 'postgresql://APP_USER:APP_PASSWORD@ytdl-postgres-db:5432/APP_DB'
  ytdl_db_migrate: 'postgres'
```

Start the app and inspect its logs. On success it saves the selected remote type and clears the saved migration setting. **Remove `ytdl_db_migrate` from Compose after success** and keep `ytdl_remote_db_type: 'postgres'`, then recreate the app. Otherwise the environment requests another migration on the next boot.

## PostgreSQL to MongoDB

Use both connection strings as above, with `ytdl_remote_db_type: 'mongo'` and `ytdl_db_migrate: 'mongo'`. Verify the result, remove the migration environment variable, and keep the explicit `mongo` type.

## If migration fails

Startup refuses to merge into a populated target. If a previous attempt left data there, inspect it and use a new empty target for a retry. Do not clear the source database to make a migration pass.

The migration copies database records, not media directories. Missing volumes or changed container paths must be fixed separately. Remove the migration flag when reverting to the original database, restore its explicit engine selection, and restart against the preserved source.

For a same-engine major-version upgrade, follow the database vendor's upgrade process. The app's migration switch changes between MongoDB and PostgreSQL; it does not upgrade either server's on-disk format.
