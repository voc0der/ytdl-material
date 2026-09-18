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

# Checking for import cycles

Two frontend modules that import each other work everywhere except a production build. The dev
server and the unit tests evaluate modules in an order where both are defined by the time either
needs the other; the production bundle can put one first, and a standalone component's `imports`
then holds `undefined` where the other component should be. Angular reports that as NG0919
("Cannot read @Component metadata") the first time the component renders. The playlist editor
embedded the media library that opens it, and New playlist opened an empty dialog in releases
only.

```bash
node dev/deps/check-cycles.mjs
```

It walks every runtime import under `src/app` -- type-only imports are erased and cannot form a
cycle -- and exits non-zero naming each group of files that can reach itself. Worth a run after
moving a component into another's template, or whenever a production build shows an NG0919 that
`ng serve` does not. Like `check-declared.mjs`, it is not part of CI.

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

# Exercising the settings page

Settings is the page where a broken control is invisible until someone's server stops doing
what they told it to: every row writes into one config object, and one Save writes that object
to disk. `dev/screenshots/settings.sh` works it against a throwaway backend:

```bash
dev/screenshots/settings.sh               # build, boot, run, stop
dev/screenshots/settings.sh --skip-build  # reuse the last frontend build
dev/screenshots/settings.sh --keep        # leave the backend running on :17453 afterwards
```

It opens every tab from the rail and checks each one rendered, that the open tab is in the URL
and that a link to one opens on it. It then changes a setting of each kind the page has -- a
toggle, a text field, a picker -- across two tabs, checks the change survives switching between
them, saves once, and reads the config back off the backend to see that each value was stored.
It checks Cancel puts the page back, that the kinds of notification can only be picked when
there is a choice to make, and that the Users tab says why it is unavailable without multi-user
mode. Then the categories list: adding the default set, naming a new one, giving it a rule, and
removing it through its confirmation. Finally the dialogs the page opens -- args, cookies, RSS
and the webhook template -- including that an arg built in the args dialog lands in the field it
was opened from. It checks the Logs tab opens scrolled to the newest line rather than the
oldest one it fetched. Finally it stops the backend and boots it again in multi-user mode for
the single sign-on panel, which only exists with accounts: that it reports whether the provider
could be reached, says each secret is set without printing any of them, fills in the values the
backend falls back to, offers nothing to type into, and is gone entirely when OIDC is off.
Screenshots of every tab, desktop and phone, light and dark, are left in the `shots` folder it
prints.

Like the dialogs harness it downloads nothing, and like all of them it is not part of CI.

## Things worth knowing

- **`--skip-build` reuses the build in the cache dir**, not `backend/public`. Running
  `npm run build` does not update it, so after changing frontend code, run without that flag
  or the harness tests the previous build. Both of the runs that "pass a change that was never
  built" and the ones that "fail a fix that is already in" come from this.
- **Enabling multi-user mode from the page opens the create-admin dialog on save**, because
  that is what the app does when the first admin does not exist yet. The harness therefore
  changes other settings instead; anything driving that toggle has to expect the dialog.
- **OIDC cannot be enabled when the backend boots.** Startup runs discovery against the issuer
  and calls `process.exit(1)` when it fails, so a fake provider takes the server down with it.
  The harness boots with it off and turns it on through `/api/setConfig` afterwards, which is
  also the state the panel has to describe: configured, and not connected.
- **The page holds the config it was handed at startup.** Moving between routes never asks for
  it again, so a config change made behind the page's back needs a reload, not a navigation, to
  show up.

# Exercising the dialogs

The archive is the one screen that is only reachable as a dialog, and what it does is spread
over three endpoints: it lists what has already been downloaded, removes items from that list,
and takes an archive file in or hands one back out. Nothing but running it shows whether those
still line up. `dev/screenshots/dialogs.sh` does that against a throwaway backend, driving the
dialog the way a person would:

```bash
dev/screenshots/dialogs.sh               # build, boot, run, stop
dev/screenshots/dialogs.sh --skip-build  # reuse the last frontend build
dev/screenshots/dialogs.sh --keep        # leave the backend running on :17452 afterwards
```

