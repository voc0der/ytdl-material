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

- **The image tag does not control yt-dlp.** `voc0der/ytdl-material:latest` versions the
  app; yt-dlp is downloaded separately, and defaults to the latest *stable* release. Use
  `ytdl_ytdlp_update_channel` to move it. See `docker-environment.md`.
- **403s are format-dependent.** Stable `2026.07.04` returns 403 for higher-resolution
  formats (e.g. `400+251`) while lower-resolution ones (e.g. `395+251`) still succeed, so
  "it works for me" does not disprove a report. Always reproduce with the reporter's URL.
- **The backend test suite no longer touches `backend/appdata/default.json`.** It runs
  against a throwaway copy (`YTDL_CONFIG_PATH`), because every config write rewrites the
  whole file and a run used to leave whatever a test set last in the tracked one.

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

# Checking dependency declarations

`package.json` is a shopping list, not a record of what the code uses, and nothing ever
checks the list back against the code. A module can therefore be required successfully for
months while being declared nowhere — it arrives hoisted in as somebody else's transitive
dependency, and keeps working right up until that somebody drops or bumps it. The failure
then surfaces in a release that touched something unrelated. `@discordjs/rest` sat like
that in `backend/notifications.js`, supplied only by `@discordjs/core`.

```bash
node dev/deps/check-declared.mjs            # both trees
node dev/deps/check-declared.mjs backend    # one of them
```

It resolves every bare import specifier back to a package name and exits non-zero on any
that `package.json` does not declare, naming the files that import it. Worth a run when
dependencies change, or when a package starts arriving from somewhere new.

It is not part of CI: it reads an installed `node_modules`, so its answer depends on
install state, and the case it catches is rare enough that an occasional manual run is the
better trade.

There is deliberately no check for the opposite case — declared but unused. That cannot be
told apart from legitimate use without a lot of special-casing (`@angular/compiler` is
needed by the build without any file naming it, `openapi-typescript-codegen` is invoked as
the `openapi` binary, `@types/*` are ambient), and a version that tried flagged eleven
frontend packages of which most were load-bearing. Finding genuinely dead dependencies is
`git log -S "require('name')"` work, done by hand.

# Exercising subscriptions

Subscriptions are the hardest part of the app to test by hand: a real one has to be created,
its videos downloaded, checked again for duplicates, edited and removed, and each step takes
minutes of clicking. `dev/screenshots/subscriptions.sh` does the whole round trip against a
throwaway backend, driving the pages the way a person would:

```bash
dev/screenshots/subscriptions.sh               # build, boot, run, stop
dev/screenshots/subscriptions.sh --skip-build  # reuse the last frontend build
dev/screenshots/subscriptions.sh --keep        # stop before unsubscribing, leave it running
dev/screenshots/subscriptions.sh --url URL     # subscribe to another playlist
```

It subscribes from the Subscriptions page with a quality and the automatic playlist chosen
on the page, waits for the downloads, and checks what the backend recorded: that the
subscription was named after the playlist, that the choices made on the page were saved,
that the files landed in its folder with thumbnails, that they were added to a playlist, and
that a second check downloads nothing twice. It then saves a setting from the subscription's
own page, asserts the panel closes and the other settings survive, and unsubscribes, which
must take the files and the folder with it. Screenshots of every page, desktop and phone,
light and dark, are left in the `shots` folder it prints. `--keep` stops before
unsubscribing and leaves the backend up on :17450 to poke at.

It is not part of CI, for the same reason the container repro is not: it downloads from the
site, so it fails for reasons unrelated to any change.

## The playlist it uses

"Space Stars Shine for NASA Spinoffs": four NASA videos, about five minutes in all, roughly
10 MB at the 360p the run picks. NASA material is free to use, which is why the screenshot
fixtures are NASA's too. Any other playlist works with `--url`, but the checks that depend
on knowing the title and the video count are skipped.

## Things worth knowing

- **`max_concurrent_downloads: 0` means no downloads at all**, not "no limit" -- that is
  `-1`. A subscription checked under it queues its videos and they sit there forever. The
  config in `backend/appdata` carried 0 from January until a test run stopped writing to
  it; a backend started from a checkout reads that file, so this is worth a look whenever
  downloads queue and never start.
- **A subscription's videos are downloaded through the download queue**, so they appear on
  the subscription page one at a time, well after the check that queued them reports itself
  finished. The refresh card is what explains the gap.

