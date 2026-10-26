# Issuance XML import

A standalone service that brings SAP issuance documents into the equipment-supply database. SAP (or whoever stands in for it) drops XML files into a directory; the service polls that directory, validates each file against the provisional inbound document, and inserts or updates the issuances and their lines in PostgreSQL, one transaction per file. It never touches the status of an issuance, a task or an attempt: the manager and the courier own those, this feed owns what the document says (customer, address, lines, priority, delivery date, notes).

The inbound contract is provisional, like the outbound export (`docs/xml-export.md`): nobody on the SAP side has agreed to it yet. What is undecided is listed under open decision 17 in the repository `README.md`.

## Overview

- Node 20, TypeScript, Express 5, `pg` with hand written SQL, `fast-xml-parser`. No NestJS, no ORM at runtime, no queue, no cron package.
- Reads `shared/@core.ts` (the enums) and `shared/@rules.ts` (`editableStatuses`) from the repository, nothing else from the server.
- Writes `issuances`, `issuance_items`, `audit_log` (one row per inserted or updated issuance, `actor_type` `system`, `action` `issuance.import`) and its own tracking table `xml_import_files`. Never `xml_outbox`, never `delivery_*`.
- Two modes: automatic (a polling loop) and manual (`POST /run`), both running the same pipeline under one in-process mutex.
- Database backed idempotency: a file is identified by the SHA-256 of its bytes; the same bytes under any name are imported once, from whatever instance claims them first.

## Architecture and flow

```
etls/issuance-xml-import/src
  server.ts                  env, pool, app, scheduler, signals
  app.ts                     GET /health, GET /status, POST /run, the bearer check
  config/env.ts              loadConfig(): every variable, checked, with its name in each refusal
  config/paths.ts            PROJECT_ROOT (the first package.json above this file), resolveFromRoot
  services/scanner.ts        discovery in the input directory
  services/pipeline.ts       one run: scan, per file fingerprint, claim, parse, transform, import, lifecycle
  services/transform.ts      the parsed issuance to column objects, the diff against a loaded row, the revision rule
  services/files.ts          moveSafely (never overwrites), writeSidecar
  services/status.ts         the counters of /status and the run mutex
  services/scheduler.ts      the setTimeout chain
  parsers/contract.ts        namespace, version, element names, limits
  parsers/xml-parser.ts      bytes to ParsedDocument, or a PermanentError with the path and the rule
  parsers/fixtures/*.xml     the documents the specs read
  repositories/db.ts         the pool, transactionOn, ping
  repositories/import-files.repository.ts   claim, complete, fail, lookups on xml_import_files
  repositories/issuances.repository.ts      lock, load with items, insert, update, items, the audit row
  utils/errors.ts            PermanentError, RetryableError, classify
  utils/logger.ts            one json object per line
  e2e/                       the database backed specs and their setup
```

One run, in order:

