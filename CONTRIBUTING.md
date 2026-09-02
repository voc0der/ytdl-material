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

Everything else counts, including `main.ts`, `polyfills.ts`, the environment files, and every
untested component and backend module.

### Two things that make the number wrong if you ignore them

**Start the LDAP server first.** `backend/test/ldap.test.js` skips itself when there is no
directory listening, so `authentication/ldap.js` reads as almost entirely uncovered without
one. `coverage.sh` warns when it cannot find a server, and picks up the URL from
`dev/ldap/ldap-server.sh env` when it can — including a non-default port.

**Watch for "missing from the report".** A file that is on disk but absent from the lcov
output is not counted as uncovered, it is not counted at all, which inflates the result.
`coverage.sh` lists any such file. There is currently one:
`src/app/components/duplicates/duplicates.component.ts`. `@vitest/coverage-v8` hands
uncovered files to rolldown's parser without saying which language they are, so it parses
them as JavaScript and fails on `implements`. The file is untested, so the true figure is
marginally *lower* than what is printed. Writing any spec for that component would both fix
the gap and pull it into the report.

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
