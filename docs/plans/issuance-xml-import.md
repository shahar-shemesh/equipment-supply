---
title: 'Issuance XML import: a standalone Express ETL from a directory into the existing database'
type: 'feature'
created: '2026-10-25'
status: 'approved'
base: 'bc63444'
context: ['AGENTS.md', 'shared/@core.ts', 'shared/@rules.ts', 'server/src/env.ts', 'server/src/entities/issuance.entity.ts', 'server/src/entities/issuance-item.entity.ts', 'server/src/entities/audit-log.entity.ts', 'server/src/entities/xml-outbox.entity.ts', 'server/src/migrations/1791300000000-XmlOutbox.ts', 'server/src/e2e/migrations.e2e.spec.ts', 'server/src/xml-export/xml-builder.service.ts']
---

## Intent

**Problem:** SAP documents reach the system on paper. The spec (docs/README.he.md) says SAP hands issuance documents in through an interface that was never defined; the system has an outbound XML export of status changes (docs/xml-export.md) and nothing inbound. The `source` column, `revision` and the audit log already anticipate it.

**Approach:** A standalone Node 20 + TypeScript + Express service under `etls/issuance-xml-import/` that polls a directory, parses each `.xml` with fast-xml-parser, validates it against a provisional inbound document (`urn:equipment-supply:issuance-import`, `schemaVersion="0.1-provisional"`, the same footing as the outbound one), and upserts complete issuance records by `sap_number` into the existing PostgreSQL database with `pg` and hand written parameterized SQL, one transaction per file. A tracking table `xml_import_files` (entity + migration on the server side, like `xml_outbox`) gives database backed idempotency, a cross process claim with a lease, and crash recovery. Imports never touch `status`, so no outbox row and no export loop.

## Boundaries & Constraints

