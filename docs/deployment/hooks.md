# Startup and download hooks

Hooks are your own scripts, run at three fixed points: when the container starts, once the server is up, and after each download. Put them in a directory on the host and mount it at `/app/hooks`, read-only:

```yaml
services:
  ytdl-material:
    volumes:
      - ./hooks:/app/hooks:ro
```

The [extended Compose example](https://github.com/voc0der/ytdl-material/blob/main/docker-compose-extended.yml) has the same line, commented out. Nothing in Settings or the API can add a hook or point at another directory; only whoever controls the mount can.

## Layout

```text
hooks/
├── init.d/                 # each time the container starts
├── started.d/              # each time the server starts listening
└── download-finished.d/    # once for each new file
```

Leave out the stages you do not use.

| Stage | Runs | As | If a script fails |
| --- | --- | --- | --- |
| `init.d` | Each time the container starts, before the app | Root by default, or the container's `user:` | The container stops starting |
| `started.d` | Each time the server starts listening, including after an update or a restart from Settings | The app's user, 1000:1000 by default | It is logged, and the next script runs |
| `download-finished.d` | Once for each new file, after it is in the library | The app's user | It is logged, and the next script runs |

In every stage:

- **Only executable files run.** A script without `chmod +x` is skipped, with a line in the log saying so. Hidden files and directories are ignored.
- **Scripts run one at a time, in name order**, so prefix them with numbers: `10-install-tools`, `20-...`. Download hooks also run one download at a time, in the order files finish, so a playlist does not start hundreds of scripts at once.
- **Output goes to the container log**, prefixed with the stage and script name, such as `[hook started.d/10-announce]`.
- **Scripts run in `/app`** with the container's environment, plus the variables below. The image is Ubuntu with `bash`, `curl`, and `python3`.

A download or started hook that never exits holds up the scripts after it. Start anything long-running in the background and let the hook return.

## Variables

| Variable | Stages | Value |
| --- | --- | --- |
| `YTDL_EVENT` | All | `init`, `started`, or `download-finished` |
| `YTDL_PORT` | `started.d` | Port the server listens on |
| `YTDL_URL` | `started.d` | The configured URL of the app |
| `YTDL_FILE_PATH` | `download-finished.d` | Absolute path of the new file |
| `YTDL_FILE_UID` | `download-finished.d` | The file's ID in the library |
| `YTDL_FILE_TITLE` | `download-finished.d` | Its title |
| `YTDL_FILE_URL` | `download-finished.d` | The page it was downloaded from |
| `YTDL_FILE_TYPE` | `download-finished.d` | `audio` or `video` |
| `YTDL_USER_UID` | `download-finished.d` | The owner in multi-user mode, otherwise empty |
| `YTDL_SUBSCRIPTION_ID` | `download-finished.d` | The subscription that downloaded it, otherwise empty |
| `YTDL_DOWNLOAD_UID` | `download-finished.d` | The download it came from; a playlist's files share one |

Values are passed as environment variables, never pasted into a command, so a title with quotes or `$` in it is only ever data. Quote the variables in your scripts all the same: `"$YTDL_FILE_PATH"`.

## Examples

### Install a tool before the app starts

`hooks/init.d/10-install-jq` runs as root, so it can install packages. It runs on every start, so it checks first:

```bash
#!/bin/bash
set -e
command -v jq >/dev/null && exit 0
apt-get update
apt-get install -y --no-install-recommends jq
rm -rf /var/lib/apt/lists/*
```

A failing init script stops the container from starting, since what follows may depend on it. If a step is optional, end it with `|| true`.

### Say the server is up

`hooks/started.d/10-announce` posts to an ntfy topic on your own server:

```bash
#!/bin/sh
curl -fsS -m 10 -d "ytdl-material is up on port $YTDL_PORT" https://ntfy.example.com/ytdl || true
```

### Copy new audio to a music library

`hooks/download-finished.d/10-copy-audio`, with the music folder mounted at `/music`:

```bash
#!/bin/sh
[ "$YTDL_FILE_TYPE" = audio ] || exit 0
cp "$YTDL_FILE_PATH" /music/
```

### Tell a media server to rescan

`hooks/download-finished.d/20-refresh-jellyfin`, with `JELLYFIN_API_KEY` set in the container's environment:

```bash
#!/bin/sh
curl -fsS -m 10 -X POST -H "Authorization: MediaBrowser Token=\"$JELLYFIN_API_KEY\"" \
    http://jellyfin:8096/Library/Refresh
```

## Security

A hook runs with the app's access to your media, configuration, and credentials, and an init hook runs as root. Anyone who can write to the hooks directory can run code in the container. Mount it read-only, keep it outside the media folders, and give its host directory the same care as the Compose file itself.

To check that the server itself is up, rather than running something when it is, use the [health check](docker.md#health-check).
