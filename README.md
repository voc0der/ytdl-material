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

### Host-specific instructions

If you're on a Synology NAS, unRAID, Raspberry Pi 4 or any other possible special case you can check if there's known issues or instructions both in the issue tracker and in the [Wiki!](https://github.com/voc0der/ytdl-material/wiki#environment-specific-guideshelp)

Note: official ARMv7 Docker image builds have been retired. Use `amd64` / `arm64` images or build locally for unsupported architectures.

### Setup

1. Download `docker-compose.yml`:

```bash
curl -L https://raw.githubusercontent.com/voc0der/ytdl-material/refs/heads/main/docker-compose.yml -o docker-compose.yml
```

2. Start it:

```bash
docker compose pull   # optional
docker compose up -d
```

Docker environment variables: [docker-environment.md](./docker-environment.md).

## MongoDB

For much better scaling with large datasets, run your ytdl-material instance with the MongoDB backend rather than the JSON file-based default; for setup and upgrades, see the [MongoDB tutorial](https://github.com/voc0der/ytdl-material/wiki/Setting-a-MongoDB-backend-to-use-as-database-provider-for-YTDL-M) and [Upgrading MongoDB to 8.x](https://github.com/voc0der/ytdl-material/wiki/Update-MongoDB-to-8.x).

## API

To get started, review the [API docs](https://youtubedl-material.stoplight.io/docs/youtubedl-material/Public%20API%20v1.yaml), then go to the settings menu and enable the public API from the *Extra* tab. You can generate an API key if one is missing.

Once you have enabled the API and have the key, you can start sending requests by adding the query param `apiKey=API_KEY`. Replace `API_KEY` with your actual API key, and you should be good to go! Nearly all of the backend should be at your disposal. View available endpoints in the link above.

## Contributing

If you're interested in contributing, first: awesome! Second, please refer to the guidelines/setup information located in the [Contributing](https://github.com/voc0der/ytdl-material/wiki/Contributing) wiki page, it's a helpful way to get you on your feet and coding away.

Pull requests are always appreciated! If you're a bit rusty with coding, that's no problem: we can always help you learn. And if that's too scary, that's OK too! You can create issues for features you'd like to see or bugs you encounter, it all helps this project grow.

## Authors

* **Isaac Grynsztein** (me!) - *Initial work*
* **voc0der** - *Current maintenance*

## Legal Disclaimer

This project is in no way affiliated with Google LLC, Alphabet Inc. or YouTube (or their subsidiaries) nor endorsed by them.

[![Star History Chart](https://api.star-history.com/svg?repos=voc0der/ytdl-material&type=Date)](https://star-history.com/#voc0der/ytdl-material&Date)
