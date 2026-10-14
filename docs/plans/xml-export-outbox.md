---
title: 'XML export of every issuance status change to S3 through a transactional outbox'
type: 'feature'
created: '2026-10-14'
status: 'approved'
base: 'cddac77'
context: ['AGENTS.md', 'server/src/audit/audit.service.ts', 'server/src/migrations/1791000000000-AuditLog.ts', 'server/src/e2e/audit.e2e.spec.ts']
---

## Intent

**Problem:** An external consumer (the SAP side, contract not written yet) must receive one XML document for every committed change of an issuance's status. Today the status moves in five transactions across two services and nothing leaves the database.

**Approach:** An `xml_outbox` row inserted on the caller's `EntityManager` right after each status write, the way `AuditService.record` already rides every transaction; a polling worker inside the NestJS process claims rows with `FOR UPDATE SKIP LOCKED` and a lease, builds the XML from the row's immutable payload and uploads it to S3 with a deterministic key and a conditional put. No queue, no scheduler package, one new dependency: `@aws-sdk/client-s3` (the user's stated preference).

## Boundaries & Constraints

**Always:**
- One `XmlOutboxService.record(em, ...)` call per status write, after the write, inside the same transaction, after the audit row. The lock order (issuance, then task) is untouched: the insert takes no lock.
- `record` returns without inserting when `from === to` (a reassign of an already assigned issuance). The guard lives in the service, never at the call sites.
- The payload is a snapshot: everything the XML needs is in the row. The worker never reads `issuances`.
- No network inside a database transaction. The worker claims in one short transaction, uploads outside, then updates the row.
- Same event, same key: `${prefix}YYYY/MM/DD/issuance_{issuanceId}_{eventId}.xml` from the event's `occurred_at` (UTC) and uuid. `PutObject` with `IfNoneMatch: '*'`; on 412 a `HeadObject` compares the `event-id` and `content-sha256` metadata and completes the row when they match, marks it `failed` (`key_collision`) when they do not.
- At-least-once processing, effectively-once artifact. Never claim exactly-once in docs.
- Outbox rows are written whether or not `XML_EXPORT_ENABLED` is set; the flag only starts the worker, so a backlog written before the bucket existed is exported once it does.
- Config through `server/src/env.ts` only (`xmlExportConfig()`), validated in `assertSafeConfig`. Credentials from the SDK default provider chain, never from code.
- Logs carry event id, issuance id, attempt, s3 key, error category and duration. Never the XML body, never customer fields.
- Server style: 2 spaces, single quotes, lowercase `//why` comments, `/*──*/` between top level functions. Specs 4 spaces.

**Never:**
- No change to the transition table, the offline conflict rules, response bodies, status codes or the client.
- No `@nestjs/schedule`, no XML library, no local temp files. A 40 line escaping serializer in `xml.ts` is enough and is unit tested.
- No invented final contract: the XML is marked provisional (`schemaVersion="0.1-provisional"`, documented) and carries no customer name, id number, phone, address or signature.
- No events for the seed (it inserts rows, it transitions nothing) and none for `remove_item`, edits, mark urgent (status unchanged).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Assign, bulk of 3 open | ids, courier | 3 rows `pending`, `sequence` 1 per issuance (or n+1), trigger `issuance.assign`, actor = manager | none |
| Assign, one delivered in batch | ids | 409 as today, zero rows | ConflictException unchanged |
| Reassign assigned to assigned | one id | 200 as today, zero rows (same status) | none |
| Self pickup via PATCH | `self_pickup: true` | one row `assigned -> self_pickup`; a PATCH of priority only writes none | none |
| Courier report | valid body | one row `assigned -> delivered | partially_delivered | not_delivered`, actor courier, details task/attempt ids, items counts | replay: no new row |
| Handover report | manager | one row `self_pickup -> outcome` | none |
| Soft delete | reason | one row `x -> deleted` | none |
| Three transitions, worker runs late | unassigned→assigned→delivered | three XML files, each with its own previous/new status and `Sequence` 1,2,3, uploaded in id order | none |
| Worker tick, S3 ok | pending rows | `completed`, `processed_at`, `s3_key`, `content_sha256` set | none |
| S3 throws (network, 5xx, 429, timeout) | | row back to `pending`, `attempts+1`, `next_retry_at` = now + backoff (5s·2^(n-1), cap 15 min, ±50% jitter), `last_error` | logged warn |
| Attempts reach `XML_EXPORT_MAX_ATTEMPTS` (20) | | `failed`, logged error, stays for retry | none |
| XML cannot be built (corrupt payload) | | `failed` at once, `last_error` category `xml` | none |
| Upload stored, process dies before completion | lease expires | reclaimed, put answers 412, head matches, `completed`, no second file | none |
| Two workers tick together | | disjoint claims (`SKIP LOCKED`); a row claimed within its lease is never claimed again | none |
| Earlier event of the same issuance still pending or processing | | the later one is not claimed this tick (per issuance order) | none |
| `GET /api/xml-export` | manager | `{ counts: { pending, processing, completed, failed, retry_waiting, lease_expired }, failed: [...] }` | courier 403 |
| `POST /api/xml-export/:id/retry` | failed row | `pending`, attempts 0, audit `xml_export.retry` | not failed 409, unknown 404 |
| Startup with `XML_EXPORT_ENABLED=true` and no bucket or region | | refuses to start, named variable in the error | none |

## Code Map

- `shared/@core.ts` -- `XmlOutboxStatus` enum, `IXmlExportEvent`/`IXmlExportOverview` contracts, `AuditAction.xml_export_retry`.
- `server/src/entities/xml-outbox.entity.ts`, `entities/index.ts` -- table `xml_outbox`: `id` uuid pk (`gen_random_uuid()` default, generated in JS too), `issuance_id` int, `sequence` int, `previous_status`, `new_status` varchar(24), `trigger` varchar(40), `payload` jsonb, `status` varchar(12), `attempts` int default 0, `next_retry_at` timestamptz default now(), `created_at` timestamptz default now(), `occurred_at` timestamptz, `lease_until` timestamptz null, `processed_at` timestamptz null, `s3_key` varchar null, `content_sha256` char(64) null, `last_error` text null. Indexes: `(status, next_retry_at)`, `(issuance_id, sequence)` unique, `(status, lease_until)`.
- `server/src/migrations/1791300000000-XmlOutbox.ts` -- CREATE TABLE IF NOT EXISTS plus the indexes, names from `DefaultNamingStrategy` exactly like `AuditLog1791000000000`. `uuid` column type with `DEFAULT gen_random_uuid()` (PostgreSQL 16 built in).
- `server/src/env.ts` -- `xmlExportConfig()` reads `XML_EXPORT_ENABLED`, `AWS_REGION`, `XML_EXPORT_BUCKET`, `XML_EXPORT_PREFIX` (default `issuance-status-changes/`, `^[A-Za-z0-9._/-]*$`, must end with `/` unless empty), `XML_EXPORT_POLL_MS` (5000, min 1000), `XML_EXPORT_BATCH` (20), `XML_EXPORT_LEASE_MS` (60000), `XML_EXPORT_MAX_ATTEMPTS` (20), `XML_EXPORT_S3_ENDPOINT` (optional, path style, for MinIO/LocalStack), `XML_EXPORT_KMS_KEY_ID` (optional: `aws:kms`, else `AES256`). `assertSafeConfig` calls it and logs `xml export: off | bucket/prefix`.
- `server/src/xml-export/xml-export.module.ts` -- `@Global()`, imports `TypeOrmModule.forFeature([XmlOutbox])` and `AuthModule`, exports `XmlOutboxService`.
- `server/src/xml-export/xml-outbox.service.ts` -- `record(em, { issuance: { id, sap_number, number_prefix, priority, delivery_date, self_pickup, revision }, from, to, actor, trigger, details })`: no-op on equal statuses; `sequence` = `COUNT(*) + 1` of the issuance's rows on `em` (safe: the caller holds the issuance lock); builds the payload and inserts. Also `overview()` and `retry(id, user)` for the controller, `claim(batch, leaseMs)`, `complete(id, key, sha)`, `fail(id, error, permanent)`.
- `server/src/xml-export/xml.ts` -- `escapeXml`, `serialize(node)` (element tree to a UTF-8 string with the declaration); strips the characters XML 1.0 forbids.
- `server/src/xml-export/xml-builder.service.ts` -- `build(row): { xml: string; sha256: string }` from the payload only. Provisional document in Design Notes.
- `server/src/xml-export/s3-storage.service.ts` -- `putIfAbsent(key, body, metadata)` and `head(key)` over one `S3Client` (region, optional endpoint + `forcePathStyle`, request timeout 15s, SDK retries left at default). Maps the SDK error to `{ category: 'precondition' | 'transient' | 'permanent' }`: `PreconditionFailed`/412 → precondition; 5xx, 429, 408, network, timeout → transient; 400/403/404 (`AccessDenied`, `NoSuchBucket`, KMS) → transient too (an IAM fix must not need a manual retry) but logged as `config`. `ContentType: application/xml; charset=utf-8`, `ServerSideEncryption`, metadata `event-id`, `issuance-id`, `sequence`, `content-sha256`.
- `server/src/xml-export/xml-export.worker.ts` -- `onApplicationBootstrap` starts `setInterval(tick, pollMs)` when enabled (unref'd timer, no overlap: a tick in flight skips the next), `onModuleDestroy` clears it and waits for the tick in flight. `tick()` is public for the specs: claim, then per row build → put → complete, catch → fail. A row whose `attempts` already exceed the max at claim time is failed, not uploaded.
- `server/src/xml-export/xml-export.controller.ts` -- `GET /api/xml-export`, `POST /api/xml-export/:id/retry`, `@Roles(manager)` like `audit.controller.ts`.
- `server/src/issuances/issuances.service.ts` -- `assign` :340, `update` :249 (self pickup branch only), `softDelete` :369, `reportSelfPickup` :209: one `record` call each after the audit row. Constructor gains `XmlOutboxService`; `issuances.lookup.spec.ts` passes a stub.
- `server/src/delivery/delivery.service.ts` :174 -- `record` after the audit row (the replay paths return before it, the unique violation catch never reaches it).
- `server/src/app.module.ts` -- `XmlExportModule`. `server/src/seed/seed.service.ts` and the seven e2e TRUNCATE lists -- `xml_outbox` added.
- `server/.env.example` -- the variables, all commented out except `XML_EXPORT_ENABLED=false`.
- `server/package.json` -- `@aws-sdk/client-s3`; restore the one line `moduleFileExtensions` after `npm install` reflows it.
- `docs/xml-export.md` (new), `docs/domain.md` (seven migrations, the outbox rule under Concurrency), `docs/api.md` (two endpoints), `README.md` (`## Status`, `## Environment switches`, `## Tests`, `## Open decisions` 16: what SAP should hear about a courier change that leaves the status `assigned`, and the XML contract itself).

## Tasks & Acceptance

**Execution:**
- [x] `server/package.json` -- `npm install @aws-sdk/client-s3`, fix the reflow -- the only new dependency.
- [x] `shared/@core.ts` -- enums and contracts -- the contract changes there first.
- [x] `server/src/entities/xml-outbox.entity.ts`, `entities/index.ts`, `server/src/migrations/1791300000000-XmlOutbox.ts` -- table and indexes -- `synchronize` and the migration must produce the same objects.
- [x] `server/src/env.ts` -- `xmlExportConfig()` and the startup check -- one reader of the switches (AGENTS.md).
- [x] `server/src/xml-export/xml.ts`, `xml-builder.service.ts` -- serializer and provisional document -- independent of S3.
- [x] `server/src/xml-export/s3-storage.service.ts` -- conditional put, head, error categories -- the only file that imports the SDK.
- [x] `server/src/xml-export/xml-outbox.service.ts`, `xml-export.worker.ts`, `xml-export.controller.ts`, `xml-export.module.ts` -- outbox writer, claim/complete/fail, worker loop, manager endpoints.
- [x] `server/src/issuances/issuances.service.ts`, `server/src/delivery/delivery.service.ts`, `issuances.lookup.spec.ts`, `app.module.ts`, `seed.service.ts`, the e2e TRUNCATE lists -- wiring.
- [x] `server/src/xml-export/xml.spec.ts`, `xml-builder.service.spec.ts`, `s3-storage.service.spec.ts` (SDK `send` mocked), `xml-outbox.service.spec.ts` (same-status guard, backoff bounds, payload has no customer fields) -- unit, no database.
- [x] `server/src/e2e/xml-export.e2e.spec.ts` -- `S3StorageService` overridden with an in-memory fake (`overrideProvider`): every matrix row that touches the database or the worker, two concurrent claims, lease recovery, the stored-then-timeout case, the manager endpoints.
- [x] `server/src/env.spec.ts` -- the config reader's refusals and defaults.
- [x] `docs/xml-export.md`, `docs/domain.md`, `docs/api.md`, `README.md`, `server/.env.example` -- documentation and counts.

**Acceptance Criteria:**
- Given any of the five status-writing transactions commits with a status that moved (a reassign of an assigned issuance writes none), when the row is read, then exactly one `xml_outbox` row exists for it with the statuses before and after, the actor from the token and `sequence` one above the issuance's previous row.
- Given the transaction fails after the status write (simulated by a bad outbox insert in a spec), when the request returns, then the issuance status is unchanged and no row exists.
- Given three committed transitions of one issuance and the worker runs once afterwards, when the fake bucket is read, then it holds three distinct keys whose XML carries the correct previous/new statuses and the original `occurred_at`.
- Given the fake put throws a transient error twice and then succeeds, when three ticks run (with `next_retry_at` moved back by the spec), then the row is `completed` with `attempts = 3` and the bucket holds one object.
- Given the fake stored the object but threw a timeout, when the row is claimed again after its backoff (a lease that ran out takes the same path), then the second put gets 412, the head matches and the row is `completed` without a second object.
- Given two `claim` calls run concurrently on ten pending rows, when both return, then their ids are disjoint and every row is `processing` with a lease.
- Given a courier token, when it calls either endpoint, then 403.
- Given a fresh database, when `npm run migration:run` runs, then `xml_outbox` exists with the entity's columns and three indexes and `migration:show` lists `XmlOutbox1791300000000`.

## Verification

**Commands:**
- `cd server && npx tsc --noEmit -p tsconfig.json` -- expected: no errors.
- `cd server && npm run build` -- expected: `dist/server/src/migrations/1791300000000-XmlOutbox.js` present.
- `cd server && npm run test:unit 2>&1 | tail -40` -- expected: all suites pass, the new specs included.
- `docker compose up -d && cd server && npm run test:e2e 2>&1 | tail -40` -- expected: all suites pass, `xml-export.e2e.spec.ts` included.
- `cd client && npx tsc --noEmit && npm test 2>&1 | tail -20` -- expected: unchanged counts (`shared/@core.ts` still compiles for the client).
- `cd server && npm audit --omit=dev 2>&1 | tail -5` -- expected: no new high or critical findings.

**Manual checks:**
- `DB_NAME=equipment_supply_test npm run migration:show` after an e2e run lists `XmlOutbox1791300000000`; `pg_dump --schema-only -t xml_outbox` of a migrated copy matches the synchronized one (the audit plan's recipe).

## Design Notes

Provisional XML (UTF-8, element omitted when the value is null, documented in `docs/xml-export.md`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<IssuanceStatusChange xmlns="urn:equipment-supply:issuance-status-change" schemaVersion="0.1-provisional">
  <EventId>uuid</EventId><Sequence>2</Sequence><OccurredAt>2026-10-14T08:00:00.000Z</OccurredAt>
  <Issuance><Id>12</Id><SapNumber>7000001</SapNumber><NumberPrefix>ס'</NumberPrefix><Priority>normal</Priority><DeliveryDate>2026-10-20</DeliveryDate><SelfPickup>false</SelfPickup><Revision>3</Revision></Issuance>
  <PreviousStatus>assigned</PreviousStatus><NewStatus>delivered</NewStatus><Trigger>delivery.report</Trigger>
  <Actor type="user"><UserId>4</UserId><Username>c</Username><Role>courier</Role></Actor>
  <Details><TaskId>9</TaskId><AttemptId>3</AttemptId><CourierId>2</CourierId><ItemsDelivered>2</ItemsDelivered><ItemsTotal>2</ItemsTotal></Details>
</IssuanceStatusChange>
```

Claim, one statement, so two processes never take the same row and per issuance order holds:

```sql
UPDATE xml_outbox SET status = 'processing', attempts = attempts + 1, lease_until = now() + $lease
WHERE id IN (SELECT c.id FROM xml_outbox c
  WHERE ((c.status = 'pending' AND c.next_retry_at <= now()) OR (c.status = 'processing' AND c.lease_until < now()))
    AND NOT EXISTS (SELECT 1 FROM xml_outbox p WHERE p.issuance_id = c.issuance_id AND p.sequence < c.sequence AND p.status IN ('pending', 'processing'))
  ORDER BY c.created_at, c.sequence LIMIT $batch FOR UPDATE SKIP LOCKED)
RETURNING *
```

`id` is a uuid, so "earlier" within an issuance is `sequence`, never `id`. A `failed` row does not block the later rows of its issuance: the consumer sees the gap in `Sequence`, and the manager's retry closes it. Every later update of a claimed row (the lease renewal before the upload, the completion, the failure) is `UPDATE ... WHERE id = $1 AND status = 'processing' AND attempts = $2` with the attempts number of the claim: a reclaimed row whose first worker finishes late matches nothing and is dropped as `lost`, the worker that reclaimed it writes the outcome, and the put's 412 path makes that outcome `completed` without a second object.

## Implementation Notes

- 2026-10-14, on top of `cddac77`, every task of the plan done. New files: `server/src/xml-export/{xml.ts, xml-builder.service.ts, s3-storage.service.ts, xml-outbox.service.ts, xml-export.worker.ts, xml-export.controller.ts, xml-export.module.ts}` with `xml.spec.ts`, `xml-builder.service.spec.ts`, `s3-storage.service.spec.ts`, `xml-outbox.service.spec.ts`; `server/src/entities/xml-outbox.entity.ts`; `server/src/migrations/1791300000000-XmlOutbox.ts`; `server/src/e2e/xml-export.e2e.spec.ts`; `docs/xml-export.md`. Touched: `shared/@core.ts`, `server/src/env.ts` + `env.spec.ts`, `entities/index.ts`, `app.module.ts`, `issuances/issuances.service.ts`, `issuances/issuances.lookup.spec.ts`, `delivery/delivery.service.ts`, `seed/seed.service.ts`, the seven e2e TRUNCATE lists, `e2e/setup-env.ts`, `server/package.json` + lock (`@aws-sdk/client-s3` 3.1151.0, the one-line `moduleFileExtensions` restored), `server/.env.example`, `README.md`, `docs/domain.md`, `docs/api.md`.
- Surprise: TypeORM's postgres `query()` answers an `UPDATE ... RETURNING` with `[rows, affected]`, not the rows. `claim()` destructures; the first e2e run handed the worker that wrapper and the bounded round loop is what stopped it from spinning.
- Decision: a tick claims in rounds until a claim comes back empty (`MAX_ROUNDS` 50). The claim takes one row per issuance (per issuance order), so the acceptance criterion "three transitions, the worker runs once, three files" needs more than one claim per tick. Two workers still never share a row.
- Decision: the `xml_export.retry` audit row uses `entity_type` `issuance` / `entity_id` the issuance id with the event uuid, the sequence, the previous attempts and the last error in `details` (`entity_id` is an integer, the outbox id a uuid; no new `AuditEntityType`), so the retry shows in the issuance's history.
- Decision: `POST /api/xml-export/:id/retry` answers 400 for an id that is not a uuid (not in the matrix; a malformed id would otherwise reach postgres and come back as a 500).
- Decision: the S3 mapper produces `precondition` or `transient` (the 400 / 403 / 404 family transient with a `config` flag, as planned); `permanent` is only ever the worker's own verdict (`xml:`, `key_collision:`, `attempts:`). `last_error` is `<category>: <message>`, cut at 500 characters.
- Decision: the S3 client is built on first use from `xmlExportConfig()` with `requestHandler: { requestTimeout: 15000, connectionTimeout: 5000, throwOnRequestTimeout: true }` (a plain config object, so no import from `@smithy/*`); the unit spec injects a fake through `@Optional() @Inject(S3_CLIENT)`, the e2e spec overrides the whole provider.
- Decision: `src/e2e/setup-env.ts` blanks `XML_EXPORT_ENABLED`, so a developer's `.env` with the worker on cannot start it under jest. The e2e spec asserts the timer is null.
- Decision: the overview lists at most 100 failed rows, oldest first. The delete reason goes into `details` cut at 200 characters like the audit row; the forbidden detail keys (customer, address, recipient, signature, notes, password) are dropped at write time and again by the builder.
- Verified: `npx tsc --noEmit` clean; `npm run build` emits `dist/server/src/migrations/1791300000000-XmlOutbox.js`; `npm test` 227 passed in 24 suites after the review fixes (116 unit, 111 e2e; was 177 / 18 before the change); client `tsc` clean and 119 tests unchanged; `npm audit --omit=dev` identical before and after the install (9 pre-existing findings, multer through `@nestjs/platform-express`, none from the SDK); the migration alone on a scratch database gives a `pg_dump -t xml_outbox` identical to the synchronized test database (only pg_dump's random `\\restrict` token differs); `DB_NAME=equipment_supply_test npm run migration:show` lists `XmlOutbox1791300000000` (pending there, synchronize created the table, same as `RemoveIssuanceItem`).
- Not done / risky: no run against real AWS, MinIO or LocalStack (the SDK calls are covered by a fake client only); whether LocalStack honours `If-None-Match: *` is unverified, MinIO does. No retention of completed rows or objects. `sequence` is `MAX + 1` under the issuance lock, which every writer holds today; a writer that forgets the lock would hit the unique index, not a wrong sequence. The working copy mixes CRLF and LF (the repo normalizes with autocrlf); the new files are LF.

## Plan Change Log

## Review Triage Log

- 2026-10-14, review pass (edge-case-hunter and verification-gap), fixes applied by the caller on top of the implementer's work; the triage below says what and why.

## Plan Change Log

- 2026-10-14, after the review: claim ownership is fenced. `renew`, `complete` and `fail` in `xml-outbox.service.ts` take `AND attempts = <attempts of the claim>` and report whether they matched; the worker renews the lease before every upload and counts a row it no longer owns as `lost` in the tick summary (a fifth field, the e2e summaries updated). The Design Notes sentence on completion was rewritten. Must survive: the claim stays one statement, no network inside a transaction, the same key for the same event.
- 2026-10-14: a 412 whose object carries the row's own `event-id` completes the row whatever the hash (the bucket keeps the first rendering, logged); only another event id is a `key_collision`. Before, a hash that changed between attempts (a schema version bump) left the row failed with no way to complete it.
- 2026-10-14: `sequence` is `MAX(sequence) + 1` instead of `COUNT + 1`, and `next_retry_at` is written from the database clock (insert `now()`, fail `now() + backoff`); the config reader caps the numbers at 2147483647 and refuses a prefix with a leading `/`, an empty, `.` or `..` segment; `main.ts` calls `enableShutdownHooks()` so `onModuleDestroy` runs on SIGTERM; the S3 client makes two attempts (40s per put at most, inside the 60s lease); a tick never rejects. Acceptance criteria 1 and 5 reworded (a reassign writes no row; the lost-response case retries after its backoff, the lease path is separate).

## Review Triage Log

2026-10-14, two reviewers on `build-xml-export-outbox.diff` (the diff was regenerated for the verification reviewer's note that it had gone stale; the fixes below were verified on the working tree).

Edge-case hunter, 12 findings:
- fixed: a worker that outlives its lease clobbers the reclaiming worker's row through `fail()` / `complete()` (fence on `attempts`, see the change log).
- fixed: `tick()` rejects into the interval callback when the database fails inside `process()` (node 20 ends the process on an unhandled rejection): `.catch` in `tick()`, worker spec "never rejects".
- fixed: a batch processed serially can outlive the lease of its later rows: lease renewed before every upload, lost rows dropped.
- fixed: a 412 with the row's own event id but another hash was a permanent `key_collision` with no way out: completed with the stored hash, logged.
- fixed: `COUNT + 1` collides with the unique index after a retention delete: `MAX + 1`.
- fixed: no upper bound on the numbers (a timer past 2^31-1 ms fires every millisecond, the lease overflows int4): capped, `env.spec` covers both edges.
- fixed: `complete()` / `fail()` reported a status they had not written when the row was no longer `processing`: both report whether they matched, the worker reads it.
- fixed: `main.ts` never called `enableShutdownHooks()`, so the drain in `onModuleDestroy` never ran on SIGTERM: added.
- fixed: `next_retry_at` from the server clock compared with the database's `now()`: written from the database clock on insert and on failure.
- fixed: a prefix of `/x/`, `a//b/` or `a/../b/` passed the character check: refused, `env.spec` covers them.
- refuted as a bug, fixed as wording: acceptance criterion 1 said every status-writing transaction commits a row; a reassign of an assigned issuance writes the status but moves nothing and the spec asked for no row then. Criterion reworded.
- refuted as a bug, fixed as wording: criterion 5 said the lost-response row is "reclaimed after its lease"; the timeout is a transient failure, the row comes back after its backoff, the lease path is the next test's. Criterion reworded.

Verification gap, 7 findings plus notes:
- fixed: the real `S3Client` was never constructed in a test (`maxAttempts`, the timeouts, path style): `s3-storage.service.spec` mocks the class and asserts the options, once per service, with and without the endpoint.
- fixed: the timer with the flag on and `onModuleDestroy` had no test: worker spec with fake timers (ticks every `XML_EXPORT_POLL_MS` with `(batch, lease)`, destroy clears the timer and resolves only after the tick in flight, off means no tick).
- fixed: the `reconcile` error branches (head throws, 412 then nothing) ran in no test: two worker spec cases assert `fail(..., false, 20)`.
- fixed: two managers retrying together was unobserved: the e2e sends both at once, `[201, 409]`, one audit row.
- fixed: the conditional `complete` / `fail` was unobserved: the e2e calls them late on a completed row and on a retried row and asserts nothing moved (now the fence).
- fixed: the overview's "oldest first, at most 100" was unobserved: an e2e inserts 101 failed rows with `generate_series` and reads 100, oldest first.
- deferred: an automated parity test of the migration against the entity (fresh schema, run the migrations, expect the schema builder to find nothing to do) belongs to the suite as a whole, the six earlier migrations are verified by the same manual `pg_dump` comparison; recorded here, not in this change.
- fixed (notes): `enableShutdownHooks` (above); "about five hours" of retries was about three (docs); the log line sentence claimed key and category on every outcome (docs); README counts updated from the final run.
