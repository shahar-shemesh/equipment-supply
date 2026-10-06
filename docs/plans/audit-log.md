---
title: 'Audit log for user and system actions (ES-5)'
type: 'feature'
created: '2026-10-06'
status: 'in-review'
base: '8fbc035'
context: ['AGENTS.md', 'server/src/issuances/issuances.service.ts', 'server/src/delivery/delivery.service.ts', 'server/src/migrations/1790800000000-ConflictEvidence.ts']
---

Jira: https://mod-malan.atlassian.net/browse/ES-5 (epic ES-3, sprint Dror-26-10-04).

## Intent

**Problem:** Nothing records who did what. Issuance edits, mark urgent, courier changes and soft deletes keep no actor at all; a delivery attempt keeps only the task's courier. Reviewing an incident after the fact means reading server stdout.

**Approach:** One append-only `audit_log` table, written through a small `AuditService` inside the same transaction as the change it describes. A closed action list in `shared/@core.ts`, a manager-only `GET /api/audit` so the log is reviewable without database access, and the seed as the first "system" actor.

## Boundaries & Constraints

**Always:**
- One row per committed state change, inserted with the caller's `em` after the mutation. A rolled-back transaction leaves no row; a committed one always has one. The audit insert takes no lock, so the issuance then task lock order is untouched.
- A row is self-describing: actor id, username and role are copied at write time, no FK to `users` or `issuances`, so rows survive deletes and renames.
- `issuance_id` is filled on every row that concerns an issuance, including delivery and conflict rows: the spec's "change history" on the issuance detail becomes one indexed query.
- Bulk actions (assign, mark urgent, remove couriers) write one row per entity sharing one `batch_id`.
- `details` holds ids and short scalars only. Never the signature PNG, a password hash or a full payload.
- A row only when something changed: an edit whose fields equal the stored ones writes nothing, a replayed report writes nothing.

**Never:**
- No rows for rejected requests (400/403/404/409). The single exception is `auth.login_failed`.
- No change to the transition table, the offline conflict rules, response bodies or status codes. `mark-urgent` keeps answering with the count of editable rows.
- No client screen, no i18n keys, no export. The `/history` screen of `docs/README.he.md` is a separate plan.
- No new dependency, no interceptor, no request id middleware: every audit call is explicit in the service.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Bulk assign, one issuance delivered | 3 ids | 409 as today, zero audit rows | ConflictException unchanged |
| Bulk assign, all open | 3 ids | 3 rows `issuance.assign`, one `batch_id`, details `{courier_id, task_id, scheduled_date, from_status}` | none |
| Edit with nothing changed | PATCH body equals stored values | 200, no row | none |
| Edit priority | normal to urgent | one `issuance.edit`, `details.changes.priority = {from, to}` | none |
| Mark urgent | [open urgent, open normal, delivered] | response count 2 (unchanged), one row for the normal one, `from_priority` | none |
| Delivery report accepted | valid body with operation_id | one `delivery.report`, actor is the courier's account, `details {task_id, attempt_id, outcome, operation_id, items_delivered, items_total}` | none |
| Same report replayed | same operation_id and hash | `replayed: true`, no new row | none |
| Report rejected, evidence kept | revision_changed then POST conflicts | no row for the 409, one `delivery.conflict_record` | none |
| Courier created with a soft-deleted id_number | POST /api/couriers | one `courier.reactivate` | none |
| Login with wrong password | | 401 unchanged, one `auth.login_failed`, `actor_user_id` null, `details.username` (cut at 100 chars) | none |
| Read log as courier | GET /api/audit | 403 | guard |
| Read log filtered | `?issuance_id=5&page=1&size=20` | `{items, total}`, newest first | `size` over 100, unknown `action`, bad int or date: 400 |
| Seed | `npm run seed` | last row `system.seed`, `actor_type = system`, `details {users, couriers, issuances}` | none |

## Code Map