It seeds 28 archive items, opens the dialog from the toolbar menu, and checks the list, its
pages, searching by title, id and source, sorting, and the type filter -- which is the
server's, not the list's. It then selects a row and removes it through the confirmation,
cancels that and checks nothing went, selects the whole archive and removes it for real,
checks the database is empty and the dialog says so, imports a three-line archive file and
checks one item was recorded per line, and exports one back out and checks the file that was
saved says what went in. It finishes on the two dialogs the Settings page opens that were
rebuilt with it: naming a category, and the webhook template whose fields a toggle turns on.
Screenshots of each, desktop and phone, light and dark, are left in the `shots` folder it
prints.

Unlike the subscriptions and downloads harnesses it downloads nothing from the site, so it
is repeatable offline. It is still not part of CI: it needs Playwright and a production
frontend build, which is a minute of work for a check that belongs to a UI change.

## Things worth knowing

- **An extractor name never has a space in it.** An archive file is `<extractor> <id>` per
  line and the import takes the space as the separator, so a line with two of them is
  skipped. A fixture that names a source "a site" imports nothing at all.
- **"No subscription" is not "all subscriptions".** The backend keeps one archive per
  subscription and filters on `sub_id` exactly, so the unfiltered list is the items that
  belong to no subscription. The picker says so.

# Exercising the notifications

A notification is the only part of the app that appears without anybody asking for it, and the
panel behind the toolbar's bell is where the actions attached to one live: play what finished,
retry what failed, look at the task that ran. None of that is reachable from a page, so nothing
but running it shows whether it still works. `dev/screenshots/notifications.sh` does that
against a throwaway backend:

```bash
dev/screenshots/notifications.sh               # build, boot, run, stop
dev/screenshots/notifications.sh --skip-build  # reuse the last frontend build
dev/screenshots/notifications.sh --keep        # leave the backend running on :17454 afterwards
```

It seeds a library and one notification of each kind -- finished, failed, task -- and checks the
bell counts what has not been read and says so in its label. It opens the panel and checks every
notification is there, newest first, that the unread ones are marked, and that no row runs wider
than the panel or carries its actions off the edge of it. Then it filters by kind and back,
follows the failed download to the Downloads page and the finished one to the player, removes one
notification and clears the rest, checking the backend after each. It also checks that closing
the panel is what marks what was in it read, and the shape of the library cards on the page
behind it. Screenshots at a desktop and a phone width, light and dark, are left in the `shots`
folder it prints.

Like the dialogs and settings harnesses it downloads nothing, and it is not part of CI.

## Things worth knowing

- **An open menu outlives a navigation.** Routing does not close it, and the CDK backdrop then
  swallows every click on the page behind it -- which reads as the app having frozen. Anything
  driving a menu has to put it away before going anywhere else.
- **Closing the panel marks everything in it read**, so the order of the checks matters: the
  unread markers and the count are only there until the first close.
- **The fixture videos are empty files.** The library never opens one, but the player does, and
  it answers a range request over no bytes with a 416. The harness ignores that one error.

# Exercising the library

The playlist editor and the Duplicates page are the library's own tools, and both only show what
they do against a library: the editor picks from every file there is and puts them in order, and
the duplicates page deletes the copies it finds. `dev/screenshots/library.sh` stages one and
works both:

```bash
dev/screenshots/library.sh               # build, boot, run, stop
dev/screenshots/library.sh --skip-build  # reuse the last frontend build
dev/screenshots/library.sh --keep        # leave the backend running on :17455 afterwards
```

