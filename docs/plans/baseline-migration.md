---
title: 'Baseline migration: an empty database is built by migration:run'
type: 'feature'
created: '2026-10-26'
status: 'done'
base: '7a30113'
context: ['AGENTS.md', 'server/src/migrations/1790600000000-OfflineSync.ts', 'server/src/e2e/migrations.e2e.spec.ts', 'docs/domain.md']
---

## Intent

**Problem:** the base tables have no migration (the first deployment ran `synchronize`), so `migration:run` on an empty database stops at `relation "issuances" does not exist`. The docker image of the test box (`docs/deploy-test.md`) cannot build a fresh Neon database, and the AWS environment will hit the same wall.

**Approach:** one hand written migration, `Baseline1790000000000`, older than every existing one. It is all or nothing: on a database without any of the application's tables it creates today's whole schema exactly as `synchronize` generates it from the entities; on a database that already holds the base tables it executes nothing at all, whatever version they are; anything in between is refused. On an empty database the ten later migrations then replay as no-ops over the current schema.

## Boundaries & Constraints

**Always:** the DDL is the schema builder's own SQL on an empty database (`ds.driver.createSchemaBuilder().log()`), in its order, names and types untouched. The existence check reads `information_schema.tables` in `current_schema()` for the twelve tables of the entities (`server/src/entities/index.ts`); the seven base tables are those the ten migrations assume (`issuances`, `issuance_items`, `couriers`, `users`, `delivery_tasks`, `delivery_attempts`, `delivery_attempt_items`; confirm against the entities' table names). The file is frozen once it lands: its header says so, a unit spec pins the SHA-256 of its content (CRLF normalized to LF) and that it is the oldest migration, and `docs/domain.md` and `AGENTS.md` state the rule. Spec files match their neighbours' indentation (e2e specs use 4 spaces).