1. **Scan** the input directory (`services/scanner.ts`): regular files ending `.xml` (case blind), sorted by name in codepoint order, the first `ETL_BATCH_SIZE`. See [File lifecycle](#file-lifecycle) for what is skipped.
2. Per file, **re-check the size** right before the read (a file that grew or shrank under the scan is left for the next run), refuse an oversized one without reading it, **read** the bytes and compute their **SHA-256**.
3. **Claim** the file in `xml_import_files` with one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement. No row back means the bytes were applied already (archive the file, no second import), another instance holds a live lease, or the file failed on a transient error less than its backoff ago (skip this run).
4. **Parse** (`parsers/xml-parser.ts`): UTF-8 with a fatal decoder, a refusal of any `<!DOCTYPE` or `<!ENTITY`, the well-formedness check, the parse with every value kept as text, then the walk that applies the contract. A violation is a `PermanentError` that says the path (`Issuances/Issuance[2]/Items/Item[1]/LineNo`) and the rule, never a customer value. Nothing has been written at this point.
5. **Import** in one transaction: every existing row of the file locked at once in id order (the order the server's bulk actions lock in, so a concurrent assign or mark urgent cannot deadlock with the file), then for each issuance of the document `SELECT ... FROM issuances WHERE sap_number = $1 FOR UPDATE` (the repository's lock order: the issuance first; the import touches no task), then insert, update or nothing; one `audit_log` row per inserted or updated issuance; the tracking row to `completed` with its counts and the `DocumentId`; `COMMIT`.
6. **Archive** the file. A failure here is a log line, the file stays and the next run archives it on the strength of its completed row.

A `PermanentError` anywhere rolls the transaction back, marks the row `failed` / `permanent` in its own statement, moves the file to the error directory with a sidecar. A `RetryableError` (the database, the machine) marks the row `failed` / `retryable`, leaves the file where it is and ends the run; the next tick is the retry.

## Installation

```bash
cd etls/issuance-xml-import
npm install              # npm 10.2 fails on this tree with "reading 'edgesOut'"; npm install --legacy-peer-deps works
cp .env.example .env     # the values match docker-compose.yml at the repository root
```

The package has no root `package.json` above it; it is installed and run on its own, like `client/` and `server/`. The table it tracks files in is created by the server (`synchronize` on a LOCAL machine, `npm run migration:run` elsewhere, see [Database integration](#database-integration-behavior)): the ETL never creates tables.

Every dependency range is pinned to a published version; `vitest` stays on 3.x with `vite` 6 because `vite` 7 and 8 need Node 20.19 and this project runs on Node 20.11.

## Environment variable reference

Read once at startup by `src/config/env.ts`. Unset or blank is the default; every number must be a whole number within its range, every refusal names the variable. The database password is held in memory and never written to a log line.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENVIRONMENT` | `(unset)` | `LOCAL` is a developer's machine: `/status` and `/run` may run without `ETL_ADMIN_TOKEN` (warned loudly at startup). `PRODUCTION`, or `NODE_ENV=production`, is production whatever else the env says. Anything else is a real environment. |
| `PORT` | `3101` | The HTTP listener. |
| `DB_HOST` | `localhost` | The server's database variables, the same names as `server/.env`. |
| `DB_PORT` | `5433` | |
| `DB_USER` | `equipment` | |
| `DB_PASSWORD` | `equipment` | Taken as given, spaces included. |
| `DB_NAME` | `equipment_supply` | |
| `DB_NAME_TEST` | `equipment_supply_etl_test` | The database the e2e specs create and wipe. `equipment_supply` and `equipment_supply_test` are refused by name. |
| `XML_INPUT_DIR` | `./data/input` | Where SAP drops documents. A relative path resolves against this package's root (the directory of its `package.json`), never the working directory. |
| `XML_ARCHIVE_DIR` | `./data/archive` | Where imported files go. |
| `XML_ERROR_DIR` | `./data/error` | Where refused files go, each with a `<name>.error.json` next to it. |
| `ETL_AUTO_START` | `true` | `true` polls the input directory; `false` is manual mode, runs happen on `POST /run` only. Only the words `true` and `false` are accepted. |
| `ETL_POLL_INTERVAL_MS` | `10000` | The pause between the end of one automatic run and the start of the next. At least 1000. |
| `ETL_BATCH_SIZE` | `100` | Files per run, sorted by name; the rest wait for the next run. |
| `ETL_MIN_FILE_AGE_MS` | `2000` | A file modified less than this many ms ago is still being written and waits for the next run. `0` turns the check off. |
| `ETL_MAX_FILE_BYTES` | `5242880` | A larger file (from `stat`, never read) is refused for good. |
| `ETL_LEASE_MS` | `300000` | How long a claim belongs to the process that made it; another instance may take the file over after that. Longer than the longest file takes to import: a holder whose lease ran out and whose row was taken over has its transaction rolled back and its file left to the new holder. At least 1000. |
| `ETL_MAX_ATTEMPTS` | `10` | A file that failed on a transient error this many times is refused for good. |
| `ETL_ADMIN_TOKEN` | none | The bearer token of `GET /status` and `POST /run`. Required outside `LOCAL`: the service refuses to start without it. |
| `ETL_INSTANCE_ID` | `<hostname>-<pid>` | The name this process claims files under (`xml_import_files.instance_id`), up to 64 of `A-Z a-z 0-9 . _ -`. A process may reclaim its own rows at once (a restart does not wait for its old lease), so two processes must never share an id. |
| `ETL_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

The three directories are created at startup when missing. A `.env` next to `package.json` is loaded first (`dotenv`, quiet); real environment variables win over it.

## Starting locally

```bash
docker compose up -d                 # at the repository root: PostgreSQL on host port 5433
cd server && npm run start:dev       # once, with DB_SYNCHRONIZE=true: creates xml_import_files (or npm run migration:run)
cd etls/issuance-xml-import
npm run dev                          # tsx src/server.ts, with .env
```

The startup line is one JSON object with the port, the mode, the three directories, the database (user, host, port, name: no password) and whether the database answered. Then:

```bash
cp src/parsers/fixtures/valid-two-issuances.xml data/input/
curl -s -X POST -H "Authorization: Bearer $ETL_ADMIN_TOKEN" localhost:3101/run
curl -s -H "Authorization: Bearer $ETL_ADMIN_TOKEN" localhost:3101/status
curl -s localhost:3101/health
```

Without `ETL_ADMIN_TOKEN` on `ENVIRONMENT=LOCAL` the header is not needed. The production entry is `npm run build` then `npm start` (`node dist/etls/issuance-xml-import/src/server.js`: `rootDir` is the repository root because `shared/` is compiled too, the same reason the server's entry is `dist/server/src/main.js`).

Scripts: `dev`, `build`, `start`, `typecheck`, `test` (everything), `test:unit` (no database), `test:e2e` (the database backed specs only).

## Automatic and manual modes

**Automatic** (`ETL_AUTO_START=true`): a `setTimeout` chain, never `setInterval`. The first run starts right after the listener is up; every next one `ETL_POLL_INTERVAL_MS` after the previous one finished, so a slow run never has ticks piling up behind it. A run that finds nothing is a run.

**Manual** (`POST /run`): the same pipeline, run to the end before the response, which is the run summary. Available in both modes; with `ETL_AUTO_START=false` it is the only way a run happens.

Both go through one in-process mutex (`services/status.ts`): a manual request while a run is in flight gets `409 { code: 'run_in_progress', run_id }`, an automatic tick that finds the mutex held does nothing and the chain continues. Two processes are a different matter and are coordinated through the database claim, see [Idempotency guarantees](#idempotency-guarantees).

`SIGINT` / `SIGTERM`: the HTTP server and the scheduler close (no new run can start), the run in flight finishes (a transaction is never cut in the middle, within a 30 s limit after which the process exits with code 1 and the lease reclaims the row later), the pool ends, exit 0. An `unhandledRejection` is logged, never a crash. A database that is down at startup or mid run is logged and retried on the next tick; `/health` says `down` meanwhile.

## Input XML contract and field mapping

Namespace `urn:equipment-supply:issuance-import`, `schemaVersion="0.1-provisional"`; both are checked and anything else is refused. UTF-8 (a BOM is fine), no DOCTYPE, no entity declarations, no attributes except the root's two, no element outside the list below (refused by name, with its path). Whitespace is trimmed everywhere. An optional element that is present but empty counts as absent: a document cannot clear a column, it can only set one.

| Element | Column | Rule |
| --- | --- | --- |
| `DocumentId` | `xml_import_files.document_id`, the audit `details.document_id` | required, 1 to 100 of `A-Z a-z 0-9 . _ : -`; one document is imported once |
| `GeneratedAt` | not stored | required, ISO 8601 date and time with a zone (`2026-10-25T09:30:00Z`, `...+03:00`) |
| `Issuances/Issuance` | one `issuances` row each | 1 or more; `SapNumber` unique in the file |
| `SapNumber` | `sap_number` | required, 1 to 20 digits, kept as text (leading zeros survive); the key of the upsert |
| `NumberPrefix` | `number_prefix` | optional, up to 10 (the letter before the number in the design, not interpreted) |
| `Priority` | `priority` | optional, `normal` or `urgent`; `normal` on insert when absent |
| `DeliveryDate` | `delivery_date` | optional, `yyyy-mm-dd`, a real calendar date |
| `Customer/Name` | `customer_name` | required, 1 to 200 |
| `Customer/IdNumber` | `customer_id_number` | optional, up to 40 |
| `Customer/Phone` | `customer_phone` | optional, up to 40 |
| `Address/Street` | `address_street` | required, 1 to 200 |
| `Address/Building` | `address_building` | optional, up to 200 |
| `Address/City` | `address_city` | required, 1 to 200 |
| `Notes` | `notes` | optional, up to 500 (the manager's edit limit); CDATA and entities are decoded into text |
| `Items/Item` | one `issuance_items` row each | required, 1 to 500; `LineNo` unique in the issuance |
| `LineNo` | `line_no` | required, positive whole number; the key of the line upsert |
| `ProductName` | `product_name` | required, 1 to 200 |
| `CatalogNumber` | `catalog_number` | optional, up to 100 |
| `StationNumber` | `station_number` | optional, up to 100 |
| `SerialNumber` | `serial_number` | optional, up to 100 |
| `Quantity` | `quantity` | optional, 1 to 100000; `1` on insert when absent |
| `Status` | never | refused: "the system owns the status" |

Not in the document, by design: the status, self pickup, the courier, the delivery date's reason, anything about tasks or attempts. The example document is under [Example input XML](#example-input-xml).

## Database integration behavior

The ETL writes to the server's own tables through `pg` and hand written, parameterized SQL (`src/repositories/`). The schema stays TypeORM's: the tracking table is a server entity (`server/src/entities/xml-import-file.entity.ts`) with a migration (`server/src/migrations/1791600000000-XmlImportFiles.ts`), so a LOCAL server with `DB_SYNCHRONIZE=true` creates it on start and every other box gets it from `npm run migration:run`, and the server's `migrations.e2e.spec` keeps the two in step.

Per issuance of a document, inside the file's transaction, after `SELECT ... FOR UPDATE` on the row by `sap_number`:

- **Unknown `SapNumber`**: inserted with `status` `unassigned`, `source` `'sap'`, `revision` `1`, the defaults for the absent optionals, and its lines. One audit row, `mode: 'insert'`.
- **Known, identical**: nothing, counted `unchanged`, whatever the status.
- **Known, different**: a present element wins, an absent optional element leaves the column alone. Lines match by `line_no`: a present line updates its row (a row with `removed_at` set is restored), a line without a row is inserted, a live row whose line is not in the document gets `removed_at = now()`. `updated_at = now()`. `revision` is bumped when the customer, the address or the lines changed (the things an offline delivery report was written against, see `issuance.entity.ts`); priority, delivery date, notes and number prefix leave it alone. One audit row, `mode: 'update'`, `changed` listing the columns and the lines (`customer_phone`, `items[3].inserted`, `items[2].removed`, `items[2].restored`, `items[1].quantity`), `revision_bumped`.
- **Known, different, and the status is not one the document may change** (`delivered`, `partially_delivered`, `deleted`: the rows missing from `editableStatuses` in `shared/@rules.ts`): a `PermanentError` for the whole file, `issuance 2000592 is delivered, the document cannot change it`. Nothing of the file is written.

Never written: `status`, `self_pickup`, `deleted_at`, `delete_reason`, `delivered_by_user_id`, anything in `delivery_tasks`, `delivery_attempts`, `xml_outbox`. Never a `DELETE`. An issuance that is `assigned` (a courier holds it) takes field changes and removed lines like an `unassigned` one: the revision bump makes a report signed against the old lines fail with `revision_changed`, the same path as the manager removing a line. A line **added or restored** on an `assigned` issuance refuses the whole file (`issuance X is assigned, the document adds line N while a courier holds it`): the server forgives only lines that were taken off when it checks a stale report's answers, so an added line would turn the courier's queued report into a 400 the tablet files as invalid. Drop the file again once the issuance left the courier's hands (not delivered, reassigned later, self pickup). Whether SAP may change an issuance on the road at all is open decision 17.

The audit row: `actor_type` `system`, `action` `issuance.import`, `entity_type` `issuance`, `entity_id` and `issuance_id` the issuance, `batch_id` the `xml_import_files.id` of the file (so the rows of one file read as one event), `details` `{ sap_number, mode, changed, file, document_id, revision_bumped? }`. No customer value, no line content.

Lock order: the issuance row, then nothing else. The server's transactions take the issuance first too, so an import and a manager action on the same issuance run one after the other. Two files that hold the same two issuances in opposite order can deadlock; PostgreSQL ends one (`40P01`), which is a retryable failure, and the next tick retries it.

## File lifecycle

Discovery takes regular files ending `.xml` (case blind) and ignores names starting with `.` or ending `.tmp`, `.part` or `~`, directories, and anything else. A file modified less than `ETL_MIN_FILE_AGE_MS` ago is left for the next run (an upload in progress). The size from `stat` goes with the candidate and is checked again right before the read: a file that changed under the scan is skipped. One larger than `ETL_MAX_FILE_BYTES` is never read; it is refused for good under a stand-in fingerprint (the SHA-256 of `oversized`, its name and its size, since the bytes are not read) and moved to the error directory. Files are taken sorted by name in codepoint order, the first `ETL_BATCH_SIZE` per run.

After the database said its word:

| Outcome | Row | File |
| --- | --- | --- |
| imported | `completed`, with `document_id`, `inserted` / `updated` / `unchanged` | moved to the archive directory |
| already imported (same bytes seen before, whatever the name) | untouched | moved to the archive directory, no claim, no transaction |
| refused (`PermanentError`) | `failed` / `permanent`, `last_error` | moved to the error directory, plus `<final name>.error.json` `{ file, sha256, error, at }` |
| transient failure (`RetryableError`) | `failed` / `retryable`, `last_error` | stays in the input directory; the run ends |
| claimed by another instance | theirs | stays; skipped this run |
| archive or error move failed | as above | stays; the next run finds the row and moves it again |

A move keeps the file name. When the name is taken, the fallback is `<base>.<n><ext>` with the smallest free `n` from 1 (`one.xml`, `one.1.xml`, `one.2.xml`); the name is reserved exclusively (`open` with `wx`) before the rename, so two processes archiving the same name at once get two names. When the destination is another volume (`EXDEV`) the bytes are copied into the reserved placeholder and the source is unlinked afterwards. The sidecar carries the final name, so a refused `one.1.xml` has `one.1.xml.error.json` next to it. No file is ever deleted by the service. A missing input directory is a warning and a run with nothing in it.

## Retry and recovery

- **Transient failure** (`RetryableError`: the pg connection codes `08*`, `57P01`, `53*`, `40001`, `40P01`, the socket codes `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, and every error that is not one of the ETL's own): the transaction is rolled back, the row goes to `failed` / `retryable` when the database still answers, the file stays, the run ends with `error` in its summary. The next tick (or `POST /run`) tries again once the backoff has passed (10 s after the first failure, doubling per attempt, 10 min at most; a run that comes earlier skips the file and logs `left for its retry backoff`); the claim counts the attempt. Past `ETL_MAX_ATTEMPTS` the failure is permanent and the file goes to the error directory with `attempts exhausted (10): ...`, which with the defaults takes about twenty minutes of failing, not ten ticks.
- **Permanent failure** (`PermanentError`: a file that is not UTF-8, a DOCTYPE, malformed XML, another namespace or version, a contract violation, a business refusal, a second file under a `DocumentId` already imported): rolled back, `failed` / `permanent`, the file and its sidecar in the error directory. The same bytes dropped again are tried again (a permanent row has no lease and is reclaimable), so a refusal that depended on the database state (an issuance that was delivered) can be retried by moving the file back once the state changed.
- **Database down at startup**: the service starts, logs it, `/health` answers 503 `db: 'down'`, every tick retries.
- **Database down mid run**: the file in progress is marked `retryable` if the mark can be written, stays in the input directory either way; the run ends; the next tick retries.
- **Crash after `COMMIT`, before the archive**: the row is `completed`, the file is still in the input directory. The next run's claim gets no row, reads it, sees `completed`, archives the file. No second import, no second audit row.
- **Crash while processing** (after the claim): the row stays `processing` with a `lease_until` in the future. Every other instance skips it until the lease runs out (the same instance id reclaims it at once), then the next claim takes it over (`attempts + 1`) and the file is processed again from the start. Nothing of the crashed attempt was committed.
- **A lease that runs out under a live import** (a file longer than `ETL_LEASE_MS`, another instance took the row over): the completion statement is fenced on the instance and finds no row, the transaction is rolled back, the file is left to the new holder (`lease lost` in the log, the file counted as skipped). The new holder's import stands. Set the lease longer than the longest file.
- **Shutdown** (`SIGINT` / `SIGTERM`): the listener and the scheduler close first, the run in flight finishes, the pool ends. A run that does not finish within 30 s (a connection that will never answer) is abandoned with exit code 1; its row is reclaimed once its lease runs out.
- **Refusal that cannot be recorded** (the database went away between the rollback and the mark): the file stays in the input directory whatever the kind, the run ends. Nothing is moved on a word nobody recorded.

Investigating: `SELECT file_name, status, error_kind, attempts, last_error, instance_id, lease_until FROM xml_import_files WHERE status <> 'completed' ORDER BY started_at DESC`, and the `.error.json` next to a refused file.

## Idempotency guarantees

- **By content**: `xml_import_files.content_sha256` is unique. The claim is one statement, `INSERT ... ON CONFLICT (content_sha256) DO UPDATE ... WHERE status <> 'completed' AND (lease_until IS NULL OR lease_until < now() OR instance_id = <mine>) AND (<not in its retry backoff>) RETURNING *`. Two instances that read the same bytes at the same moment get exactly one row back between them; the same bytes under a new name, or dropped again after a crash, get no row and are archived without a transaction.
- **By document**: `document_id` is unique. Before the writes, the transaction checks that no other completed row holds the document's `DocumentId`; a second file with the same id and other bytes is refused for good (`document X was imported from file Y already`). Two such files racing into the commit are caught by the constraint, which the classifier maps to the same permanent refusal.
- **By issuance**: the upsert is keyed by `sap_number` under `FOR UPDATE`, and an identical document is `unchanged`, so applying a document twice is applying it once. A concurrent insert of the same new `sap_number` by two files fails one of them on the unique constraint; that is a transient failure and the retry finds the row and updates it.
- **By transaction**: the issuance rows, the item rows, the audit rows and the tracking row's completion commit together or not at all; the file is moved only after the commit.
- **At least once, never twice**: a crash between the commit and the archive leaves the file in place; the next run recognizes the completed row. A crash before the commit leaves a lease that expires; the file is processed again from the start.

## HTTP endpoints

All answers are JSON. `x-powered-by` is off. No body is read by any route.

| Route | Auth | Answer |
| --- | --- | --- |
| `GET /health` | open | `200 { status: 'ok', db: 'up', uptime_s }`, or `503 { status: 'degraded', db: 'down', uptime_s }` when `SELECT 1` does not answer within 2 s |
| `GET /status` | bearer | `{ enabled, running, current_run_id, instance_id, started_at, last_run, totals: { runs, files, succeeded, failed }, awaiting }`. `enabled` is the automatic mode; `awaiting` the `.xml` candidates in the input directory right now; `last_run` the summary below or `null` |
| `POST /run` | bearer | the run summary: `{ id, trigger, started_at, finished_at, discovered, processed, succeeded, failed, skipped, already_imported, error }`. `409 { code: 'run_in_progress', run_id }` while a run is in flight |
| anything else | | `404 { code: 'not_found' }` |

Bearer: `Authorization: Bearer <ETL_ADMIN_TOKEN>`, compared in constant time; `401 { code: 'unauthorized' }` otherwise. Without the variable the service refuses to start, except on `ENVIRONMENT=LOCAL`, where the two routes are open and the startup log says so loudly.

Summary fields: `discovered` the files the scan handed over; `processed` the ones that reached a claim (`succeeded` + `failed` + `already_imported`); `skipped` the ones left for a later run (a claim held elsewhere, a file that moved under the scan); `error` the transient failure that ended the run early, `null` when the run went through its list.

## Test instructions

```bash
cd etls/issuance-xml-import
npm run typecheck              # tsc, the e2e setup and the server entities included
npm run test:unit              # vitest, no database
docker compose up -d           # at the repository root
npm test                       # everything: 74 unit + 28 e2e on equipment_supply_etl_test
```

The unit specs sit next to the code as `*.spec.ts`: the config reader (`config/env.spec.ts`), every parser row of the plan's matrix on the fixtures (`parsers/xml-parser.spec.ts`), the diff and revision rules (`services/transform.spec.ts`), discovery on a temporary directory (`services/scanner.spec.ts`), the exclusive move and the sidecar (`services/files.spec.ts`), the mutex and the counters (`services/status.spec.ts`), the timer chain on fake timers (`services/scheduler.spec.ts`), the whole pipeline on fake repositories and temporary directories (`services/pipeline.spec.ts`), and the three routes with supertest against a fake runner (`app.spec.ts`).

`src/e2e/` runs on `equipment_supply_etl_test`, created from the `postgres` database when missing and rebuilt from `server/src/entities` with a TypeORM `DataSource` (`synchronize` on a dropped schema) at the start of each spec file, truncated between tests. `import.e2e.spec.ts` is the database side of the matrix: the insert with its audit row and tracking row, the same bytes again under two names, the phone update with the revision, the priority alone without it, the absent optional, the lines (removed, inserted, updated, restored), the delivered refusal with the rollback of the other issuance in the file, the identical document on a closed issuance, the empty outbox, the second issuance that violates the contract, the second file under an imported `DocumentId`, the oversized file, the crash after the commit, the live and the expired lease, two concurrent claims, the transient failure that keeps the file, the backoff that skips it and the later import, the attempts limit, the lease lost under an import (rolled back, the file left alone), a differing document on an `assigned` issuance (updated) and on a `deleted` one (refused), and two imports of one issuance serialized by the row lock. `api.e2e.spec.ts` runs the real routes on the real pipeline: `/health` up and 503 against a dead port, `/run` with and without the token and the `/status` after it, the 409 while a run holds the mutex, and the automatic mode importing a dropped file on its first tick.

`typeorm` and `reflect-metadata` are devDependencies for the e2e setup only. The entities resolve `typeorm` from `server/node_modules` for their decorators; the `DataSource` is this package's copy; the two meet on the metadata storage TypeORM keeps on `globalThis`. `vitest.config.ts` transpiles the entity files with TypeScript itself (esbuild has no `emitDecoratorMetadata`, and an untyped `@Column()` reads its type from `design:type`).

## Example input XML

```xml
<?xml version="1.0" encoding="UTF-8"?>
<IssuanceImport xmlns="urn:equipment-supply:issuance-import" schemaVersion="0.1-provisional">
  <DocumentId>SAP-DLV-2026-000123</DocumentId>
  <GeneratedAt>2026-10-25T09:30:00Z</GeneratedAt>
  <Issuances>
    <Issuance>
      <SapNumber>2000592</SapNumber>
      <NumberPrefix>ד'</NumberPrefix>
      <Priority>normal</Priority>
      <DeliveryDate>2026-10-30</DeliveryDate>
      <Customer>
        <Name>ישראל ישראלי</Name>
        <IdNumber>012345678</IdNumber>
        <Phone>050-1234567</Phone>
      </Customer>
      <Address>
        <Street>הרצל 12</Street>
        <Building>בניין B קומה 3</Building>
        <City>תל אביב</City>
      </Address>
      <Notes>להתקשר לפני ההגעה &amp; לעלות עם המעלית</Notes>
      <Items>
        <Item>
          <LineNo>1</LineNo>
          <ProductName>מחשב IEXXX</ProductName>
          <CatalogNumber>PKG-1102</CatalogNumber>
          <StationNumber>1104</StationNumber>
          <SerialNumber>SN1</SerialNumber>
          <Quantity>1</Quantity>
        </Item>
        <Item>
          <LineNo>2</LineNo>
          <ProductName>מסך 24"</ProductName>
          <CatalogNumber>PKG-2201</CatalogNumber>
          <Quantity>2</Quantity>
        </Item>
      </Items>
    </Issuance>
  </Issuances>
</IssuanceImport>
```

`src/parsers/fixtures/valid-two-issuances.xml` is this document with a second issuance; the other fixtures there are the refusals (a bad priority in the second issuance, a `Status` element, a DOCTYPE, a malformed file, another namespace, a latin-1 file).

## Deployment considerations and known limitations

- **Schema first.** `xml_import_files` comes from the server's migration `XmlImportFiles1791600000000`; run `npm run migration:run` in `server/` before the first start on any box that is not LOCAL. The ETL refuses nothing at startup when the table is missing: the first claim fails as a transient error and every tick logs it.
- **The database user** needs `SELECT`, `INSERT`, `UPDATE` on `issuances`, `issuance_items`, `audit_log`, `xml_import_files` and `SELECT` on nothing else. No `DELETE`, no DDL.
- **The batch is cut before the claim**: `ETL_BATCH_SIZE` names from the head of the sorted list go into a run, skipped or not. A head full of files another instance holds, or files inside their retry backoff, delays the files sorted after them until those move on. Raise the batch size on a shared directory with several instances.
- **Several instances** may watch the same directory (a shared mount): the claim coordinates them, the lease (`ETL_LEASE_MS`) decides how long a crashed instance blocks a file. Give each one its own `ETL_INSTANCE_ID` (never the same one twice: a process reclaims its own rows without waiting). A longer lease than the longest expected import of one file (a shorter one makes the holder lose the row mid import and roll back), a shorter one than the time an operator is willing to wait after a crash. The three directories must differ (the service refuses to start otherwise); the archive and the error directory may sit inside the input directory only as subdirectories, which the scan ignores.
- **The directories** must be on a filesystem where `rename` is atomic within a directory (any local filesystem, NFS with care); the archive and error directories may be another volume (`EXDEV` is handled by a copy into a reserved name). The input directory should be written by SAP as `<name>.tmp` then renamed, or at least left alone for `ETL_MIN_FILE_AGE_MS`; a file still being written is otherwise read half way and refused as malformed.
- **Nothing is deleted**: the archive and the error directory grow for as long as nobody cleans them. A retention job is the operator's.
- **Ordering**: files are taken sorted by name, so a naming scheme that sorts chronologically (`<yyyymmdd>-<hhmmss>-<id>.xml`) keeps a later document after an earlier one of the same issuance. A stale document arriving after a newer one overwrites it; the contract has no version or sequence per issuance (open decision 17).
- **No outbound event**: an import never writes `xml_outbox`, so SAP hears nothing back about it. The status does not move, so nothing is owed to the status feed; whether the feed should acknowledge an import is open.
- **Size**: a document up to 5 MiB and 500 lines per issuance; the whole file is parsed in memory. `ETL_BATCH_SIZE` bounds the files per run, not the time of a run.
- **The contract is provisional**: the namespace, the version and the element names are the system's own draft (open decision 17). A document with another `schemaVersion` is refused rather than guessed at; a change of the contract is a change of `parsers/contract.ts`, the parser and this file.
- **The status of `/status` is per process** and starts from zero on a restart; the database rows are the record.
- **Windows**: the rename over the reserved placeholder is a replace (`MoveFileEx` with replace), and `copyFile` keeps the source's mtime, so a copied test file can look old to the age check; the specs set the ages by hand.
