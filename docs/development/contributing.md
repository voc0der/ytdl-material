# Local setup and contributing

The frontend uses Angular and the backend uses Node.js. The supported Node range is **`>=24 <26`**, with npm **10 or later**. Node 24 is the baseline for these instructions.

## Build from source

Install Node, Python 3, ffmpeg, and unzip using your platform's package manager, then:

```bash
git clone https://github.com/voc0der/ytdl-material.git
cd ytdl-material
npm ci
npm ci --prefix backend
npm run build
```

The production build writes the frontend to `backend/public`. Retain the repository's `.npmrc`: it temporarily permits dependencies with older declared peer ranges.

To run the built app directly:

```bash
cd backend
node app.js
```

Run from the backend directory because configuration and media paths are relative to it. The backend serves the built frontend on port 17442 by default. To use `npm start --prefix backend`, install PM2 as described in the [local build guide](https://github.com/voc0der/ytdl-material/blob/main/install-and-build.md); that script invokes `pm2-runtime`.

Optional tools include AtomicParsley for thumbnail embedding and TwitchDownloaderCLI for recording chat. The Docker image includes its own dependency preparation; a source install must supply the tools needed by the features you use.

## Frontend development

Run `npm start` at the repository root for the Angular development server. In another terminal, run:

```bash
cd backend
npm run debug
```

Debug mode uses `src/assets/default.json` and the local frontend URL. The backend creates missing configuration defaults. Rebuild with `npm run build` whenever you want the backend-served production frontend to reflect your changes.

## Verify a change

Run checks appropriate to the affected code:

```bash
npm run lint
npm run test:headless
npm test --prefix backend
npm run build
```

Frontend tests use Vitest. The backend suite uses a temporary configuration path so it does not rewrite the running app's saved configuration. Some integration tests require external services; review the repository's [development guide](https://github.com/voc0der/ytdl-material/blob/main/DEVELOPMENT.md) and [contributor guide](https://github.com/voc0der/ytdl-material/blob/main/CONTRIBUTING.md) for their setup and coverage workflow.

Useful focused tools include:

| Tool | Purpose |
| --- | --- |
| `node dev/deps/check-declared.mjs` | Finds imports missing from dependency declarations |
| `node dev/deps/check-cycles.mjs` | Finds runtime frontend import cycles |
| `dev/ldap/ldap-server.sh start` | Starts the local LDAP test directory |
| `docker-utils/container-repro.sh` | Reproduces downloader behavior inside the published container |
| `dev/screenshots/*.sh` | Stages local UI scenarios and captures screenshots |

## API models and translations

Update `Public API v1.yaml` when changing the documented API, then run `npm run generate` to regenerate TypeScript models under `src/api-types`. Keep authentication and ownership behavior consistent with the route guards.

For UI translation work, preserve Angular i18n markers and `$localize` messages. `npm run i18n-source` extracts the English XLIFF source under `src/assets/i18n`; the build's preprocessing creates the runtime JSON files. Do not treat generated JSON translations as the primary source.

Documentation development has its own [small build workflow](documentation.md) and does not require installing Angular or starting the app.
