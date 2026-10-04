<!-- Verified 2026-10-04 against 0acc20f. Refresh with /refresh-agents-md after a wave of changes. -->

## equipment-supply

Digital equipment issuance system for the Israeli Ministry of Defense: a warehouse manager assigns SAP issuances to couriers, couriers deliver from a tablet and collect a signature, also while offline. Two npm packages share one backend: `client/` (React 18, Vite, MUI 5, RTL Hebrew UI) and `server/` (NestJS 10, TypeORM 0.3, PostgreSQL 16), with the shared types and the Hebrew dictionary in `shared/`. `README.md` is the entry document and `docs/README.he.md` keeps the original Hebrew spec. Implementation plans go to `docs/plans/`.

## Policy

- Do not settle an open product question in code. The list is `## Open decisions` in `README.md`: add the question there and ask.
- Where `README.md` and the Figma exports disagree, the exports win. They live in `design/`, untracked because of size; ask for the folder if it is missing.

## Where things are

- `shared/@core.ts`: every enum and API contract both sides import. Change the contract there first.
- `server/src/issuances/issuance.rules.ts`: the status transition table. A new manager action adds a row there, never an inline status check.
- `server/src/env.ts`: the only reader of the LOCAL / production switches. New environment dependent behaviour goes through it.
- `server/src/migrations/` and `server/src/data-source.ts`: hand written TypeORM migrations and the CLI DataSource.
- `client/src/courier/offline/`: the IndexedDB data layer and the sync worker. Its conflict rules are deliberate, read `## Offline courier work` in `README.md` before changing them.

## Running and verifying

- There is no root package. Run `npm install`, `npm test` and builds inside `client/` and `server/` separately.
- Start PostgreSQL with `docker compose up -d` before `npm test` in `server/`: jest runs the e2e specs too. `npm run test:unit` needs no database. The host port is 5433, not 5432.
- The server e2e suite creates and truncates `equipment_supply_test`. Never point it at `equipment_supply`; re-seed the test database (`DB_NAME=equipment_supply_test npm run seed`) before manual checks against it.
- `npm run seed` truncates every table and only runs with `ENVIRONMENT=LOCAL` and `ALLOW_DESTRUCTIVE_SEED=true`.
- LOCAL rebuilds the schema with TypeORM `synchronize`; nothing else does. Every entity change also needs a migration in `server/src/migrations/`.
- The production entry is `node dist/server/src/main.js`, not `dist/main.js`: nest-cli `sourceRoot` is `server/src` because `../shared` is compiled too.
- The service worker exists only in the production build (`devOptions.enabled` is false in `client/vite.config.ts`). Test offline behaviour with `npm run build` and `npm run preview`, not the dev server.
- The project runs on Node 20 (README).
- Every change that adds or removes tests also updates the counts and descriptions under `## Tests` in `README.md`; the commit history keeps them current.

## Conventions that differ from defaults

- Server payloads are plain `any` checked by hand in `*.validation.ts` files (`server/src/delivery/attempt.validation.ts`); no DTO classes, no class-validator.
- Every issuance mutation and every delivery report runs in one transaction that first locks the issuance row with `lockIssuance` (`server/src/issuances/issuances.service.ts`), then the task. Keep that order.
- Every UI string goes through `t("key")` with the key in `shared/i18n/he.ts`.
- Breakpoints only through the `bp` mixins in `client/src/styles/_breakpoints.scss` and `useBreakpoint()` in `client/src/utils/useBreakpoint.ts`; no raw `@media` numbers.
- No formatter is configured, so match the file: client 2 spaces and double quotes, server 2 spaces and single quotes, SCSS 4 spaces; comments explain why, in lowercase English; top level functions are separated by a `/*──...──*/` line.

## Known pitfalls

- A single class rule on a MUI component loses the specificity tie to emotion. Qualify it (`.x__menu.MuiIconButton-root`) or nest it as `client/src/styles/_basic.scss` does.
- `overflow-x: clip` (with `hidden` as fallback) belongs on `html` only. On `body` every `position: sticky` breaks and phones zoom out.
- TypeORM `skip` / `take` paginates joined rows once ORDER BY touches a joined column. Sort items in JS as `issuances.service.ts` does.
- Saving a task loaded with `attempts: []` after inserting an attempt nulls the new attempt's FK. Use `em.update` inside the transaction instead of `save`.
- `@CreateDateColumn()` columns are `timestamp` without time zone and read 3h off on a local machine. Do not assert exact wall clock values in e2e.
- The 409 answers for a partially delivered issuance (assign, delete, self pickup) and the permanent `conflict` of a queued report whose task was reassigned are deliberate, not bugs.
