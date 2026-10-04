---
name: qa-e2e-tests
description: 'Generate automated API and end-to-end tests for features that are already implemented in this repository. Use when the user says "create qa automated tests for [feature]", "add tests for [feature]", "cover [screen/endpoint] with tests", or asks to raise test coverage of existing code. Not for TDD on new code and not for code review.'
---

# QA: generate tests for implemented features

Standalone adaptation of BMAD's `bmad-qa-generate-e2e-tests` (MIT). The BMAD runtime (`_bmad/`, `uv`, config resolution) was removed; the project facts below replace it.

**Goal:** add API and end-to-end tests for code that already exists, run them, and leave them green.

**Role:** QA automation engineer. Generate and run tests only. No refactoring of production code beyond what a test needs (a missing `aria-label`, a test id), and no code review: that is `/code-review`.

## Project facts (read before anything else)

Two packages, no root `package.json`. Everything runs inside `client/` or `server/`.

### server (NestJS 10, jest + supertest)

- Config is in `server/package.json` under `jest`: `rootDir: src`, `testRegex: .*\.spec\.ts$`, `testTimeout: 60000`.
- Unit specs sit next to the code (`server/src/delivery/attempt.validation.spec.ts`). They need no database: `npm run test:unit`.
- E2E specs live in `server/src/e2e/*.e2e.spec.ts`. They boot the real application with supertest against the database `equipment_supply_test`, which they create and truncate themselves. Each spec starts with `import './setup-env'` as its first line and carries its own `ensureTestDatabase()` plus `beforeAll` that compiles `AppModule`. Read `server/src/e2e/couriers.e2e.spec.ts` first for that bootstrap, the token setup and the cleanup, then follow it exactly.
- Before `npm test` or `npm run test:e2e`: `docker compose up -d` at the repo root. The host port is 5433, not 5432. Never point a test at `equipment_supply`.
- Run with `--runInBand` (the npm scripts already do). Tests share one database.
- `@CreateDateColumn()` columns are `timestamp` without time zone and read 3h off on a local machine. Never assert exact wall clock values.
- Status transitions come from `server/src/issuances/issuance.rules.ts`. The 409 answers for a partially delivered issuance (assign, delete, self pickup) and the permanent `conflict` of a queued report whose task was reassigned are deliberate. A test must expect them, not "fix" them.
- Payloads are plain objects checked by hand in `*.validation.ts`. Error cases to cover are the ones those files reject.

### client (React 18 + Vite, vitest on jsdom)

- `npm test` in `client/` runs vitest. Setup file: `client/src/test/setup.ts` (installs `fake-indexeddb` and node webcrypto). Specs sit next to the code as `*.spec.ts` / `*.spec.tsx`.
- Existing specs cover the offline layer (`client/src/courier/offline/*.spec.ts`) and two components (`client/src/components/FindNumberDialog.spec.ts`, `QrCamera.spec.ts`). Read `store.spec.ts` for the IndexedDB fixture pattern and `FindNumberDialog.spec.ts` for the component pattern before writing either kind.
- The component specs render with `createRoot` + `act` from React itself, inside `StrictMode`, and mock `react-i18next` so `t(key)` returns the key. No testing-library is installed. Follow that pattern for one or two small components. For a page level flow (form fill, dialog open and close, navigation) propose installing `@testing-library/react`, `@testing-library/jest-dom` and `@testing-library/user-event` as devDependencies and wait for the user's yes before `npm install`.
- Every UI string goes through `t("key")` with the key in `shared/i18n/he.ts`. With the i18n mock in place, locate elements by role, label or the i18n key text; without the mock, by the Hebrew value from that file. Never by CSS class. The UI is RTL; do not assert on left/right geometry.
- MUI components render portals (dialogs, menus, selects). Query with `screen` from testing-library, not from the container.
- Real browser end-to-end tests do not exist and Playwright is not installed. The service worker exists only in the production build (`devOptions.enabled` is false in `client/vite.config.ts`), so anything about offline reload, Web Locks across tabs or `navigator.storage.persist` can only be tested against `npm run build && npm run preview` (port 4173, see `.claude/launch.json`). If the user asks for that kind of test, propose adding Playwright under `client/` targeting the preview server, and get a yes before adding the dependency. Otherwise stay in vitest.

### shared

- `shared/@core.ts` holds every enum and API contract. Import types from there in tests instead of redeclaring shapes.

## Workflow

### Step 1: scope

Ask, or take from the request, exactly one of:

- a feature or screen name (for example "manager bulk assign", "courier delivery report"),
- an endpoint or controller,
- a directory to scan.

If the request names nothing, list the uncovered areas you find (controllers without an e2e spec, pages and dialogs without a component spec) and ask which one. Do not auto-pick.

### Step 2: read before writing

- The production code of the feature and the rules it depends on (`issuance.rules.ts`, the relevant `*.validation.ts`, the i18n keys it renders).
- The closest existing spec of the same kind. Copy its structure, helpers and naming.
- The `## Tests` section of `README.md` to see how the suite is described.

### Step 3: API tests (server)

For each endpoint of the feature:

- Happy path with the role that owns it.
- The role that must be refused (manager route called by a courier and the reverse) expecting 403, and no token expecting 401.
- One or two malformed bodies taken from the matching `*.validation.ts`, expecting 400.
- The domain 409 where the transition table defines one.
- Assert the response shape against the type in `shared/@core.ts` and the row state in the database when the endpoint writes.

### Step 4: UI tests (client)

For each screen or dialog of the feature:

- Render with the providers the real app uses (router, i18n, theme). Build a small `renderWithProviders` helper in the spec if none exists yet.
- Drive the user flow with `user-event`: open, fill, submit, see the result. Mock `axios` at the module boundary, never the components.
- Assert visible outcomes: text, enabled or disabled buttons, a dialog that closed. Not internal state.
- One error path: the API answers 4xx and the user sees the Hebrew message.
- Keep each test linear. No shared mutable state between tests. No `setTimeout` waits, use `findBy*` and `waitFor`.

### Step 5: run

- server: `npm run test:unit` for unit specs, `npm run test:e2e` for e2e, inside `server/` with the database up.
- client: `npm test` inside `client/`.

Run the whole package suite, not only the new file, so a shared fixture you touched does not break an older spec. A failing test is fixed before anything else. If the failure is a real bug in production code, stop, report it with the failing assertion, and do not change production code to make the test pass.

### Step 6: report

In the final message, and in the `## Tests` section of `README.md` where the project keeps its suite description and counts:

- Files added, one line each with what they cover.
- New totals per package (the README states them and the commit history keeps them current).
- What was left uncovered and why (needs Playwright, needs a product decision, needs the SAP interface).

## Checklist before you say done

- [ ] New specs follow the neighbouring spec's structure and helpers.
- [ ] Happy path plus the 401/403, 400 and domain 409 cases that exist.
- [ ] UI tests locate by role or Hebrew text from `shared/i18n/he.ts`.
- [ ] No wall clock assertions, no sleeps, no order dependency between tests.
- [ ] The full package suite is green, not only the new file.
- [ ] README `## Tests` counts and descriptions updated.
- [ ] No production code changed except test hooks, and those are listed in the report.
