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
- Run `CHROMIUM_BIN="$(command -v chromium || command -v chromium-browser)" npm run test:headless`
- Run `npx ng build --configuration production`
- If backend JavaScript changed, run `node --check` on each touched backend file

## Notes

- The repo test defaults use `Chromium` / `ChromiumHeadless` instead of Chrome-branded launchers.
