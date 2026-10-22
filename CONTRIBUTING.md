# Contributing

For setup and local run instructions, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Rules

- Keep branches, commits, and PRs focused. Do not mix unrelated local changes into the same PR.
- Use semantic names by default.

## Naming

- Branches: `fix/<scope>-<summary>`, `feat/<scope>-<summary>`, `refactor/<scope>-<summary>`
- Commits: `fix(scope): summary`, `feat(scope): summary`, `refactor(scope): summary`
- PR titles: `fix(scope): summary`, `feat(scope): summary`, `refactor(scope): summary`

## Before Opening a PR

- Run `npm run lint`
- Run `npx tsc -p src/tsconfig.app.json --noEmit`
- Run `npx tsc -p src/tsconfig.spec.json --noEmit`
- Run `npm run test:headless`
- Run `npm run package:extension` and `npm run test:extension` when browser extension files change
- Run `npx ng build --configuration production`
- If backend JavaScript changed, run `node --check` on each touched backend file

## Security scans

Each of these workflows fails on findings. Fix a finding where you can; each tool's way
to record a reviewed false positive is described below. Renovate merges its own PRs only
once every check passes, so add any new workflow that runs on PRs to the `workflow_run`
list in [renovate.yml](.github/workflows/renovate.yml).

| Workflow | Finds | Runs on |
| --- | --- | --- |
| CodeQL | JavaScript data-flow problems ([below](#codeql)) | PRs, pushes to `main`, weekly |
| Dependency Audit | Known vulnerabilities in npm packages: on PRs, only in packages the PR adds or changes | PRs, pushes to `main`, daily |
| Gitleaks | Credentials committed anywhere in the history | PRs, pushes to `main` |
| zizmor | Workflow problems such as injection, broad permissions, persisted credentials, and unpinned actions | PRs and pushes that change `.github/`, weekly |
| Fuzz | Inputs that break a security property of backend code that handles requests and stored records ([below](#fuzz-tests)) | PRs that change backend code; nightly after `main` changes |
| ZAP | Missing security headers, weak cookies, and information leaks in the app as built | PRs that change the app or the image |
| Container Scan | Known vulnerabilities in the published `latest` and `nightly` images (Grype) | Daily |

Releases also scan the image with Grype before anything is published (see
[Container Scan](#container-scan)). Scheduled runs catch advisories published since the
code last changed.

### CodeQL

CodeQL uploads its results to code scanning, and the job then fails while any CodeQL alert
is open on the ref it analyzed (for a PR, the merge result). Fix a finding; for a
reviewed false positive, dismiss the alert in code scanning with the reason in its
comment, which closes it everywhere. `main` has no open alerts, and the six dismissed so
far all trace back to test code or the screenshot harness.

### Dependency Audit

On a pull request, GitHub's dependency review compares the PR's dependencies with its base
branch and fails on a high or critical advisory against any package version the PR brings
in, from either lockfile. An advisory against a package `main` already has is not the PR's
doing, so it fails the runs on `main` instead: on every push and daily, `npm audit` fails on
high or critical advisories for any package in `package-lock.json` or
`backend/package-lock.json`, development packages included, since they run during builds
and tests. `npm audit` can't ignore an advisory, so update the dependency; Renovate opens
security updates without the usual three-day wait. Locally:

```bash
npm audit --audit-level=high
(cd backend && npm audit --audit-level=high)
```

### Gitleaks

Gitleaks scans every commit reachable from the checkout (for a PR, the merge result) and
redacts what it finds in the log. Locally it reads only committed changes:

```bash
docker run --rm -v "$PWD:/repo:ro" "$(sed -n 's/^ *GITLEAKS_IMAGE: //p' .github/workflows/gitleaks.yml)" git /repo --log-opts=HEAD --redact --verbose
```

A reviewed placeholder goes in [.gitleaks.toml](.gitleaks.toml), matched by both file and
exact value. Revoke a real credential first, then remove it from the PR branch's commits.
If it has already reached `main`, add the finding's `Fingerprint` to
[.gitleaksignore](.gitleaksignore) instead, with the reason above it.

### zizmor

zizmor runs the release that zizmor-action pins. Its online audits, which also check the
pinned actions for known vulnerabilities, need a GitHub token; without one, zizmor runs
offline. Every action is pinned to a commit, with the version in a comment that Renovate
reads and updates. Silence a reviewed finding with `# zizmor: ignore[<audit>]` on the
flagged line and the reason above it. Use [.github/zizmor.yml](.github/zizmor.yml) only
where that line can't take the comment, such as a `uses:` line that ends in the version
comment.

```bash
GH_TOKEN="$(gh auth token)" uvx zizmor .
```

### Container Scan

Container Scan and the release scan fail on high or critical vulnerabilities that have a
fix. A failing scheduled scan means a published image needs rebuilding: run the nightly
build (`gh workflow run docker.yml`) for `nightly`, and cut a release for `latest`. Record a
reviewed false positive as an `ignore` rule in a `.grype.yaml` at the repository root. To
scan a local build the same way with [Grype](https://github.com/anchore/grype):

```bash
docker buildx build --pull --load -t ytdl-material:local .
grype docker:ytdl-material:local --fail-on high --only-fixed
```

Without `--pull`, an outdated cached base image can report vulnerabilities that CI's build
doesn't have.

A tag's **continuous integration** run builds and scans the image before it creates the
GitHub release and starts the image push. A finding there stops the release before
anything is published. Fix it on `main`, delete the tag (`git push --delete origin <tag>`),
and tag the fixed commit.

### ZAP

ZAP runs its passive baseline scan against a disposable container of the image built from
the PR, started with the image's default settings, so it sees what a visitor to a fresh
install sees. ZAP and its rules are pinned (`-silent` stops add-on updates), so a result
changes only with the app or the pin. Any warning fails;
[dev/zap/rules.tsv](dev/zap/rules.tsv) lists reviewed rules, where `IGNORE` silences a rule
and `INFO` reports it without failing, each with its reason. The missing Content Security
Policy and anti-framing header are `INFO`: a policy needs testing page by page, and
dashboards such as Organizr show the app in a frame. The scan needs Docker and pulls the
ZAP image, several GB unpacked:

```bash
npm run scan:zap                      # builds ytdl-material:local, then scans it
bash dev/zap/scan.sh <image>          # scans an image you already have
```

### Fuzz tests

The `backend/test/fuzz-*.test.js` files hold [fast-check](https://fast-check.dev)
properties: each asserts a security property over inputs it generates. They run with the
regular tests on a fixed set of inputs, so a PR never fails on an input an earlier run
happened not to draw, and under [dev/fuzz/run.sh](dev/fuzz/run.sh) for a set time each,
from a fresh seed.

| Property | Holds that |
| --- | --- |
| Download arguments | Custom arguments the allowlist accepts reach yt-dlp, as its parser reads them, as allowed options only; additional arguments add no other option and take none of the app's as a value; the allowlist's options that take a value are all known to the code that places them |
| Subscription arguments | Whatever a stored subscription holds, only allowed options reach yt-dlp |
| Output templates | A template the check accepts writes inside its download folder, whatever its fields expand to and wherever the folder's links point |
| Media paths | A path counts as inside the media roots exactly when the file the OS opens for it is, and only regular files inside them are served |
| Subscription folders | A subscription's name becomes one folder inside its type folder, whatever the name and the filename settings |
| Byte ranges | A 206 answers with a range inside the file, of the length sent |
| Logged command lines | A credential passed to yt-dlp never reaches the log, however its option is written |
| Rate limits | A limiter is skipped by path alone, never for a query or fragment, and never for a route that checks a credential |
| Trusted proxy addresses | An address is trusted only inside a listed range, however a dual-stack socket writes it |

PRs that change backend code run each property for 10 seconds; the nightly run gives each
2 minutes, on nights after `main` has changed. A failure prints the smallest input
fast-check could shrink it to, with the `FUZZ_SEED` and `FUZZ_PATH` that replay it, and CI
keeps the report as the run's `fuzz-failures` artifact. Add the input to the property's
examples with the fix: from then on it runs with the regular tests. A new `fuzz-*.test.js`
file needs no registration.

```bash
npm run fuzz                          # each property for 10s
FUZZTIME=2m npm run fuzz              # as long as the nightly run
cd backend && FUZZ_SEED=<seed> FUZZ_PATH=<path> npx mocha test/fuzz-files.test.js
```

## Coverage

The README badge is a **line coverage** figure across both trees, produced by:

```bash
dev/ldap/ldap-server.sh start        # optional, see below
dev/coverage/coverage.sh             # or: coverage.sh frontend | coverage.sh backend
```

It prints a per-tree breakdown, the combined number, and the exact shields.io URL to paste
into the README. Nothing about this runs in CI — see the note at the end.

### How the number is defined

- **Line coverage**, not statements or branches. It is what people assume a coverage badge
  means, and it is the one metric c8 and Vitest's v8 provider report identically.
- The combined figure is `covered lines / total lines` **summed across both trees**, not the
  average of the two percentages. Averaging would let the smaller tree swing the result.
- Files with no tests at all are counted, at 0%. A coverage number that only looks at files
  someone already wrote a test for measures nothing.

### What is excluded, and why

| Excluded | Reason |
| --- | --- |
| `src/**/*.spec.ts`, `src/testing/**`, `src/test-setup.ts` | The tests and their scaffolding |
| `src/api-types/**` | Generated from `Public API v1.yaml`; ~137 DTO files that would dominate the frontend figure |
| `src/**/*.d.ts` | Type declarations, no runtime code |
| `backend/test/**` | The tests |
| `backend/public/**` | The compiled frontend bundles, which would swamp everything else |
| `backend/*.config.js` | Process-manager configuration, not application logic |

Everything else counts, including `main.ts`, the environment files, and every
untested component and backend module.

### Three things that make the number wrong if you ignore them

**Start the LDAP server first.** `backend/test/ldap.test.js` skips itself when there is no
directory listening, so `authentication/ldap.js` reads as almost entirely uncovered without
one. `coverage.sh` warns when it cannot find a server, and picks up the URL from
`dev/ldap/ldap-server.sh env` when it can — including a non-default port.

**Watch for "missing from the report".** A file that is on disk but absent from the lcov
output is not counted as uncovered, it is not counted at all, which inflates the result.
`coverage.sh` lists any such file. There are none at the moment; the last was
`src/app/components/duplicates/duplicates.component.ts`, until it got a spec.
`@vitest/coverage-v8` hands files no test loaded to rolldown's parser without saying which
language they are, so it parses them as JavaScript and fails on `implements`. Any untested
component can fall out of the report the same way, which makes the printed figure higher than
the true one. A spec that loads the file puts it back.

**Name the script when a test loads a module through `vm`.** Some backend tests run a
module's source in `vm.runInNewContext` to hand it stub dependencies. Without a `filename`
option, V8 reports that code as `evalmachine.<anonymous>`, so the module reads as 0% however
thoroughly the test exercises it. Pass `{filename: path.join(root, 'module.js')}` and c8
attributes it to the file on disk.

### Expect the last digit to move

Consecutive runs land within about ±0.1% of each other — parts of the backend suite are
timing-dependent, so a handful of lines are hit on one run and not the next. Round down when
the badge lands between two values, and do not chase a tenth of a percent.

### After running it

Nothing. A run leaves the working tree clean.

It did not always: the backend suite used to rewrite `backend/appdata/default.json` and
regenerate the sample media in `backend/test/` with ffmpeg, whose output is not byte-stable.
`coverage.sh` still checks those paths afterwards, but as a canary -- it now says nothing
unless something has regressed.

### Why this is not in CI

The number moves slowly enough that a manual refresh when the badge looks stale is a better
trade than a job on every PR. Update the badge in the same PR as whatever moved it.

## Notes

- Frontend tests run on Vitest in a jsdom environment, so no browser install is needed.
- Component specs call `configureTestBed()` from `src/testing/test-bed.ts` rather than
  `TestBed.configureTestingModule` directly, which is what supplies the shared service stubs.
- Backend tests that need the server itself, not one module, boot `app.js` with `startApp()`
  from `backend/test/helpers/app-process.js` and send it real requests. It runs in a child
  process with its own working directory, config and media folders, so nothing it writes
  outlives the test, and c8 follows the child, so `app.js` counts toward coverage.
- There is no MongoDB in CI, so backend tests that need one use the in-memory stand-in in
  `backend/test/helpers/fake-mongo.js`: `useFakeMongo()` points `db.js` at it for a describe
  block, and `helpers/fake-mongo-server.js` does the same for a `startApp()` server when passed
  as its `preload`. It follows MongoDB's rules for the driver calls `db.js` makes and throws on
  any other, so a change that has `db.js` use more of the driver extends it there.
