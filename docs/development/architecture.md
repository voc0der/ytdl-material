# Architecture

ytdl-material consists of an Angular browser app, an Express backend, a database abstraction, and external media tools. The backend serves the production frontend as well as its API.

## Request and download flow

1. The browser sends an API request through `PostsService`.
2. Authentication establishes the caller, and route guards enforce permissions and ownership.
3. The downloader queues work and starts the selected media tool.
4. Media and metadata are saved to the configured filesystem paths.
5. Library and archive records are written through the database layer.
6. The frontend refreshes progress, while notification integrations report enabled events.

## Source map

| Location | Responsibility |
| --- | --- |
| `src/app/posts.services.ts` | Frontend API calls and shared application state |
| `src/app/app.routes.ts` | Frontend routes |
| `src/app/components/` | Shared controls, library, downloads, tasks, and settings panels |
| `src/app/player/` | Playback, queue, chapters, subtitles, and editing controls |
| `backend/app.js` | Startup, HTTP routes, streaming, configuration application |
| `backend/config.js`, `backend/consts.js` | Defaults, migrations, and setting registry |
| `backend/authentication/` | Internal, LDAP, and OIDC login; tokens and route guards |
| `backend/downloader.js` | Download queue, argument construction, metadata registration |
| `backend/subscriptions.js` | Refresh lifecycle, missing-item collection, queueing |
| `backend/files.js` | Library operations, playlists, imports, media editing |
| `backend/archive.js` | Database-backed download history and legacy archive import |
| `backend/tasks.js` | Task execution, confirmation, recurring and one-time schedules |
| `backend/db.js`, `backend/postgres-store.js` | Storage abstraction and PostgreSQL adapter |
| `backend/redis-store.js`, `backend/rate-limit-store.js` | Optional shared limiter storage and fallback |
| `backend/transcoding.js` | Encoder/decoder checks and ffmpeg hardware options |
| `backend/notifications.js` | Event delivery and webhook templates |
| `backend/entrypoint.sh`, `Dockerfile` | Container dependencies, permissions, and startup |

## State boundaries

The database holds records about files, downloads, users, playlists, subscriptions, tasks, categories, archives, and tokens. Media bytes and sidecars remain on disk. Backups and migrations must account for both.

General API tokens and RSS tokens identify an account; they are not additional roles. The same route guards apply to browser and script access. Share links are restricted to selected media endpoints. Single-user mode intentionally bypasses account-based authorization.

The scheduler uses Croner and saves schedules with task records. Redis is only used for HTTP rate limiting. It does not coordinate subscription workers or provide a distributed download queue, so enabling Redis does not establish support for multiple independent app replicas sharing one library.

## Release and deployment

The build workflow compiles and packages the app. Docker workflows publish multi-architecture images; release version constants are present in both package manifests and backend constants. Consult [existing workflows](https://github.com/voc0der/ytdl-material/tree/main/.github/workflows) before changing release behavior.

The documentation is a separate static build. It deploys through its own GitHub Pages workflow and does not load the application database or configuration.
