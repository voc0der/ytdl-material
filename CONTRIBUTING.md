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

Each of these workflows fails on findings, except CodeQL, whose findings go to code
scanning. Fix a finding where you can; each tool's way to record a reviewed false
positive is described below. Renovate merges its own PRs only once every check passes,
so add any new workflow that runs on PRs to the `workflow_run` list in
[renovate.yml](.github/workflows/renovate.yml).

| Workflow | Finds | Runs on |
| --- | --- | --- |
| CodeQL | JavaScript data-flow problems | PRs, pushes to `main`, weekly |
| Dependency Audit | Known vulnerabilities in npm packages: on PRs, only in packages the PR adds or changes | PRs, pushes to `main`, daily |
| Gitleaks | Credentials committed anywhere in the history | PRs, pushes to `main` |
| zizmor | Workflow problems such as injection, broad permissions, persisted credentials, and unpinned actions | PRs and pushes that change `.github/`, weekly |
| Container Scan | Known vulnerabilities in the published `latest` and `nightly` images (Grype) | Daily |

Releases also scan the image with Grype before anything is published (see
[Container Scan](#container-scan)). Scheduled runs catch advisories published since the
code last changed.

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