**Never:** per statement guards as the no-op mechanism (on an older database they would add today's indexes and constraints ahead of the migrations that own them); edit or reorder the ten existing migrations; `migrationsRun` in the app; change entities, `synchronize` rules or the seed guard; a spec file inside `server/src/migrations/` (both migration globs would load it); a `down` that drops anything (it throws: reverting would wipe every table, and on an upgraded database the baseline was recorded over tables it never created); manual checks against `equipment_supply` or `equipment_supply_test` (the e2e suite may use its own databases).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Empty database | no tables, no `migrations` table | eleven run, history in timestamp order, schema equals the reference | No error expected |
| Second run | the same database | nothing executed | No error expected |
| Current database, baseline missing from history | the ten recorded, data in every table | only the baseline runs (TypeORM 0.3.31 runs an older pending migration, its timestamp check is commented out), schema snapshot and data checksums unchanged, history gains one row | No error expected |
| LOCAL synchronize database | current tables with data, no `migrations` table | eleven run, schema and data unchanged | No error expected |
| Before the latest migrations | schema after `XmlOutbox` (the ten's `down` of 10, 9, 8), migrations 1 to 7 recorded, representative rows | baseline executes nothing, 8 to 10 upgrade, schema equals the reference, rows intact as each migration defines | No error expected |
| Before every migration | schema before `OfflineSync` (all ten `down`s), no `migrations` table, representative rows | eleven run, schema equals the reference, rows intact | No error expected |
| Partial database | some base tables, or only later tables | nothing created | throws naming the tables present and missing |
| Revert | baseline the last applied | nothing dropped | `down` throws with the reason and the alternative (drop the database) |

"Equals the reference" means a snapshot, sorted by name and blind to column order, of columns (type, nullability, default), constraints (`pg_get_constraintdef`) and indexes (`indexdef`), identical to the same snapshot of a database `synchronize` built from the entities; the schema builder's pending SQL is also checked (the known `xml_outbox.id` quirk only). "Data unchanged" means per table row count and an md5 over the ordered rows.

## Code Map

- `server/src/migrations/1790000000000-Baseline.ts` (new) -- the baseline
- `server/src/e2e/migrations.e2e.spec.ts` -- existing harness, takes the new file through its glob; reuse its patterns (own database, `pendingSchemaChanges`, the quirk)
- `server/src/e2e/baseline.e2e.spec.ts` (new) -- every matrix row; databases `<DB_NAME_TEST>_baseline` and `<DB_NAME_TEST>_baseline_ref`; a "true no-op" case runs the class's `up` on an existing database through a query runner that records every statement and asserts only the existence check ran
- `server/src/baseline-migration.spec.ts` (new) -- the immutability pin, no database
- `docs/domain.md` `## Schema upgrade`, `README.md`, `docs/deploy-test.md` step 2, `AGENTS.md`

## Tasks & Acceptance

**Execution:**
- [x] `server/src/migrations/1790000000000-Baseline.ts` -- generate on a scratch database, all or nothing check, `down` throws
- [x] `server/src/e2e/baseline.e2e.spec.ts` -- matrix rows plus the recorded statement no-op case; representative rows in every table each scenario has (issuance with items, courier linked to a user, task, attempt with items, and where the shape has them an operation, a conflict, an audit row, an outbox row)
- [x] `server/src/baseline-migration.spec.ts` -- pinned hash, oldest timestamp, the message to write a new migration instead
- [x] `server/src/e2e/migrations.e2e.spec.ts` -- header comment only; its assertions pass unchanged
- [x] docs -- `deploy-test.md` step 2: the first deploy builds the schema, the laptop runs only the seed afterwards (no `DB_SYNCHRONIZE`); `domain.md` eleven migrations and the frozen rule; README counts and mentions; one `AGENTS.md` line

**Acceptance Criteria:**
- Given an empty throwaway database, when `npm run migration:run` runs twice, then the first applies eleven, the second none, and the schema equals the reference.
- Given an empty throwaway database, when the docker image starts on it, then migrations apply and `/api/auth/mode` answers; after `npm run seed` with the LOCAL guard and no `DB_SYNCHRONIZE`, mock login works.
- Given the whole e2e suite, when it runs, then every existing spec passes unchanged.

## Verification

**Commands:**
- `cd server && npx tsc --noEmit -p tsconfig.json` -- clean
- `cd server && npm run test:unit 2>&1 | tail -40` -- green, pin included
- `docker compose up -d`, then `cd server && npm run test:e2e 2>&1 | tail -40` -- green, new spec included
- `migration:run` twice on an empty throwaway database -- eleven, then "No migrations are pending"
- `docker build`, run on a second empty throwaway database, seed, mock login -- per the acceptance criteria

**Manual check, once:** the down chain is a fair stand-in for an old database only if it matches history. Build the schema `synchronize` gives from the entities at the commit just before `OfflineSync` was added (`git worktree` in the scratchpad, throwaway database) and compare its snapshot with the "before every migration" state of the spec. Record the result and any difference in Implementation Notes; do not fix history.

## Implementation Notes

### 2026-10-26

Done as planned: the baseline, the e2e spec with every matrix row and the recorded statement case, the pin, the harness header, the docs.

Decisions:
- The DDL is the 28 statements `createSchemaBuilder().log()` returned on an empty scratch database, written into the file by a script (no hand transcription), one statement per line, byte for byte, the trailing space TypeORM leaves after each `CREATE INDEX` included. The builder returned no parameters.
- The check reads `information_schema.tables` in `current_schema()` with `table_name::text = ANY($1::text[])` over the twelve names. The seven base tables match the entities: the other five are exactly the tables the ten migrations create.
- The partial database error names the present tables (of the twelve) and the missing base tables; a later table is never "missing".
- The `down` message also says how to revert an older migration on an upgraded database (delete the baseline's row first), because there the baseline is the newest row of `migrations` (see Surprises). The e2e checks that this way out works.
- The e2e derives its down chains and recorded histories from the migration timestamps (everything newer than `XmlOutbox1791300000000`, or everything), not from a list of ten, and counts against the loaded migration list: a later guarded migration with a working `down` does not break it.
- "Migrations 1 to 7 recorded" and "the ten recorded" are written by TypeORM's own runner on a DataSource listing only those classes (each runs as a no-op), not by inserts into `migrations`.
- The unit spec is `server/src/baseline-migration.spec.ts` with 4 spaces, like `env.spec.ts` and the other committed unit specs (the uncommitted `data-source.spec.ts` uses 2). The oldest check loads every migration module and takes the timestamp the way TypeORM does, the last 13 characters of `name`.
- `deploy-test.md` step 2 sets `DB_SYNCHRONIZE=false` explicitly rather than leaving it out: dotenv falls back to `server/.env`, which says `true` on a dev laptop, and with `ENVIRONMENT=LOCAL` set for the seed that would run `synchronize` against Neon.

Surprises:
- The schema builder's pending SQL on a fresh `synchronize` schema is four statements, not two: `xml_import_files.id` has the same `gen_random_uuid()` default as `xml_outbox.id` and gets the same `DROP DEFAULT` / `SET DEFAULT` pair. The e2e asserts that the quirk is those two columns and nothing else. The quirk comment inside `migrations.e2e.spec.ts` (xml_outbox only) predates `xml_import_files`; left as is (header only change there).
- On a database upgraded from before the baseline, the baseline row gets the highest id and `migration:revert` (TypeORM reverts the newest id) meets it before the ten, so a revert there is refused until that row is deleted. Accepted and written in `docs/domain.md` and in the error.
- TypeORM creates the `migrations` table before its transaction, so a refused partial database keeps an empty `migrations` table; the application tables are untouched.

Manual history check: worktree at `65c7fa5`, the parent of `942a13c` that added `OfflineSync` (its lock file has TypeORM 0.3.31, as today). `synchronize` from its eight entity files on a throwaway database, snapshot compared with the "before every migration" state (today's entities, the ten `down`s): one difference, `users.password_hash` has `DEFAULT ''` in the stand-in (from the `down` of `AuthMockIdentities`) and no default in history. Columns, nullability, constraints and indexes are otherwise identical. Immaterial for the upgrade, `AuthMockIdentities` drops the column; history not fixed. In addition `npm run migration:run` on that historical database, with a users row in it, applied eleven (the baseline executing nothing) and the result matched a `synchronize` reference with no difference; the row survived with `email` null. Worktree and databases removed.

Files touched: `server/src/migrations/1790000000000-Baseline.ts` (new), `server/src/baseline-migration.spec.ts` (new), `server/src/e2e/baseline.e2e.spec.ts` (new), `server/src/e2e/migrations.e2e.spec.ts` (header comment), `docs/domain.md` (Schema upgrade), `docs/deploy-test.md` (step 2, the step 4 sentence, the laptop image paragraph), `README.md` (the deploy-test line under Documentation, Status, layout, Tests counts and descriptions), `AGENTS.md` (one line), this plan.

Verified (from `server/`): `npx tsc --noEmit -p tsconfig.json` clean. `npm run test:unit` 192 tests in 25 suites (was 190 in 24). `npm run test:e2e` 142 tests in 13 suites (was 129 in 12), every existing spec green unchanged. Mutations, reverted: a changed column type in the baseline fails the empty database case; a one character edit fails the pin with the "write a new migration" message; a CRLF copy of the file hashes to the pin. `migration:run` twice on an empty throwaway database: eleven, then "No migrations are pending", the schema identical to a `synchronize` reference (12 tables, no difference). `docker build` of the working tree, the container on a second empty throwaway database: eleven migrations in its log, `/api/auth/mode` answered `{"mode":"mock"}`, the mock login before the seed a 503 (no users row); `npm run seed` with `ENVIRONMENT=LOCAL`, `ALLOW_DESTRUCTIVE_SEED=true`, `DB_SYNCHRONIZE=false`, `SEED_BULK=0` (5 users, 30 issuances), then the mock login of both identities, `/api/auth/me` and `GET /api/issuances` (30 rows) answered and the root served the client. Container, image and throwaway databases removed. The e2e spec keeps its two databases (`<DB_NAME_TEST>_baseline`, `_baseline_ref`) like the harness keeps `_migrations`.

## Plan Change Log

- 2026-10-26: approved with five requirements from the user (empty database compatibility, a true no-op on existing databases, an upgrade test from a schema before the latest migrations, history / schema / data checks, immutability). The per statement guards of the draft were replaced by the all or nothing check, because on an older database they would have created the later migrations' objects early; the matrix, the snapshot definition, the pin and the history cross check were added.

- 2026-10-26 (review pass 1, before the file is frozen): the matrix rows "Partial database" and "Revert" changed. Any base table now reads as an existing database (no statement, the first migration that needs a missing table fails as before the baseline); only a database with nothing but later tables is refused. `down` removes only its row while other rows remain (recorded over an existing database, it built nothing) and throws when it is alone (a database it built). The existence check reads `pg_class` (tables only) instead of `information_schema.tables`. The pin moved to the new hash `161b9f1b…`; from here on the file is frozen. Counts after: server 335 tests in 38 suites (192 unit, 143 e2e), total 591. Must survive: nothing in the baseline ever drops or alters an existing object.

## Review Triage Log

**Pass 1, 2026-10-26.** Two reviewers on the diff (edge cases with this plan as claims file, verification gaps). Eight findings: five fixed, one deferred, two noted.

- Edge case: the check read `information_schema.tables`, which hides tables the migration role has no privilege on and lists views -- fixed: `pg_class` with `relkind IN ('r', 'p')` in `current_schema()`. New e2e case: a view named `users` does not count, the run rolls back on `CREATE TABLE "users"`.
- Edge case: "all seven base tables or refuse" cannot survive a later migration that renames or drops a base table: every database built after it (LOCAL, the migrations harness) would be refused, and the frozen file could not be corrected -- fixed: any base table means an existing database. The "some base tables" e2e case now asserts the baseline sends only its check and the run fails at `relation "issuances" does not exist`, as before the baseline.
- Edge case: docs and the old `down` comment said the baseline is always the newest row on an upgraded database; mid history (after `XmlOutbox`) and on a LOCAL database without history it is not -- fixed together with the next item, `docs/domain.md` now describes where the row lands.
- Implementer's report: on an upgraded database `migration:revert` met the baseline first and was refused until its row was deleted by hand -- fixed: `down` counts the other rows of `migrations`; while any remain the baseline was recorded over an existing database and built nothing, so only its row goes; alone it throws. e2e: the current database reverts the baseline row with no schema or data change, then the newest migration; the `XmlOutbox` case reverts the three after it, then the baseline row, and keeps the seven; the database it built still refuses with the exact message.
- Edge case: teardown after a failed `beforeAll` -- fixed: `afterAll` destroys only an initialized connection.
- Verification gap reviewer, other finding: `README.md` said the LOCAL no-op comes from `IF NOT EXISTS` guards -- fixed: the baseline finds its tables, the later migrations are guarded.
- Edge case: two migration runners on one empty database race on `CREATE TABLE` -- deferred. TypeORM 0.3 takes no lock around `migration:run` for any migration, the ten have the same race, and an advisory lock inside the baseline alone would still let both runners record the history twice. Render free runs one instance; the AWS deployment should run the migrations as one step before the instances start.
- Implementer's notes, not changed: the comment in `migrations.e2e.spec.ts` names only `xml_outbox` for the uuid default quirk (already stale before this task, `xml_import_files` came with 7a30113); the refused runs print TypeORM's "Migration failed" lines to the console, the tests pass.

**Verification after the fixes:** tsc clean; unit 192 in 25 suites (pin on the new hash); e2e 143 in 13 suites; docker image on an empty throwaway database applied eleven migrations, answered `/api/auth/mode`, then `npm run seed` (LOCAL guard, `DB_SYNCHRONIZE=false`) and the mock login worked. Throwaway database, container and image removed.