# Exercising downloads and tasks

The Downloads and Tasks pages are the other two that are tedious to check by hand: a real
download has to be started, paused, failed, retried and cleared, and a task has to find
something before its confirmation step exists at all.
`dev/screenshots/downloads.sh` does both against a throwaway backend, driving the pages the
way a person would:

```bash
dev/screenshots/downloads.sh               # build, boot, run, stop
dev/screenshots/downloads.sh --skip-build  # reuse the last frontend build
dev/screenshots/downloads.sh --keep        # leave the backend running on :17451 afterwards
dev/screenshots/downloads.sh --url URL     # download another playlist
```

It queues the same small NASA playlist the subscriptions harness uses, plus twelve downloads
of a page that is not media at all, which yt-dlp refuses at once. That mixture is what makes
every state on the page reachable without waiting: the playlist gives a running row with
progress and a finished one with per-item progress behind it, the refusals give failed rows,
and because the run holds the queue to one download at a time, the rest are reliably still
queued to be paused. It then works the page -- pause all, resume one row, resume all, open a
failure in full, retry the failures, page back and forth at ten per page, and clear only the
failures -- checking the backend after each one.

For tasks it checks that every task has a card that says what it is for, deletes a
downloaded file from disk and runs Missing files check from its card, which must then offer
to remove exactly what it found and stop offering once that is done. Finally it gives a task
a weekly schedule from the panel on its card, asserts the panel closes on save, that the
backend has the schedule, that the card says when it runs next, that reopening reads it
back, and that turning it off removes it again. Screenshots of both pages, desktop and
phone, light and dark, are left in the `shots` folder it prints.

Like the subscriptions harness it is not part of CI, because it downloads from the site.

## Things worth knowing

- **It holds `max_concurrent_downloads` at 1**, which is what keeps the rest of the batch
  queued long enough to pause. The shipped config allows 5, which would work through the
  batch before the page could be asked to pause any of it.
- **Twelve failures is not an arbitrary number.** It is what puts more than one page of
  rows on the page at ten per page, so the pager has something to page through.
- **A download that cannot start still gets a row.** Failures are rows with a one-line
  summary, not silence; the full error is behind the summary.

# Regenerating the README screenshot

`docs/images/readme-home.png` is generated, not taken by hand. `dev/screenshots/capture.sh`
builds the frontend from the working tree, boots the backend against a staged library, and
captures the home page in headless Chromium:

```bash
dev/screenshots/capture.sh               # build, boot, capture, stop
dev/screenshots/capture.sh --skip-build  # reuse the last frontend build
dev/screenshots/capture.sh --keep        # leave the backend running on :17449 afterwards
```

The first run installs Playwright into `dev/screenshots/node_modules` and downloads its
Chromium. After that a run takes about ten seconds. Nothing it does touches
`backend/public` or `backend/appdata`: the build, the backend copy it runs from, and that
copy's data and log all live under `~/.cache/ytdl-material/screenshots`. Both harnesses
share that build and the staging code in `dev/screenshots/stage.mjs`.

The output is byte-identical between runs, so if a re-run changes the PNG, the page changed.
Commit the image in the same PR as the UI change that moved it. Like the coverage badge, it
is not refreshed in CI.

## The library

`dev/screenshots/fixtures/library.json` holds eight NASA videos and three playlists built
from them, with each video's thumbnail beside it in `fixtures/thumbnails/<id>.jpg`. They
are NASA's because NASA material is free to use. To change what the screenshot shows,
edit that file and add a thumbnail about 640px wide for any new video.

The media files themselves are empty placeholders. The home page never opens one, so a
`--keep` session is a browsable library whose videos do not play.

## Things that will bite you if you change the staging

- **The library is written into the local database, not imported.** An import stamps each
  file with the time it ran, and that is the date the card shows. Fixed timestamps are what
  keep the PNG stable.
- **`appdata/db.json` has to carry the migration flags.** Without them the first boot runs
  the pre-4.3 migrations, one of which rebuilds the local database from `db.json` and
  empties the seeded tables.
- **Every file record needs a `thumbnailURL`.** The card renders no image without one,
  even though the image it then shows is loaded from `thumbnailPath` through the API.
- **The shipped `appdata/default.json` is copied in.** The backend cannot create it on a
  first boot: modules read config as they are required, before anything gets the chance.
