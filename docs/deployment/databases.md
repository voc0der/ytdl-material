# Databases and Redis

The app supports three database backends. The supplied Compose file selects PostgreSQL; an unconfigured app defaults to local JSON.

| Backend | Configuration | Storage |
| --- | --- | --- |
| Local JSON | `ytdl_use_local_db: 'true'` | Files under `appdata` |
| PostgreSQL | Local DB off, remote type `postgres`, PostgreSQL connection string | Separate PostgreSQL server |
| MongoDB | Local DB off, remote type `mongo`, MongoDB connection string | Separate MongoDB server |

## PostgreSQL

```yaml
environment:
  ytdl_use_local_db: 'false'
  ytdl_remote_db_type: 'postgres'
  ytdl_postgresdb_connection_string: 'postgresql://APP_USER:APP_PASSWORD@ytdl-postgres-db:5432/APP_DB'
```

Replace the credentials and database name with those created on your server. Inside Docker, `localhost` refers to the app container, so use the database service name or a reachable external hostname.

For a new database, pin the image's major version. The official PostgreSQL image uses **`/var/lib/postgresql` for 18 and later**; older majors normally use **`/var/lib/postgresql/data`**. The repository's default and extended Compose examples currently differ in this mount, so align the mount with the image you choose. Consult the [official image's storage notes](https://hub.docker.com/_/postgres) before an upgrade or volume change.

## MongoDB

```yaml
environment:
  ytdl_use_local_db: 'false'
  ytdl_remote_db_type: 'mongo'
  ytdl_mongodb_connection_string: 'mongodb://ytdl-mongo-db:27017'
```

This example assumes a database on the private Compose network. Add authentication to the connection string when your MongoDB server requires it. Preserve an existing server's authentication and image version during an app migration.

The old wiki's pinned MongoDB 4 image was a historical hardware workaround. It is not the default recommendation for a new installation. Use a database version supported by your host, or PostgreSQL/local JSON on hardware incompatible with your chosen MongoDB version.

## Choose and test the connection

Use **Settings → Database** to inspect the active engine, record counts, and connection-test results. Saving a connection string does not by itself prove the app has moved its records. Follow [migration](migration.md) when switching engines.

If `ytdl_remote_db_type` is empty, a configured PostgreSQL string takes precedence; otherwise the app selects MongoDB. An explicit type makes the intended deployment clearer.

## Optional Redis

Redis stores **shared HTTP rate-limiter state**. It is not the library database, the media cache, or a download queue.

```yaml
environment:
  ytdl_redis_connection_string: 'redis://ytdl-redis:6379/0'
```

If Redis is invalid or unavailable, the backend logs a warning and uses an in-memory limiter while retrying the connection. To disable a previously saved Redis URL, apply `ytdl_redis_connection_string: ''` for one startup, then remove the environment line.