- `shared/@core.ts` -- `AuditActorType`, `AuditAction` (the closed list in Design Notes), `AuditEntityType`, `IAuditEntry`, `IAuditPage`.
- `server/src/entities/audit-log.entity.ts` -- new entity, table `audit_log`; register in `entities/index.ts`.
- `server/src/migrations/1791000000000-AuditLog.ts` -- CREATE TABLE IF NOT EXISTS plus four indexes, names from `DefaultNamingStrategy` as `ConflictEvidence` does.
- `server/src/audit/` -- `audit.module.ts` (`@Global()`, exports the service), `audit.service.ts` (`record(em, entry)` for transactions, `recordDetached(entry)` for login and seed), `audit.diff.ts` (`changesBetween(before, after, fields)` returns the changed fields or null; dates compared as `YYYY-MM-DD`, arrays by value), `audit.validation.ts` (query parsing by hand, like `attempt.validation.ts`), `audit.controller.ts` (`GET /api/audit`, `@Roles(manager)`).
- `server/src/issuances/issuances.service.ts` -- `update` :137 (edit vs self_pickup, diff before save), `assign` :198, `setPriority` :179 (gains the user and a transaction: `SELECT id, priority ... FOR UPDATE`, then the same UPDATE, then rows for the ones whose priority differed), `softDelete` :236. `issuances.controller.ts` :40 passes the user to mark-urgent.
- `server/src/couriers/couriers.service.ts` -- `create` :44 (create or reactivate), `update` :63 (diff), `remove` :89; `create` and `update` move into `manager.transaction` so row and change commit together.
- `server/src/delivery/delivery.service.ts` :166 -- row right after the receipt insert; nothing on the replay paths or in the unique-violation catch. `conflicts.service.ts` `record` :92-125 and `review` :236.
- `server/src/auth/auth.service.ts` :25 -- `auth.login` / `auth.login_failed` through `recordDetached`.
- `server/src/seed/seed.service.ts` :30 -- `audit_log` joins the TRUNCATE list, `system.seed` written last. The same TRUNCATE edit in the four fixtures under `server/src/e2e/`.
- `server/src/issuances/issuances.lookup.spec.ts` -- the service constructor gains `AuditService`; pass a stub.
- `docs/domain.md` (table, action list, "four migrations"), `docs/api.md` (the endpoint), `README.md` (`## Status`, `## Tests` counts).

## Tasks & Acceptance

**Execution:**
- [x] `shared/@core.ts` -- add the enums and interfaces -- the contract changes there first (AGENTS.md).
- [x] `server/src/entities/audit-log.entity.ts`, `entities/index.ts`, `server/src/migrations/1791000000000-AuditLog.ts` -- table and indexes -- LOCAL `synchronize` and the migration must produce identical objects.
- [x] `server/src/audit/*` -- module, service, diff helper, query validation, controller -- one writer, one reader.
- [x] `server/src/issuances/issuances.service.ts`, `issuances.controller.ts` -- five issuance actions, mark-urgent gets actor and transaction -- closes the biggest actor gap.
- [x] `server/src/couriers/couriers.service.ts` -- four courier actions in transactions.
- [x] `server/src/delivery/delivery.service.ts`, `conflicts.service.ts` -- report, conflict record, conflict review.
- [x] `server/src/auth/auth.service.ts` -- login and failed login.
- [x] `server/src/seed/seed.service.ts` and the four e2e TRUNCATE lists -- `audit_log` added, seed row written.
- [x] `server/src/audit/audit.diff.spec.ts`, `server/src/audit/audit.validation.spec.ts` -- unit tests for the diff and the query edge cases of the matrix.
- [x] `server/src/e2e/audit.e2e.spec.ts` -- every matrix row end to end, reading rows through `GET /api/audit` and asserting `details` never carries `signature_png`.
- [x] `docs/domain.md`, `docs/api.md`, `README.md` -- document and update the counts to the verified run.

**Acceptance Criteria:**
- Given a manager assigns three open issuances, when the request commits, then three `issuance.assign` rows exist with the manager's id and username, one shared `batch_id`, and `issuance_id` set on each.
- Given the same selection contains a delivered issuance, when the request returns 409, then the audit table has no new row.
- Given a courier reports a task, when the same operation is sent again, then exactly one `delivery.report` row exists for that `operation_id`.
- Given any audit row, when read through `GET /api/audit`, then `details` contains no key named `signature_png` and no string longer than 200 characters.
- Given a courier token, when it calls `GET /api/audit`, then the answer is 403.
- Given a fresh database without `synchronize`, when `npm run migration:run` runs, then `audit_log` exists with the entity's columns and the four indexes, and `migration:show` lists `AuditLog1791000000000` as applied.

