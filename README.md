<h1>
  <img src="./src/assets/images/logo_64px.png" alt="ytdl-material logo" width="32" />
  ytdl-material
</h1>

[![Docker pulls badge](https://img.shields.io/docker/pulls/voc0der/ytdl-material.svg)](https://hub.docker.com/r/voc0der/ytdl-material)
[![Docker image size badge](https://img.shields.io/docker/image-size/voc0der/ytdl-material?sort=date)](https://hub.docker.com/r/voc0der/ytdl-material)
<a href="https://github.com/voc0der/ytdl-material/tree/main/backend/test">
  <img src="https://img.shields.io/badge/coverage-59.9%25-orange" alt="Code coverage percentage" />
</a>
[![GitHub issues badge](https://img.shields.io/github/issues/voc0der/ytdl-material)](https://github.com/voc0der/ytdl-material/issues)
[![License badge](https://img.shields.io/github/license/voc0der/ytdl-material)](https://github.com/voc0der/ytdl-material/blob/main/LICENSE.md)
[![Dependencies badge](https://img.shields.io/badge/dependencies-out%20of%20date-orange)](https://github.com/voc0der/ytdl-material/network/dependencies)

ytdl-material is a Material Design frontend for [youtube-dl](https://rg3.github.io/youtube-dl/) / yt-dlp workflows. It's coded using [Angular 21](https://angular.dev/) for the frontend, and [Node.js](https://nodejs.org/) on the backend.

<hr>

<img src="./docs/images/readme-home.png" width="1000" alt="ytdl-material interface">

## Docker

### Setup

1. Download [docker-compose.yml](https://github.com/voc0der/ytdl-material/blob/main/docker-compose.yml):

```bash
curl -L https://raw.githubusercontent.com/voc0der/ytdl-material/refs/heads/main/docker-compose.yml -o docker-compose.yml
```

2. Start it:

```bash
docker compose pull   # if needed
docker compose up -d
```

Docker environment variables: [docker-environment.md](./docker-environment.md). See [Wiki](https://github.com/voc0der/ytdl-material/wiki#environment-specific-guideshelp) for host-specific instructions.

#### Build manually
See the [install and build guide](./install-and-build.md).

## API

Enable the public API in Settings -> *Extra*, generate an API key if needed, then enable API docs (restart required) for endpoint details.

## Contributing

Review [CONTRIBUTING.md](./CONTRIBUTING.md) for contributor guidelines; pull requests and issues for bugs or feature requests are welcome.

## Legal Disclaimer

This project is in no way affiliated with Google LLC, Alphabet Inc. or YouTube (or their subsidiaries) nor endorsed by them.

## Star History

<p align="center">
  <a href="https://star-history.com/#voc0der/ytdl-material&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=voc0der/ytdl-material&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=voc0der/ytdl-material&type=Date" />
      <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=voc0der/ytdl-material&type=Date" />
    </picture>
  </a>
</p>
