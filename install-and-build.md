# Local Install and Build

This guide is for non-Docker installs and source builds.

If you want Docker, use the [Docker section in README.md](./README.md#docker).

## Prerequisites

Required dependencies:

* Node.js 24 (npm 10+)
* Python 3

Optional dependencies:

* AtomicParsley (for embedding thumbnails, package name `atomicparsley`)
* [Twitch Downloader CLI](https://github.com/lay295/TwitchDownloader) (for downloading Twitch VOD chats)

<details>
  <summary>Debian/Ubuntu</summary>

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs ffmpeg unzip python3 python3-pip
# Optional but recommended for local installs:
python3 -m pip install --user yt-dlp yt-dlp-ejs
```

</details>

## Install from release (non-Docker)

1. Download the [latest release](https://github.com/voc0der/ytdl-material/releases/latest).
2. Put the `youtubedl-material` directory somewhere accessible.
3. Edit `appdata/default.json`.
4. If you are not using a reverse proxy, port forward the configured port (default `17442`).
5. Install and start the backend:

```bash
npm install --prefix backend
npm start --prefix backend
```

This runs the backend server, which also serves the frontend.

If you run into issues, check the browser console first.

## Build from source

Clone the repo and enter the `youtubedl-material` directory.

Requirements for local builds:

* Node.js `>=24 <26`
* npm `>=10`

Install dependencies and build the frontend:

```bash
npm install
npm install --prefix backend
npm run build
```

This writes build output to `backend/public`.

Note: `npm start` in the repo root starts the Angular dev server (`ng serve`). To run the backend app, use `npm start --prefix backend`.

### Angular 21 / Videogular install note

The repo currently uses Angular 21 and `@videogular/ngx-videogular@20`. Videogular 20 still declares Angular 20 peer ranges, so the repository includes a temporary `.npmrc` with `legacy-peer-deps=true`.

Keep this file when building locally or in Docker until Videogular publishes Angular 21 peer support.

### Run backend

Install `pm2` globally, then start the backend:

```bash
npm -g install pm2
npm start --prefix backend
```

If you want your instance available outside your network, set up a [reverse proxy](https://github.com/voc0der/ytdl-material/wiki/Reverse-Proxy-Setup) or port forward the configured backend port (default `17442`).