## Verification

**Commands:**
- `cd server && npm run build` -- expected: compiles, `dist/server/src/migrations/1791000000000-AuditLog.js` present.
- `cd server && npm run test:unit 2>&1 | tail -40` -- expected: all suites pass, the two new audit specs included.
- `docker compose up -d && cd server && npm run test:e2e 2>&1 | tail -40` -- expected: all suites pass, `audit.e2e.spec.ts` included.
- `cd client && npm test 2>&1 | tail -20` -- expected: unchanged counts (`shared/@core.ts` still compiles for the client).

**Manual checks:**
- `DB_NAME=equipment_supply_test npm run migration:show` after an e2e run lists `AuditLog1791000000000`; `npm run migration:run` against it is a no-op (table already built by `synchronize`).

## Design Notes

Table `audit_log`: `id` serial, `at` timestamptz default now(), `actor_type` varchar(8) (`user` | `system`), `actor_user_id` int null, `actor_username` varchar null, `actor_role` varchar null, `action` varchar(40), `entity_type` varchar(24), `entity_id` int null, `issuance_id` int null, `batch_id` varchar(36) null, `details` jsonb null. Indexes: `(issuance_id, at)`, `(actor_user_id, at)`, `(entity_type, entity_id, at)`, `(at)`.

Actions, entity and `details`:

| Action | Entity | details |
| --- | --- | --- |
| `issuance.assign` | issuance | courier_id, task_id, scheduled_date, from_status |
| `issuance.edit` | issuance | changes over priority, delivery_date, notes |
| `issuance.self_pickup` | issuance | from_status |
| `issuance.mark_urgent` | issuance | from_priority |
| `issuance.delete` | issuance | reason, from_status |
| `courier.create`, `courier.reactivate` | courier | name, employee_id |
| `courier.update` | courier | changes over name, employee_id, id_number, phone, email, zones |
| `courier.remove` | courier | name |
| `delivery.report` | delivery_task (issuance_id set) | task_id, attempt_id, outcome, operation_id, items_delivered, items_total, revision |
| `delivery.conflict_record` | delivery_conflict (issuance_id set) | task_id, operation_id, rejection_code, submitted_revision |
| `delivery.conflict_review` | delivery_conflict (issuance_id set) | review_version |
| `auth.login` | user | none |
| `auth.login_failed` | user (entity_id null) | username |
| `system.seed` | system | users, couriers, issuances |

`GET /api/audit`: filters `issuance_id`, `actor_user_id`, `action`, `from`, `to` (ISO date or datetime), `page` (1-based, default 1), `size` (default 50, max 100). Order `at desc, id desc`. Answer `IAuditPage { items: IAuditEntry[]; total: number }`.

The existing `Logger` lines stay; they are operator output, the table is the record.

## Implementation Notes

2026-10-06, implemented on base `8fbc035`. Nothing committed.

Decisions:
- `AuditEntry` takes an optional `actor_type`; `toRow` derives it from the actor otherwise. Needed for `auth.login_failed`: there is no account to copy, but a person typed that password, so the row is `actor_type = user` with null ids, not `system`.
- A self pickup request that also carries priority / date / notes edits writes one `issuance.self_pickup` row with `changes` next to `from_status`, not a second `issuance.edit` row: one request, one row.
- `setPriority` locks the editable rows with `SELECT id, priority ... FOR UPDATE` in id order (the order assign uses), runs the same UPDATE as before, and writes rows only for the ones whose priority differed. The response is still the count of editable rows; a second click on rows already urgent answers the same count and writes nothing.
- The `details` guard lives in `audit.service` (`scrub`): strings cut at 200 characters, the keys `signature_png`, `password` and `password_hash` dropped, nesting cut at three levels. The callers already send short values; this is the last line the acceptance criterion asks for.
- `from` / `to` on `GET /api/audit` are read as UTC; `to` is exclusive and a bare date moves to the next midnight, so `from=d&to=d` is one day. No client screen exists yet, so the convention is written in `docs/api.md` rather than guessed from a UI.
- `couriers.service.create` / `update` moved into `manager.transaction` with the same lookups; the unique violation catch wraps the transaction. Responses and status codes unchanged.
- `delivery.report` rows also for legacy reports without an operation id (`operation_id: null` in details); the row is written after the receipt insert, so the replay paths and the unique violation catch never reach it.
- The e2e seed check calls `SeedService.run()` in process with `ALLOW_DESTRUCTIVE_SEED` set for that test only and restored after, instead of spawning `npm run seed`.
- The bulk routes (assign, mark urgent, remove couriers) always set a `batch_id`, also for a selection of one: one rule, no special case.