It stages the README's library with two of its videos downloaded again, one of them twice. It
opens New playlist from the Playlists tab and checks the editor is there rather than an empty
dialog, that it is dialog-sized, that only its list scrolls, and that searching narrows the list.
Then it picks three files, checks the order and the running time, creates the playlist and reads
it back off the backend. It reopens it with Edit and reorders by dragging and by the arrow keys,
removes a file, reverses the rest and renames it, then checks the backend has exactly that. On the
Duplicates page it checks every duplicated file has a row, the summary counts the extra copies,
and a row opens onto its copies. Then it cleans up one file keeping the first download and the
other keeping the latest, checking which records and which files on disk are left each time,
until the page says there is nothing left. Screenshots at a desktop and a phone width, light and
dark, are left in the `shots` folder it prints.

It downloads nothing, and like the others it is not part of CI.

## Things worth knowing

- **Only a production build shows NG0919.** That is why this builds one rather than pointing
  at `ng serve`, and why its last check is that the page logged no errors at all.
- **The duplicate copies are real files, however empty.** Cleaning up deletes them from disk,
  and a copy that is not there to delete counts as a failure.

# Exercising the login page

The login page only exists with accounts, so it is the one page nothing else here reaches.
`dev/screenshots/login.sh` boots the backend in multi-user mode and works the page:

```bash
dev/screenshots/login.sh               # build, boot, run, stop
dev/screenshots/login.sh --skip-build  # reuse the last frontend build
dev/screenshots/login.sh --keep        # leave the backend running on :17456 afterwards
```

It registers an admin through the API first, then follows a page that needs an account to the
login page. It checks that nothing on the page asked for anything that needs an account, that
the card cannot be submitted empty, and that a wrong password is said on the card without losing
where to go afterwards. Then it registers an account, and on the way checks that clicking into a
password field sends nothing and that passwords that differ are caught before anything is sent.
Finally it logs in with the new account. Every request to register is counted, and the run
expects exactly one. Screenshots at a desktop and a phone width, light and dark, are left in
the `shots` folder it prints.

## Things worth knowing

- **Without an admin the create-admin dialog covers the page.** The app opens it whenever
  multi-user mode has no `admin` account, which is why the harness registers one before it
  opens anything.
- **`/api/auth` allows 25 requests in 15 minutes per address.** A run makes about ten, and the
  count lives in the backend process, so each run starts from zero. A `--keep` backend poked at
  by hand does not.
- **A wrong password used to be a 500.** Login tried LDAP after the local account whatever the
  auth method was, and with no directory there the refused connection became the answer. It is
  only asked when `auth_method` is `ldap` now; the check that the card says the password was
  wrong is what would notice it coming back.

# Exercising the player's list

Autoplay only shows what it does when a video ends, so `dev/screenshots/player.sh` stages a
library whose files really play, and works the list under the player:

```bash
dev/screenshots/player.sh               # build, boot, run, stop
dev/screenshots/player.sh --skip-build  # reuse the last frontend build
dev/screenshots/player.sh --keep        # leave the backend running on :17457 afterwards
```

It opens the README's Space Station playlist and checks the list is headed by it and counts its
place, that each row has the file's thumbnail, length and uploader in the playlist's order, and
that the playing row, and only it, is marked and carries Repeat and Autoplay. Then it plays
another row, turns Autoplay on and waits for the next file to start on its own, turns Repeat on
and waits for the same file to start again, drags a row to another place, and checks theater
mode hides the list. It plays the library's oldest file on its own, checks the list says what
Autoplay would do and that the row offers Watch together, then turns Autoplay on and checks the
library is queued with that file last. It then downloads the file and checks the spinner that
rings the download icon is centred on it. With Autoplay already on as the page opens, it checks
the list has scrolled itself to the playing row without moving the page. Screenshots at a
desktop and a phone width, light and dark, are left in the `shots` folder it prints.

It downloads nothing, and like the others it is not part of CI.

## Things worth knowing

- **It needs ffmpeg.** Every file is the same two-second H.264 clip, made on each run.
- **The browser is started allowing playback without a click.** Otherwise a video that starts
  itself is blocked, and Autoplay has nothing to follow. A person opening the player has clicked
  something already.

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
copy's data and log all live under `~/.cache/ytdl-material/screenshots`. Every harness here
shares that build and the staging code in `dev/screenshots/stage.mjs`.

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