**Always:**
- Independent package: own `package.json`, `tsconfig.json`, `.env.example`, README. Runtime deps: `express` (^5), `pg`, `fast-xml-parser` (^5), `dotenv`. Dev: `typescript`, `tsx`, `vitest`, `supertest`, `@types/{express,node,pg,supertest}`, plus `typeorm` + `reflect-metadata` as devDependencies only, used by the e2e setup to build the test schema from `server/src/entities` (see Design Notes). No NestJS, no ORM at runtime.
- Imports from the repo: `shared/@core.ts` (enums) and `shared/@rules.ts` (`editableStatuses`). `tsconfig` has `rootDir: "../.."` like the server, so `build` emits `dist/etls/issuance-xml-import/src/server.js`; `start` points there. `strict: true`.
- Directory paths resolve against the project root (`src/config/paths.ts`: walk up from `__dirname` to the first directory holding a `package.json`), never `process.cwd()`. Variables `XML_INPUT_DIR`, `XML_ARCHIVE_DIR`, `XML_ERROR_DIR` (the brief's names), defaults `./data/{input,archive,error}`; add `etls/issuance-xml-import/data/` to the root `.gitignore`.
- Config in `src/config/env.ts` in the style of `server/src/env.ts` (same `ENVIRONMENT=LOCAL` meaning, `wholeNumber` style checks, every refusal names the variable). Database variables are the server's: `DB_HOST`, `DB_PORT` (5433), `DB_USER`, `DB_PASSWORD`, `DB_NAME` (equipment_supply), `DB_NAME_TEST` (equipment_supply_etl_test). The password is never logged.
- Import semantics (model A, complete records): new `sap_number` inserted (`status` unassigned, `source` 'sap', `revision` 1, items); existing one updated only where something differs. A present element wins, an absent optional element leaves the column alone. `revision` is bumped when customer, address or items changed (the entity's own comment), not for priority / delivery_date / notes / number_prefix. An existing issuance whose status is not in `editableStatuses` (delivered, partially_delivered, deleted) and whose document differs is a permanent error for the whole file; an identical document is "unchanged" whatever the status. Items match by `line_no`: present lines upserted, a removed row (`removed_at` set) with that `line_no` restored, live lines absent from the document get `removed_at = now()`. `updated_at = now()` on every update (raw SQL bypasses TypeORM).
- One transaction per file: `BEGIN`; for each issuance `SELECT ... FROM issuances WHERE sap_number = $1 FOR UPDATE` (the repo's lock order: issuance first; the import touches no task); the writes; one `audit_log` row per inserted or updated issuance (`actor_type` 'system', `action` `issuance.import` added to `AuditAction` in `shared/@core.ts`, `entity_type` 'issuance', `issuance_id`, `batch_id` = the file row id, `details` = `{ sap_number, mode: 'insert' | 'update', changed: [...], file, document_id }`); then the tracking row to `completed` with its counts and `document_id`; `COMMIT`. Nothing is written to `xml_outbox`, ever.
- Tracking table `xml_import_files` as a server entity `server/src/entities/xml-import-file.entity.ts` (registered in `entities/index.ts`) and migration `1791600000000-XmlImportFiles.ts` modeled on `XmlOutbox1791300000000` (IF NOT EXISTS, names from `DefaultNamingStrategy`, uuid default `gen_random_uuid()`): `id` uuid pk, `content_sha256` char(64) unique, `document_id` varchar(100) null unique, `file_name` varchar, `size_bytes` int, `status` varchar(12) (`processing` | `completed` | `failed`), `error_kind` varchar(12) null (`permanent` | `retryable`), `attempts` int default 0, `instance_id` varchar(64) null, `lease_until` timestamptz null, `started_at` timestamptz default now(), `finished_at` timestamptz null, `inserted` / `updated` / `unchanged` int default 0, `last_error` text null, `created_at` timestamptz default now(). The ETL never creates tables: the server's `synchronize` (LOCAL) or `migration:run` does.
- Claim before parsing, from the bytes: `INSERT ... ON CONFLICT (content_sha256) DO UPDATE SET status='processing', instance_id=$, lease_until=now()+lease, attempts=attempts+1, file_name=$, started_at=now() WHERE xml_import_files.status <> 'completed' AND (xml_import_files.lease_until IS NULL OR xml_import_files.lease_until < now()) RETURNING *`. No row back: read it; `completed` means the file was applied already (a crash before archiving, or a copy): archive it without touching the database, log `already_imported`; otherwise another instance holds it: skip this run. `attempts` past `ETL_MAX_ATTEMPTS` (10) turns a retryable failure permanent.
- Error kinds: `PermanentError` (malformed or oversized XML, contract violation, business refusal, a different file already completed under the same `document_id`) rolls back, marks the row `failed` / `permanent` in its own short transaction, moves the file to the error directory with a sidecar `<name>.error.json` `{ file, sha256, error, at }`. `RetryableError` (pg connection codes `08*`, `57P01`, `53*`, `40001`, `40P01`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, and any error that is not one of ours) rolls back, marks the row `failed` / `retryable` when the database answers, leaves the file where it is, and ends the run (the next tick retries). No file is ever deleted.
- Archive and error moves preserve the name; on a taken name the fallback is `<base>.<n><ext>` with the smallest free `n` from 1, created exclusively (`open` with `wx`, then `rename`; on `EXDEV` copy with `COPYFILE_EXCL` then unlink). An archive failure after the commit is logged and the file stays: the next scan finds the row `completed` and archives again.
- Discovery: regular files ending `.xml` (case blind) only; names starting with `.` or ending `.tmp`, `.part`, `~` ignored; younger than `ETL_MIN_FILE_AGE_MS` (2000) skipped for this run; larger than `ETL_MAX_FILE_BYTES` (5 MiB, from `stat`, never read) is permanent; size re-checked right before the read and skipped when it moved. Sorted by name, codepoint order, first `ETL_BATCH_SIZE` (100). A missing input directory is a warning and an empty run; the three directories are created at startup.
- Parser (`src/parsers/`): decode as UTF-8 with `fatal: true` (BOM allowed); reject the string when it contains `<!DOCTYPE` or `<!ENTITY` before any parsing (no DTD, no entity expansion); `XMLValidator.validate` first, then `XMLParser` with `parseTagValue: false` (leading zeros of a SapNumber survive), `isArray` for `Issuance` and `Item`. Root `IssuanceImport` with `xmlns` `urn:equipment-supply:issuance-import` and `schemaVersion` `0.1-provisional`, else permanent. Field rules in the matrix. Unknown child elements under `Issuance`, `Customer`, `Address`, `Item` are refused by name. A `<Status>` element is refused: the system owns the status. Validation errors say the path (`Issuances/Issuance[2]/Items/Item[1]/LineNo`) and the rule, never the value of a customer field.
- HTTP (`src/app.ts` builds the app from injected deps, `src/server.ts` wires and listens): `GET /health` open, `{ status: 'ok' | 'degraded', db: 'up' | 'down', uptime_s }`, 503 when the database does not answer `SELECT 1` within 2 s. `GET /status` and `POST /run` require `Authorization: Bearer <ETL_ADMIN_TOKEN>` (constant time compare, 401 otherwise); without the variable the service refuses to start unless `ENVIRONMENT=LOCAL`, where it warns loudly. `POST /run` runs the same pipeline synchronously and answers the run summary, 409 `{ code: 'run_in_progress', run_id }` while one runs. `app.disable('x-powered-by')`.
- Scheduling (`src/services/scheduler.ts`): a `setTimeout` chain, never `setInterval`; one in-process mutex shared with `/run`; `stop()` resolves after the current run. `server.ts` handles SIGINT / SIGTERM: stop the scheduler, close http, end the pool, exit 0. `unhandledRejection` is logged, never crashes the process. A database that is down at startup or mid run is logged and retried on the next tick; `/health` says `down`.
- Logging (`src/utils/logger.ts`): one JSON object per line on stdout, `{ ts, level, msg, ...fields }`, fields `run_id`, `file`, `sha256` (first 12), `document_id`, `sap_number`, `issuance_id`, `instance_id`. Never the XML, never a customer field, never the password.
- Style: 2 spaces, single quotes, lowercase `//why` comments, `/*──...──*/` between top level functions (the server's style). Specs next to the code as `*.spec.ts`; database backed ones under `src/e2e/`.

**Never:**
- No NestJS, no TypeORM at runtime, no queue, no cron package, no XML schema library, no auth framework.
- No change to the transition table, the offline conflict rules, the outbox, any existing route or the client.
- No invented final contract: the document is provisional and says so; README open decision 17 records what is undecided.
- Never `DELETE` an issuance or an item row; never write `status`, `self_pickup`, `deleted_at`, `delivered_by_user_id`; never touch tasks or attempts.
- Tests never use `equipment_supply` or `equipment_supply_test`.
- No commit, no push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| New document | one `Issuance`, unknown `SapNumber` | issuance inserted (unassigned, sap, revision 1), items inserted, one audit row, row `completed` (inserted 1), file archived | none |
| Same file again | identical bytes, row `completed` | no claim, no transaction, file archived under `name.1.xml` (or free name), log `already_imported` | none |
| Same content, new name | same bytes, different file name | same as above | none |
| Changed customer phone | existing unassigned, `Customer/Phone` differs | phone updated, `updated_at`, revision +1 (customer changed), audit `changed: ['customer_phone']` | none |
| Changed priority only | `Priority` differs | priority updated, revision unchanged | none |
| Absent optional element | existing has `notes`, document has no `Notes` | notes untouched, counted `unchanged` when nothing else differs | none |
| Items changed | line 2 gone, line 3 new, line 1 quantity changed | line 2 `removed_at` set, line 3 inserted, line 1 updated, revision +1 | none |
| Removed line comes back | line 2 has `removed_at`, document holds line 2 | `removed_at` null, fields updated, revision +1 | none |
| Delivered issuance, document differs | status delivered | whole file rolled back, row `failed` / `permanent`, file to error dir with sidecar | `PermanentError` "issuance 2000592 is delivered, the document cannot change it" |
| Delivered issuance, identical document | status delivered, no diff | `unchanged`, archived | none |
| Second issuance invalid | file with 2 issuances, second has `Priority=high` | nothing inserted (the parser refuses the file before the transaction), error dir | `Issuances/Issuance[2]/Priority must be normal or urgent` |
| Duplicate SapNumber in one file | two `Issuance` with the same number | refused by the parser | permanent |
| `Status` element present | `<Status>delivered</Status>` | refused | permanent "Status is not accepted, the system owns it" |
| DOCTYPE or ENTITY | `<!DOCTYPE x [<!ENTITY ...>]>` | refused before parsing | permanent |
| Not UTF-8 | latin-1 bytes | refused | permanent |
| Malformed | unclosed tag | refused | permanent |
| Wrong namespace or version | other `xmlns` | refused | permanent |
| Special characters | `&amp;`, `&lt;`, `&apos;`, Hebrew, CDATA in Notes | decoded into the columns as text | none |
| Oversized | 6 MiB file | not read, error dir, row `failed` / `permanent` | permanent |
| Same DocumentId, different bytes | an earlier row `completed` with that id | permanent before any write | "document X was imported from file Y already" |
| Database down mid run | pool error | row `failed` / `retryable` if reachable, file stays, run ends with `error` | `RetryableError` |
| Attempts exhausted | retryable failure, attempts >= max | permanent, error dir | permanent |
| Crash after commit | row `completed`, file in input | archived on the next run, no second audit row | none |
| Crash while parsing | row `processing`, lease live | skipped until the lease expires, then reclaimed | none |
| Two instances | both claim the same bytes | exactly one `RETURNING` row; the other skips | none |
| Young file | mtime 500 ms ago | skipped this run, picked up later | none |
| `.tmp`, `.XML.part`, `notes.txt`, `.hidden.xml`, a directory `x.xml` | in the input dir | ignored | none |
| Missing input dir | path absent | run with 0 files, `warn` | none |
| `POST /run` while running | mutex held | 409 `run_in_progress` | none |
| `POST /run` without token | `ETL_ADMIN_TOKEN` set | 401 | none |
| `GET /status` | after one run | `{ enabled, running, current_run_id, instance_id, started_at, last_run: { id, trigger, started_at, finished_at, discovered, processed, succeeded, failed, skipped, already_imported, error }, totals: { runs, files, succeeded, failed }, awaiting }` | none |
| Startup outside LOCAL without token | `ENVIRONMENT=STAGING`, no `ETL_ADMIN_TOKEN` | refuses to start, names the variable | none |

## Code Map

- `etls/issuance-xml-import/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.env.example`, `README.md`
- `src/server.ts` -- env, pool, app, scheduler, signals
- `src/app.ts` -- `buildApp({ status, runner, db, auth })`, the three routes, the bearer check
- `src/config/env.ts` -- `loadConfig()`; `src/config/paths.ts` -- `PROJECT_ROOT`, `resolveFromRoot`
- `src/services/scanner.ts` -- discovery; `src/services/pipeline.ts` -- one run (scan, per file: fingerprint, claim, parse, transform, import, lifecycle); `src/services/scheduler.ts`; `src/services/status.ts` -- the counters and the mutex
- `src/parsers/xml-parser.ts` -- bytes to `ParsedDocument`; `src/parsers/contract.ts` -- namespace, version, element names, limits; `src/parsers/fixtures/*.xml`
- `src/services/transform.ts` -- `ParsedIssuance` to the column objects and the diff against a loaded row (`changedFields`, `bumpsRevision`)
- `src/repositories/db.ts` -- the pool, `withTransaction`, `ping`; `src/repositories/import-files.repository.ts` -- claim, complete, fail, find; `src/repositories/issuances.repository.ts` -- lock, load with items (withDeleted), insert, update, items upsert, audit row
- `src/services/files.ts` -- `moveSafely`, `writeSidecar`; `src/utils/errors.ts` -- `PermanentError`, `RetryableError`, `classify`; `src/utils/logger.ts`; `src/types/index.ts`
- `src/e2e/setup.ts` -- creates `equipment_supply_etl_test`, builds the schema with a TypeORM `DataSource({ entities, synchronize: true, dropSchema: true })` from `server/src/entities`, truncates between tests; `src/e2e/import.e2e.spec.ts`, `src/e2e/api.e2e.spec.ts`
- `server/src/entities/xml-import-file.entity.ts`, `server/src/entities/index.ts`, `server/src/migrations/1791600000000-XmlImportFiles.ts`, `shared/@core.ts` (`AuditAction.issuance_import`)
- `docs/domain.md` (a bullet under Domain model, a bullet under Schema upgrade, "Ten migrations"), `README.md` (Status, Repository layout, Tests counts, open decision 17, a Documentation link to the ETL README), `.gitignore`

## Tasks & Acceptance

**Execution:**
- [ ] `shared/@core.ts` -- add `issuance_import = "issuance.import"` to `AuditAction` with a comment -- the audit row of an import needs a named action
- [ ] `server/src/entities/xml-import-file.entity.ts` + `index.ts` + `server/src/migrations/1791600000000-XmlImportFiles.ts` -- the tracking table, synchronize parity (the migrations e2e spec checks it) -- database backed idempotency
- [ ] `etls/issuance-xml-import/` scaffold, `npm install` inside it, `.env.example` with every variable commented like `server/.env.example`
- [ ] `src/config/*` -- config and root resolution, `env.spec.ts`
- [ ] `src/parsers/*` -- contract, parser, fixtures, `xml-parser.spec.ts` covering every parser row of the matrix
- [ ] `src/services/transform.ts` + spec -- diff rules, revision rule
- [ ] `src/repositories/*` -- pool, claim SQL, issuance SQL, audit insert
- [ ] `src/services/scanner.ts`, `files.ts`, `pipeline.ts`, `status.ts`, `scheduler.ts` + specs on temporary directories and fake timers
- [ ] `src/app.ts`, `src/server.ts`, `app.spec.ts` with supertest against a fake runner
- [ ] `src/e2e/*` -- the database rows of the matrix: insert, update with items and revision, unchanged, delivered refusal with rollback, duplicate bytes archived, same document id, crash after commit, two claims, retryable keeps the file (close the pool under the pipeline or inject a repository that throws `RetryableError`), audit row shape, `xml_outbox` count unchanged, archive collision
- [ ] `README.md` of the ETL with the fifteen sections of the user's brief and the example document; repo docs as listed in the Code Map

**Acceptance Criteria:**
- Given a valid file in the input directory and `ETL_AUTO_START=true`, when one tick passes, then the issuance and its items exist with `source = 'sap'`, one audit row `issuance.import` exists, `xml_import_files` holds one `completed` row and the file is in the archive directory.
- Given the same bytes dropped again under any name, when a run happens, then no table changes and the file lands in the archive under a free name.
- Given a file whose second issuance violates the contract, when a run happens, then no row of the first issuance exists, the file is in the error directory with its sidecar and the tracking row is `failed` / `permanent`.
- Given the database is unreachable, when a run happens, then the file stays in the input directory, the process keeps running and `GET /health` answers 503 with `db: 'down'`.
- Given `ETL_ADMIN_TOKEN=secret`, when `POST /run` is sent without the header, then 401; with it, then the run summary.
- Given a run in progress, when `POST /run` is sent, then 409 `run_in_progress`.

## Verification

**Commands:**
- `cd etls/issuance-xml-import && npm run typecheck` -- expected: no errors
- `cd etls/issuance-xml-import && npm run build && node -e "require('./dist/etls/issuance-xml-import/src/config/paths.js')"` -- expected: dist layout as planned
- `cd etls/issuance-xml-import && npm test` (docker compose up -d first) -- expected: all green, the e2e suite on `equipment_supply_etl_test`
- `cd server && npm run test:unit` -- expected: green (169 + whatever a new spec adds)
- `cd server && npm run test:e2e` -- expected: green; `migrations.e2e.spec` passes with the tenth migration
- `cd client && npm test` -- expected: 154 green (shared/@core changed)

**Manual checks:**
- `npm run dev` in the ETL with the compose database, drop `src/parsers/fixtures/valid-two-issuances.xml` into `data/input`, `curl -X POST -H "Authorization: Bearer <token>" localhost:3101/run`, then `psql` on `issuances` / `issuance_items` / `audit_log` / `xml_import_files`.

## Design Notes

- Why `pg` and not TypeORM at runtime: the import is a handful of locked statements; the repo's known TypeORM pitfalls (a `save` nulling foreign keys, paginated joins) are exactly the ones an upsert of items would hit. The schema stays TypeORM's: the entity and the migration live on the server side so LOCAL `synchronize` and `migration:run` create the table and the parity spec guards it.
- Why TypeORM only as a devDependency: the e2e setup builds `equipment_supply_etl_test` from the real `server/src/entities`, so the ETL is always tested against the exact current schema. The entities resolve `typeorm` from `server/node_modules` while the `DataSource` is the ETL's copy; TypeORM keeps its metadata storage on `globalThis` and `reflect-metadata` attaches to the global `Reflect`, so this works. If it does not, the fallback is a child process `npx ts-node` run inside `server/` that builds the schema, noted in Implementation Notes.
- The provisional document (also in the README with the mapping table):

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
      <Customer><Name>ישראל ישראלי</Name><IdNumber>012345678</IdNumber><Phone>050-1234567</Phone></Customer>
      <Address><Street>הרצל 12</Street><Building>בניין B קומה 3</Building><City>תל אביב</City></Address>
      <Notes>...</Notes>
      <Items>
        <Item><LineNo>1</LineNo><ProductName>מחשב IEXXX</ProductName><CatalogNumber>PKG-1102</CatalogNumber><StationNumber>1104</StationNumber><SerialNumber>SN1</SerialNumber><Quantity>1</Quantity></Item>
      </Items>
    </Issuance>
  </Issuances>
</IssuanceImport>
```

- Field rules: `DocumentId` required, 1 to 100 chars of `[A-Za-z0-9._:-]`; `GeneratedAt` required ISO 8601; `SapNumber` required `^\d{1,20}$`, unique in the file; `NumberPrefix` optional ≤ 10; `Priority` optional `normal` | `urgent` (default `normal` on insert); `DeliveryDate` optional `yyyy-mm-dd` and a real date; `Customer/Name`, `Address/Street`, `Address/City` required 1 to 200; `IdNumber`, `Phone` optional ≤ 40; `Building` optional ≤ 200; `Notes` optional ≤ 2000; `Items` required with 1 to 500 `Item`; `LineNo` required positive integer unique in the issuance; `ProductName` required ≤ 200; `CatalogNumber`, `StationNumber`, `SerialNumber` optional ≤ 100; `Quantity` optional positive integer ≤ 100000, default 1. Whitespace trimmed; an element present but empty counts as present with an empty value for optional strings (clears nothing: an empty optional string is treated as absent, documented).

## Implementation Notes

- 2026-10-25, implemented on base bc63444 by the build run. Every file of the Code Map exists; nothing outside it was touched. No commit.
- **Dependency versions.** `npm view` on the day: express 5.3.0, pg 8.23.1, fast-xml-parser 5.11.2, dotenv 18.0.9, tsx 4.23.15, supertest 7.3.1, @types/express 5.0.6, @types/pg 8.23.1, @types/supertest 7.2.1, @types/node 20.19.43, reflect-metadata 0.2.2. Three deliberate deviations from "latest": `typescript ^5.9.3` (latest is 7.0.2, the native compiler; the whole repository compiles with 5.9 and the e2e setup transpiles the server entities with `ts.transpileModule`), `typeorm ^0.3.31` (latest is 1.1.2; the entities' decorators come from the server's 0.3.31 copy and the ETL's `DataSource` must read the same metadata shapes), and `vitest ^3.2.7` with `vite ^6.4.5` pinned explicitly (vitest 4 pulls vite 8, vitest 3 alone pulls vite 7, both need Node 20.19 for `util.styleText`; this machine runs Node 20.11 and the README says Node 20). `npm install` needed `--legacy-peer-deps`: plain npm 10.2.4 fails with "Cannot read properties of null (reading 'edgesOut')" on this tree.
- **Schema build in the e2e setup works in process**, as the design note hoped: the entities resolve `typeorm` from `server/node_modules`, the `DataSource` is the ETL's copy, the metadata storage on `globalThis` is shared. One piece the note did not foresee: vitest's esbuild has no `emitDecoratorMetadata`, and an untyped `@Column()` reads its type from `design:type`, so `vitest.config.ts` carries a small plugin that runs `server/src/entities/*.ts` through `ts.transpileModule` with decorator metadata on. Every untyped column of the entities is a primitive, so transpile-only metadata is exact. The child process fallback was not needed. `tsconfig.json` (typecheck) therefore has `experimentalDecorators`, `emitDecoratorMetadata` and `strictPropertyInitialization: false` for the entities' sake; `tsconfig.build.json` turns all three back and excludes `src/e2e/**` and the specs, so the build is strict and decorator free.
- **Oversized files** are refused without a read, as the plan says, which leaves no bytes to hash: the tracking row is keyed by a stand-in fingerprint, the SHA-256 of `oversized <name> <size>`, documented in the ETL README under File lifecycle. `size_bytes` is capped at int4.
- **EXDEV in moveSafely**: the plan said "copy with COPYFILE_EXCL then unlink", but the name was already reserved with `open('wx')`, so `COPYFILE_EXCL` would refuse our own placeholder. The copy goes into the reserved placeholder without the flag (it is ours, created exclusively a moment ago), then the source is unlinked. Same guarantee, one call fewer.
- **The 23505 on `document_id`** (two files with the same `DocumentId` racing into the commit) is mapped to a `PermanentError` by `classify`, recognized through the pg `detail` text (`Key (document_id)=...`), since the constraint name is typeorm's and the ETL has no typeorm at runtime. Every other 23505 (a concurrent insert of the same new `sap_number`) stays retryable: the retry finds the row and updates it.
- **A refusal that cannot be recorded** (the database went away between the rollback and the `fail` mark) leaves the file in the input directory whatever the error kind and ends the run; nothing is moved on a word nobody recorded. Not in the matrix, the natural reading of "marks the row ... when the database answers".
- **`ETL_MIN_FILE_AGE_MS=0` turns the age check off** explicitly. With the plain `age < 0` comparison an NTFS mtime a few ms ahead of `Date.now()` made a just written file "young", which showed up as a flaky e2e case on Windows (the run after found the same bytes twice: one claimed, one already imported).
- **Windows `copyFile` keeps the source's mtime**, so a fixture copied into a temporary input directory looks old to the age check; the specs set the ages with `utimes` by hand. Noted in the ETL README.
- **`POST /run` right after a drop** finds nothing on the first call (the files are younger than 2 s) and reports them under `awaiting`; the second call imports them. Seen in the manual check, the designed behaviour.
- **Manual check** ran against `equipment_supply_etl_test` (DB_NAME overridden), not `equipment_supply`: the dev database is shared with another session and the fixture's SAP numbers would have landed in its board. The fixture pair (`valid-two-issuances.xml`, `invalid-second-issuance.xml`) gave `succeeded 1, failed 1`: two issuances with `source = 'sap'`, three lines, two `issuance.import` audit rows with the file row id as `batch_id`, one `completed` and one `failed / permanent` tracking row, the sidecar with the path and the rule, `xml_outbox` empty.
- **Verification output**: ETL `npm run typecheck` clean; `npm run build` emits `dist/etls/issuance-xml-import/src/*.js` and `dist/shared/{@core,@rules}.js`, `require('./dist/etls/issuance-xml-import/src/config/paths.js')` resolves `PROJECT_ROOT` to the package; ETL `npm test` 87 passed (63 unit in 9 files, 24 e2e in 2 files on `equipment_supply_etl_test`), the e2e run three times in a row; server `npm run test:unit` 169 passed, `npm run test:e2e` 129 passed including `migrations.e2e.spec` with the tenth migration (parity with the entity on the first attempt); client `npm test` 153 of 154: `src/courier/offline/store.spec.ts > readTask > a done snapshot task with a synced local report and no detail row shows the local attempt` fails on HEAD bc63444 with `shared/@core.ts` byte for byte as committed (checked by backing the enum line out and running the spec again), so it is a pre-existing failure outside this plan's Code Map and was left alone. The README counts list the client at 154 as before.
- **Files touched outside the ETL package**: `shared/@core.ts` (`AuditAction.issuance_import`), `server/src/entities/xml-import-file.entity.ts` (new), `server/src/entities/index.ts`, `server/src/migrations/1791600000000-XmlImportFiles.ts` (new), `docs/domain.md` (the table bullet, "Ten migrations", the migration bullet), `README.md` (Documentation, Status, Repository layout, Tests, open decision 17), `.gitignore` (`etls/issuance-xml-import/data/`), this plan.

- **Variable names aligned with the brief (post-implementation, by the build session):** `ETL_INPUT_DIR` / `ETL_ARCHIVE_DIR` / `ETL_ERROR_DIR` became `XML_INPUT_DIR` / `XML_ARCHIVE_DIR` / `XML_ERROR_DIR` and `ETL_POLL_MS` became `ETL_POLL_INTERVAL_MS` with the brief's default of 10000, in `env.ts`, `env.spec.ts`, `.env.example` and the ETL README. The server e2e suite was run twice by the build session: one run had a single failure in `xml-export.e2e.spec` (the mocked outbox transaction), the second run and the spec alone passed 129/129 and 14/14, so it is a timing one-off unrelated to this change.

## Plan Change Log

- 2026-10-25, pre-push bug review: the plan allowed every item change on an `assigned` issuance. A line inserted or restored there breaks `docs/offline-sync.md`'s invariant that a courier's snapshot holds every live line (the stale report check forgives removed lines only, an added line turns the queued report into a 400 the tablet files as invalid). Amended: on `assigned`, field changes and removals are applied, an inserted or restored line refuses the file (permanent, retried by dropping the file again once the status moved). Also: the rows of a file are pre-locked in id order (the server's bulk order) against deadlocks with a concurrent assign / mark urgent; `Notes` is limited to 500 like the manager's edit; the validator's message is reduced to its code and position.

## Review Triage Log

### Pass 2 (2026-10-25): pre-push bug hunter (1 blocker, 1 warning, 4 nits) and practice reviewer (4 warnings, 3 nits)

Fixed:
- Blocker: a line inserted or restored on an assigned issuance broke the stale offline report path (a 400 instead of the 409, the invariant of docs/offline-sync.md that a courier's snapshot holds every live line). The import refuses the file for that case (Plan Change Log); `pipeline.spec` and `import.e2e.spec` cover the insert, the restore and the same bytes going through once the status moved.
- Deadlock class against the server's bulk actions: the rows of a file are pre-locked in one statement ordered by id before the per issuance lock.
- The validator's message could quote a character of the document: reduced to the code and the position.
- Notes limited to 500 like the manager's edit route.
- The directory guard is case blind on Windows.
- Practice: the ETL README test count and the `--legacy-peer-deps` note; the status and error kind unions moved to `shared/@core.ts` (entity and ETL types read them); the scanner names a file whose stat failed for a reason other than ENOENT and the run logs it; no `any` in `errors.ts`; the app spec sentinel typed honestly; the CDATA e2e case built with the `extra` field.

Deferred:
- The batch is cut before the claim decides, so a head full of files held elsewhere or inside their backoff delays the files behind them: documented under known limitations with the mitigation (a larger batch).

Refuted: none.

### Pass 1 (2026-10-25): edge-case hunter (13 findings) and verification gap (3 gaps, 2 other)

Fixed:
- `complete` / `fail` had no instance fence: a holder whose lease ran out and whose row was reclaimed could overwrite the new holder's row. Both statements now carry `AND instance_id = $x AND status = 'processing'` and answer a boolean; the pipeline rolls back on a lost lease (`LeaseLostError`, counted as skipped, the file left to the new holder) and never moves a file whose refusal it could not record. Covered by `pipeline.spec` (two cases) and `import.e2e.spec` (the row reclaimed under the import).
- A file longer than the lease: same fence; the lease default moved from 2 to 5 minutes and the README says to set it longer than the longest file. No lease renewal inside the loop (deferred, see below).
- A restarted process with the same `ETL_INSTANCE_ID` waited for its own lease: the claim lets the holder reclaim its own row; the README says never to share an id.
- `moveSafely` on EXDEV left a half copied file under the reserved name when the copy failed: the placeholder is unlinked and the error rethrown.
- `toErrorDir` logged "the file stays" when only the sidecar write failed after the move: two try blocks, the second logs the final name.
- The scanner held a file with an mtime ahead of the clock for good: a negative age is not young.
- Three directories resolving to one place would rename the file in a loop: `loadConfig` refuses it (`env.spec`).
- Shutdown: the listener and the scheduler close before the last run is waited for, and the wait is bounded (30 s, exit 1, the lease reclaims the row).
- A tick that throws synchronously stopped the chain: the tick runs inside `Promise.resolve().then`.
- The DOCTYPE scan refused a well formed document that quoted the words inside a comment or a CDATA section: both are blanked out of the scan (`xml-parser.spec`).
- Ten transient failures on consecutive ticks turned a valid file permanent in under two minutes: the claim skips a `failed` / `retryable` row inside its backoff (10 s doubling per attempt, 10 min cap), so the attempts limit takes about twenty minutes of failing. The retry e2e cases set `finished_at` back to pass the backoff.
- Verification: a differing document on an `assigned` row (updated) and on a `deleted` row (refused) are e2e cases now; `classify` has its own spec and the 23505 on `document_id` is driven through the pipeline's fake `complete`.
- The seed's `TRUNCATE` list lacked `xml_import_files` (a re-dropped document would read as imported after a reseed): added, with the seed case of `server/src/e2e/audit.e2e.spec.ts` inserting a row before the seed and asserting the table is empty after. Outside the plan's Code Map, named here.
- `isTransientCode` was exported and never called: removed. The plan's design notes used the pre-rename variable names: fixed.

Deferred:
- Renewing the lease inside the per-issuance loop for files that take longer than the lease: the fence makes the consequence a wasted retry rather than a double import, and a 5 minute lease covers a 500 line document many times over.

Refuted:
- "Upserts complete issuance records" versus the merge semantics (absent optional element leaves the column alone): the plan's Boundaries state the rule in those words, the ETL README documents it under the field rules and open decision 17 names it as undecided with SAP. Not a contradiction of the code with the plan.