Files touched:
- new: `server/src/audit/{audit.module,audit.service,audit.diff,audit.validation,audit.controller}.ts`, `server/src/audit/{audit.diff,audit.validation}.spec.ts`, `server/src/entities/audit-log.entity.ts`, `server/src/migrations/1791000000000-AuditLog.ts`, `server/src/e2e/audit.e2e.spec.ts`.
- changed: `shared/@core.ts`, `server/src/entities/index.ts`, `server/src/app.module.ts`, `server/src/issuances/{issuances.service,issuances.controller,issuances.lookup.spec}.ts`, `server/src/couriers/couriers.service.ts`, `server/src/delivery/{delivery.service,conflicts.service}.ts`, `server/src/auth/auth.service.ts`, `server/src/seed/seed.service.ts`, the TRUNCATE line of the four e2e specs, `docs/domain.md`, `docs/api.md`, `README.md`.

Surprises:
- None in the code. `DefaultNamingStrategy.indexName` gave the same names `synchronize` creates: verified by `migration:run` on `equipment_supply_migrate` (a `TEMPLATE equipment_supply_test` copy with `audit_log` dropped), then `pg_dump --schema-only -t audit_log` of both databases, which differ only in pg_dump's random `\restrict` token. `migration:show` on the copy lists all four as applied. The copy was dropped afterwards.
- The spec files under `server/src` are indented with 4 spaces while the sources use 2; the new specs follow the specs.
- `@Global()` `AuditModule` importing `AuthModule` (for the guard on the controller) while `AuthService` injects `AuditService` resolves without a cycle: global providers are visible to every module.

Verification run (2026-10-06):
- `cd server && npm run build`: ok, `dist/server/src/migrations/1791000000000-AuditLog.js` present.
- `cd server && npm run test:unit`: 7 suites, 59 tests passed.
- `cd server && npm run test:e2e`: 5 suites, 53 tests passed (`audit.e2e.spec.ts`: 9).
- `cd client && npm test`: 7 files, 72 tests passed (unchanged).

## Plan Change Log

- 2026-10-06, after review round 1: the failed-login audit write is best effort (a storage error is logged, the answer stays 401); the successful-login write stays strict, no record means no token. `couriers.create` and `couriers.update` lock the courier row FOR UPDATE inside their new transactions. The query validation rejects a day that is not on the calendar, reads a zone-less time as UTC, rejects id 0 and `from >= to`. Everything else in Boundaries survives unchanged.
- 2026-10-06, security pass (the built-in /security-review needs `origin/HEAD`, which this checkout lacks, so the three areas CLAUDE.md names were read by hand): `auth.login_failed` keeps the attempted name only when it is an existing account and adds `known_user`; a name that matches no account is often a password typed into the wrong field. The matrix row "details.username (cut at 100 chars)" is superseded by this. The logger line escapes the name with JSON.stringify.

## Review Triage Log

### Round 1 (2026-10-06), diff of base 8fbc035 plus the implementation

