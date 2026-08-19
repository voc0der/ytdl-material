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
- Run `npx ng build --configuration production`
- If backend JavaScript changed, run `node --check` on each touched backend file

## Notes

- Frontend tests run on Vitest in a jsdom environment, so no browser install is needed.
- Component specs call `configureTestBed()` from `src/testing/test-bed.ts` rather than
  `TestBed.configureTestingModule` directly, which is what supplies the shared service stubs.
