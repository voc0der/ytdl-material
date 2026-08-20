<h1>Development</h1>

- [Setup](#setup)
- [Running locally](#running-locally)
- [Visual Studio Code](#visual-studio-code)
- [Deploy changes](#deploy-changes)

# Setup
Checkout the repository and navigate to the `ytdl-material` directory.
```bash
vim ./src/assets/default.json # Local dev config used when YTDL_MODE=debug
npm ci
npm ci --prefix backend
npm run build # Build frontend assets once if you want the backend to serve the UI on :17442
```
This step only needs to be repeated when dependencies change.

# Running locally
Frontend dev server:
```bash
npm start
```

Backend in debug/local-config mode:
```bash
cd backend
npm run debug
```

If you prefer to use the backend-served UI instead of `ng serve`, rebuild the frontend from the repo root with `npm run build`.

# Visual Studio Code
Open the `ytdl-material` directory in Visual Studio Code.

- Use the `Dev: Debug Backend` launch configuration to start the backend with `YTDL_MODE=debug`.
- Use the `Dev: start frontend` task to run `ng serve`.
- Use the `Dev: build frontend for backend` task when you need fresh compiled assets in `backend/public`.

# Deploy changes

Navigate to the `ytdl-material` directory and run `npm run build`. Restart the backend.

Simply restart the backend.

# Reproducing a user's container

Most bug reports are "downloads fail in Docker", and the useful first move is to stand up
the reporter's environment rather than reason about it. `docker-utils/container-repro.sh` does that:

```bash
docker-utils/container-repro.sh --channel stable --download          # does a real download 403?
docker-utils/container-repro.sh --channel nightly --download         # does a newer yt-dlp fix it?
docker-utils/container-repro.sh --local --channel nightly            # test uncommitted backend changes
docker-utils/container-repro.sh --uid 1026 --gid 100 --keep          # NAS-style ids, leave it running
```

It boots a throwaway container, waits for the yt-dlp update check, then asserts the app
runs as the configured UID/GID, that the channel was applied, and that the installed yt-dlp
matches that channel's latest upstream tag. `--download` additionally attempts a real
download and distinguishes an HTTP 403 from other failures.

`--local` mounts the working tree's `backend/*.js` over `/app` in the published image, so
backend changes can be exercised without rebuilding. The entrypoint logs `chown: ...
Read-only file system` warnings for those mounts; that is expected.

This is intentionally not part of CI. The download check depends on YouTube's current
behavior, so it would fail for reasons unrelated to any given change.

## Things worth knowing before debugging a 403

- **The image tag does not control yt-dlp.** `voc0der/ytdl-material:nightly` versions the
  app; yt-dlp is downloaded separately, and defaults to the latest *stable* release. Use
  `ytdl_ytdlp_update_channel` to move it. See `docker-environment.md`.
- **403s are format-dependent.** Stable `2026.07.04` returns 403 for higher-resolution
  formats (e.g. `400+251`) while lower-resolution ones (e.g. `395+251`) still succeed, so
  "it works for me" does not disprove a report. Always reproduce with the reporter's URL.
- **Running the backend test suite rewrites `backend/appdata/default.json`**, stripping
  retired keys and self-healing missing ones. Check `git diff` on it before committing.

# A local LDAP server

`ytdl_auth_method: ldap` was the one auth path with no way to exercise it, which is why it
went so long without anyone confirming what it actually does — and why replacing the LDAP
client underneath it had to wait. `dev/ldap/ldap-server.sh` builds a throwaway OpenLDAP and
seeds it:

```bash
dev/ldap/ldap-server.sh start     # builds on first run (~2 min), then listens on :3389
cd backend && npm test            # backend/test/ldap.test.js now has a directory to talk to
dev/ldap/ldap-server.sh stop
```

`start` reseeds from `dev/ldap/fixtures/seed.ldif` every time, so the directory is the same
on every run and tests never have to clean up after each other. `status` shows the seeded
uids, `search` runs `ldapsearch` as the admin account, and `clean --all` removes everything
including the build.

Nothing lands in the repo or in system directories: the tarball, the compiled OpenLDAP and
the directory data all live under `~/.cache/ytdl-material/openldap`. It is built from
source rather than installed because it needs no root that way, and pinned by SHA3-512 so a
substituted tarball fails the build.

`backend/test/ldap.test.js` skips itself when nothing is listening on the configured URL,
so CI and anyone who has not started the server are unaffected. Point it elsewhere — a real
directory, or a second instance — with the `YTDL_TEST_LDAP_*` variables that
`dev/ldap/ldap-server.sh env` prints.
