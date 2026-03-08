# ytdl-material

[![Docker pulls badge](https://img.shields.io/docker/pulls/voc0der/ytdl-material.svg)](https://hub.docker.com/r/voc0der/ytdl-material)
[![Docker image size badge](https://img.shields.io/docker/image-size/voc0der/ytdl-material?sort=date)](https://hub.docker.com/r/voc0der/ytdl-material)
[![GitHub issues badge](https://img.shields.io/github/issues/voc0der/ytdl-material)](https://github.com/voc0der/ytdl-material/issues)
[![License badge](https://img.shields.io/github/license/voc0der/ytdl-material)](https://github.com/voc0der/ytdl-material/blob/master/LICENSE.md)

ytdl-material is a Material Design frontend for [youtube-dl](https://rg3.github.io/youtube-dl/) / yt-dlp workflows. It's coded using [Angular 21](https://angular.dev/) for the frontend, and [Node.js](https://nodejs.org/) on the backend.

<hr>

## Getting Started

Choose one path:

* [Docker setup](#docker) (no local Node.js/Python dependencies required)
* [Local install/build guide](./install-and-build.md) (includes prerequisites)

Here's an image of what it'll look like once you're done:

<img src="./docs/images/readme-home.png" width="1000" alt="ytdl-material interface">

## Docker

### Setup

1. Download `docker-compose.yml`:

```bash
curl -L https://raw.githubusercontent.com/voc0der/ytdl-material/refs/heads/main/docker-compose.yml -o docker-compose.yml
```

2. Start it:

```bash
docker compose pull   # if needed
docker compose up -d
```

Docker environment variables: [docker-environment.md](./docker-environment.md).

### Host-specific instructions

If you're on a Synology NAS, unRAID, Raspberry Pi 4 or any other possible special case you can check if there's known issues or instructions both in the issue tracker and in the [Wiki!](https://github.com/voc0der/ytdl-material/wiki#environment-specific-guideshelp)

Note: official ARMv7 Docker image builds have been retired. Use `amd64` / `arm64` images or build locally for unsupported architectures.

## MongoDB

For much better scaling with large datasets, run your ytdl-material instance with the MongoDB backend rather than the JSON file-based default; for setup and upgrades, see the [MongoDB tutorial](https://github.com/voc0der/ytdl-material/wiki/Setting-a-MongoDB-backend-to-use-as-database-provider-for-YTDL-M) and [Upgrading MongoDB to 8.x](https://github.com/voc0der/ytdl-material/wiki/Update-MongoDB-to-8.x).

## API

Enable the public API in Settings -> *Extra*, generate an API key if needed, then enable API docs (restart required) for endpoint details.

## Contributing

Review the [Contributing](https://github.com/voc0der/ytdl-material/wiki/Contributing) wiki page for setup and guidelines; pull requests and issues for bugs or feature requests are welcome.

## Legal Disclaimer

This project is in no way affiliated with Google LLC, Alphabet Inc. or YouTube (or their subsidiaries) nor endorsed by them.

[![Star History Chart](https://api.star-history.com/svg?repos=voc0der/ytdl-material&type=Date)](https://star-history.com/#voc0der/ytdl-material&Date)
