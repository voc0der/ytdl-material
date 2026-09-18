# Docker and storage

The standard image is **`voc0der/ytdl-material:latest`**. Published builds support `linux/amd64` and `linux/arm64/v8`. Use the [quick start](../getting-started/quick-start.md) for a new installation.

The [default Compose file](https://github.com/voc0der/ytdl-material/blob/main/docker-compose.yml) includes PostgreSQL. The [extended example](https://github.com/voc0der/ytdl-material/blob/main/docker-compose-extended.yml) illustrates optional services and settings. Check database image versions and their volume paths before adapting either file to an existing installation.

## Persistent directories

| Container path | Contents |
| --- | --- |
| `/app/appdata` | Configuration, local database files, logs, database snapshots, cookies, downloader state |
| `/app/audio` | Ordinary audio downloads in single-user mode |
| `/app/video` | Ordinary video downloads in single-user mode |
| `/app/subscriptions` | Single-user subscription media and metadata |
| `/app/users` | User-owned libraries and subscriptions in multi-user mode |

The database service has its own persistent storage. Preserve it along with these app directories. A remote database stores library records, not the actual media bytes.

Custom output paths also need persistent mounts. Keep the same **container paths** when moving host directories; database records may reference those paths.

## Ownership and permissions

By default, the container starts with enough privilege to prepare directories and optional dependencies, then runs the app as UID/GID **1000:1000**. To match a host account:

```yaml
environment:
  ytdl_uid: '1000'
  ytdl_gid: '1000'
  ytdl_umask: '022'
```

Use the IDs appropriate for your host. `022` creates files readable by other users; `002` allows group writes. The app still needs write access to its database, logs, and downloader directories as well as media storage.

You can start directly as a non-root user with `user: '1000:1000'`. In that case, prepare mount ownership yourself. Startup cannot install optional system packages or repair ownership without the required privileges. This matters for VAAPI/QSV and browser impersonation setup.

## Ports and networks

The backend serves the app and API on **17442** by default. `17442:17442` publishes it on the host. For a reverse proxy running on the same host, `127.0.0.1:17442:17442` limits direct access to loopback. A proxy in another container should use a shared Docker network and the app's service name instead.

The app reaches PostgreSQL through the Compose service name; publishing PostgreSQL's port to the host is unnecessary for this setup.

## Common operations

```bash
docker compose ps
docker compose logs --tail=100 ytdl-material
docker compose stop ytdl-material
docker compose up -d ytdl-material
```

After editing environment variables, use `up -d` to recreate the changed service. See [updates](updates.md) before pulling replacement database images and [backups](backups.md) before changing storage.
