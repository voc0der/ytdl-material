# Quick start

The default Docker Compose setup runs ytdl-material with PostgreSQL and stores your data in directories alongside the Compose file. Use a 64-bit amd64 or arm64 host with Docker Engine and the Compose plugin.

## 1. Download the Compose file

Create a directory on the disk where you want to keep your library:

```bash
mkdir ytdl-material
cd ytdl-material
curl -fL https://raw.githubusercontent.com/voc0der/ytdl-material/main/docker-compose.yml -o docker-compose.yml
```

Open `docker-compose.yml` before starting. Replace `PlaceholderUser`, `PlaceholderPassword`, and `PlaceholderDB` consistently in the app connection string, PostgreSQL environment, and health check. If a password contains URI-reserved characters, percent-encode those characters in the connection string.

The PostgreSQL image in the repository uses a floating tag. For a long-lived installation, pin the major version you initially deploy and use that version's required data mount. Changing a database major version later requires a database upgrade procedure; pulling a new container alone is insufficient. See [databases](../deployment/databases.md).

## 2. Start the services

```bash
docker compose pull
docker compose up -d
docker compose logs -f ytdl-material
```

Open **`http://<server-ip>:17442`**. The first start can take longer while the container prepares dependencies and the downloader. `Ctrl+C` exits the log viewer without stopping the services.

## 3. Choose access and storage settings

The default is **single-user mode**: anyone who can reach the app can use and administer it. On a shared server, enable **Settings → Main → Multi-user mode**, complete the administrator setup, and review registration under **Settings → Users**. Complete this setup before opening access to other people.

The Compose file persists five app directories: `appdata`, `audio`, `video`, `subscriptions`, and `users`, plus the database directory `db`. Keep all of them when recreating a container. See [Docker and storage](../deployment/docker.md).

## 4. Download your first item

1. Paste a supported media URL into the Home page.
2. Choose video or audio and a quality.
3. Start the download and follow its progress in **Downloads**.
4. Open the completed item from your library to play it.

Keep **Include metadata** enabled so downloaded files retain the information used for library import and recovery.

## Next steps

- [Subscribe to a channel or playlist](../usage/subscriptions.md).
- [Set up HTTPS](../deployment/reverse-proxy.md).
- [Schedule a database backup](../deployment/backups.md).
- [Build and run without Docker](../development/contributing.md).
- [Move an existing installation](../deployment/migration.md).