Edge case hunter, 11 findings:
1. `audit.validation.ts` accepted 2026-02-30 and rolled it to March 2nd. **Fixed**: a UTC probe rejects a day off the calendar (`is not a calendar date`), unit test added.
2. A date time without a zone was read as server local time. **Fixed**: `Z` appended when no zone is given, unit test added.
3. `issuance_id=0` / `actor_user_id=0` passed and answered an empty page. **Fixed**: 400 `ids start at 1`, unit test added.
4. `from >= to` answered an empty page. **Fixed**: 400 `from must be before to`, unit test added.
5. `scrub` nulled arrays at depth 3, so a zones change would read `{ from: null, to: null }` (also found in self review). **Fixed**: arrays allowed at depth 3, `audit.service.spec.ts` covers it.
6. Two managers reactivating the same deleted courier at once: both read it inactive, two `courier.reactivate` rows. **Fixed**: the `findOne` in `create` locks the row FOR UPDATE; the second reads it active and gets the 409.
7. Two overlapping courier edits read the same original, so the history read A->B, A->C. **Fixed**: the `findOne` in `update` locks the row FOR UPDATE.
8. `recordDetached` failing during login turned a 401 into a 500, and a successful login into a 500 without a token. **Fixed for the failed login** (best effort, logged). **Refuted for the successful login**: a login the system cannot record is not granted; the same storage problem fails every mutation anyway. Recorded in the Plan Change Log.
9. Logins refused by `AUTH_STRATEGY` / `devAuthAllowed()` write no `auth.login_failed` row. **Refuted**: those are configuration refusals already logged as errors, not credential failures; `docs/domain.md` now says "wrong username or password".
10. `mark-urgent` with a non numeric id reaches PostgreSQL as NaN and answers 500. **Deferred**: pre-existing in the controller's `.map(Number)` and shared with `assign`; a 400 guard for both routes is a separate small change.
11. The e2e date filter used `from=today&to=today` computed after the rows were written, flaky across UTC midnight. **Fixed**: a day either side.

Verification gap review, 4 gaps and 1 other finding:
1. `scrub` (200 char cut, dropped keys) was never exercised; `expectClean` passed trivially. **Fixed**: `audit.service.spec.ts` (5 tests) and a 300 character note in the e2e edit test asserting the 200 cut.
2. A legacy report without `operation_id` had no assertion on its audit row. **Fixed**: e2e test, `operation_id: null` in details.
3. Self pickup carrying a field edit was unasserted and `toMatchObject` would not notice a missing `changes`. **Fixed**: `toEqual` on both the plain and the combined case.
4. The `AuditLog` migration runs in no automated path (e2e uses synchronize). **Deferred**: the implementer ran the documented manual parity check (`pg_dump --schema-only` of a migrated and a synchronized database, identical); an automated parity test belongs with the migration tooling, not this change.
5. Other: every rejected login inserts a row before authentication, with no rate limit, and the awaited insert could turn the 401 into a 500. **Fixed** the 500 (best effort write). **Deferred** the growth: there is no rate limit on the login route at all today, a hardening item of its own.

Verification after the fixes: `npm run build` ok; `npm run test:unit` 8 suites, 66 tests; `npm run test:e2e` 5 suites, 54 tests; client unchanged at 72 (no shared change in this round).

### Security pass (2026-10-06), by hand over auth, payload validation and the delivery report route

- SQL: every new query goes through TypeORM parameters (`list()`, the FOR UPDATE select in `setPriority`); the migration is constant text. Nothing to fix.
- Authorization: `GET /api/audit` sits behind `AuthGuard` + `@Roles(manager)`, asserted for a courier (403) and anonymous (401) in e2e. Nothing to fix.
- Data in rows: `scrub` drops `signature_png`, `password`, `password_hash` and cuts strings at 200, now unit tested. Courier `changes` carry phone and id number, readable by managers only, the same as the couriers table. Accepted.
- **Fixed**: a failed login stored the attempted name verbatim; when it matches no account it is often a password typed into the username field. Now `username` is kept only for an existing account, `known_user` says which case it was, `entity_id` points at the account. The logger line escapes the name.
- Unauthenticated writes: a rejected login inserts a row before authentication and the route has no rate limit (pre-existing). Deferred to its own task.
- Reflected input: the 400 messages echo the bad `action` back as JSON; the SPA renders them as text. Accepted, consistent with the other validation files.
