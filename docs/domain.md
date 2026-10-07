<!-- Moved out of README.md on 2026-10-04. The README keeps the entry-level summary; this file is the reference. -->

# Domain model and server rules

## Domain model

The spec and the designs use "issuance" (הנפקה) for several different things, so the schema separates them:

- **Issuance** (`issuances`): the SAP document. Who the customer is, where it goes, the priority. Exists whether or not anyone was sent to deliver it. Its status mirrors the latest delivery outcome. Its `revision` is the concurrency token of an offline delivery report, see [What invalidates a report](offline-sync.md#what-invalidates-a-report).
- **Issuance item** (`issuance_items`): one product line of the document, with catalog number, station number and serial. The courier answers delivered / not delivered per line, which is where partial delivery comes from.
- **Delivery task** (`delivery_tasks`): "go deliver issuance X", one issuance handed to one courier for a date. This is what the courier's board lists. Reassigning cancels the old task and creates a new one, so the history of who had it stays. A self pickup handover writes a task with no courier (`courier_id` null, born done): the manager handed over at the warehouse and the attempt needs a task to hang off; no courier board ever lists it.
- **Courier** (`couriers`): whoever drives the equipment. Separate from `users`: a courier exists before anyone gives them a login (the sample data has two external companies without one).
- **Delivery attempt** (`delivery_attempts` + `delivery_attempt_items`): what the courier reported at the door: a result and reason per item, and who received plus the signature when at least one item was handed over. For a `not_delivered` attempt the four recipient columns and the signature are null: no one received and no one signed, so the screen never asked. Today one attempt closes a task; the table is ready for several attempts per task if "try again tomorrow" becomes a rule. `reported_at` is the server receipt time; `client_reported_at` is the device clock when the courier tapped send, kept separately because it is untrusted and can be hours earlier after an outage.
- **Delivery operation** (`delivery_operations`): the receipt of a report sent with an operation id: the account, the task, the attempt it created, a hash of the validated payload and the exact result body. The same id from the same account is answered with the stored result instead of a second attempt. Only successful reports get a row, and the row goes in the same transaction as the attempt.
- **Delivery conflict** (`delivery_conflicts`): a report the attempts route refused with a 409, handed over by the tablet as evidence: the account and courier (from the token), the original task and issuance, the revision the report was written against, the answers, the recipient and the signature (null when the signed report delivered nothing, the same rule as an attempt), the device time, a hash of the content, the rejection code and the authoritative state the server saw when it recorded it (`observed`). Review fields (`review_status`, `reviewed_by`, `reviewed_at`, `review_note`, `review_version`) are the manager's acknowledgment and sit apart from the submitted content, which never changes. Nothing here is a delivery: no attempt, no task close, no issuance status, no revision bump. Unique per (account, operation id).
- **Audit log** (`audit_log`): one row per committed state change. Who: `actor_type` (`user` or `system`), `actor_user_id`, `actor_username` and `actor_role`, copied at write time with no foreign key, so the row reads the same after a rename or a delete. What: `action` from the closed list `AuditAction` in `shared/@core.ts`, `entity_type` and `entity_id`. On which issuance: `issuance_id`, set on every row that concerns one, the delivery and conflict rows included, so the history of an issuance is one indexed query. In which bulk action: `batch_id`, shared by the rows of one assign, mark urgent or remove couriers. `details` holds ids and short scalars only: never a signature, a password hash or a whole payload (`audit.service` cuts strings at 200 characters and drops the key `signature_png`). Written by `server/src/audit/audit.service.ts` on the caller's transaction, after the mutation and without a lock, so a rolled back request leaves no row and a committed one always has one. Indexed by (`issuance_id`, `at`), (`actor_user_id`, `at`), (`entity_type`, `entity_id`, `at`) and (`at`).

Issuance statuses (`IssuanceStatus` in `shared/@core.ts`): `unassigned`, `assigned` (the courier sees it as waiting), `delivered`, `partially_delivered`, `not_delivered`, `self_pickup`, `deleted` (soft delete with a reason).

Terminology in the code follows the designers, not the original spec: issuance (not ניפוק), courier for משנע, warehouse manager for מנהל מחסן.

## Rules enforced on the server

**Status transitions.** `server/src/issuances/issuance.rules.ts` says from which status each manager action is allowed. Anything else is a 409 that names the issuance, its status and the action:

| From | assign | self pickup | delete | edit (priority, date, notes) | self pickup report (the handover) |
| --- | --- | --- | --- | --- | --- |
| unassigned, assigned, not delivered | yes | yes | yes | yes | no |
| self pickup | yes | no | yes | yes | yes |
| delivered | no | no | no | no | no |
| partially delivered | no | no | no | no | no |
| deleted | no | no | no | no | no |

**Self pickup handover.** A `self_pickup` issuance shows no courier: its open task was cancelled when it moved there, and whatever closed task it still has is history, not current (`current_task` is null, the courier sort key too). The warehouse manager completes it with `POST /issuances/:id/self-pickup/report`, the courier's report body checked by the same validators. Under the issuance lock the service writes a done task with no courier (`courier_id` null, `assigned_by` the manager; the courier board filters by `courier_id`, so no courier ever sees it), the attempt with its item answers, recipient and signature, then the issuance: the status is the outcome of the answers exactly as after a courier report, `self_pickup` stays true, `revision` moves, and `delivered_by_user_id` records the manager from the token (never from the body). The board and the detail show that manager's display name where the courier would be. A manager has no `couriers` row: managers never appear in the assign dialog or the couriers page. The row allows the report from `self_pickup` only, so a second report meets the status the first one set and gets the 409. A courier assignment and a second move to self pickup clear `delivered_by_user_id`: the record names the manager only while the handover is the last delivery of the issuance; the handover task itself stays in the task history.

Bulk assignment is all or nothing: one closed issuance in the selection fails the whole batch and nothing is written. Mark urgent skips closed rows and reports how many changed.

**Delivery report validation** (`server/src/delivery/attempt.validation.ts`): exactly one answer per item, no unknown or duplicate item ids, `delivered` must be a real boolean, a reason from the closed list plus details up to 100 characters only on a line that was not delivered, another recipient needs name, numeric id and phone, the signature must be a real PNG (magic bytes checked) up to 1 MB. The recipient and the signature are required only when at least one line was delivered: a report whose every line is "not delivered" has no one to sign, so both may be left out and are stored as null (sent anyway, by an older build, they are checked and stored as before). The outcome is derived from the validated answers, never taken from the body. The JSON body is capped at 2 MB.

**Concurrency.** Every change to an issuance or its tasks locks the issuance row first (`SELECT ... FOR UPDATE`), always in the same order: issuance, then task. Two reports on the same task, or a report racing a reassignment, run one after the other and the second gets a 409. Closing a task is a conditional update on `status = pending` inside the same transaction, so nothing closes twice even without the lock. Related status changes are written together or not at all.

**Idempotent delivery reports.** A report that carries an `operation_id` (every report the tablet sends, see below) is looked up under the same locks before anything else: a stored operation of the same account with the same task and the same payload hash returns the stored result with `replayed: true`, even when the task closed meanwhile (that is the "commit succeeded, response lost" case). The same id with a different task or content is a 409 `operation_reused`. The lookup is scoped by the account (`user.sub`), so another account using the same id never sees the first account's result or signature. The receipt row is written in the same transaction as the attempt and the status changes; a rejected report leaves no row. A unique index on `(user_id, operation_id)` backs this up: a second identical request that gets past the lock hits the index, and the service answers it with the row the first request committed. Requests without an operation id behave exactly as before.

**Audit log.** Every state change writes one `audit_log` row inside its own transaction, explicitly in the service that performs it (no interceptor, no request id middleware), and only when something changed: a PATCH that repeats the stored values, a replayed delivery report, a second mark urgent on rows already urgent or a repeated review with the same note write nothing. Rejected requests (400, 403, 404, 409) write nothing either; the single exception is `auth.login_failed` (wrong username or password; a login refused by configuration is not recorded), where the failure is the event. The transition table, the offline conflict rules, the response bodies and the status codes are untouched: `mark-urgent` still answers with the count of editable rows and writes rows only for the ones whose priority moved. The actions:

| Action | Entity | `details` |
| --- | --- | --- |
| `issuance.assign` | issuance | `courier_id`, `task_id`, `scheduled_date`, `from_status`; one `batch_id` per request |
| `issuance.edit` | issuance | `changes` over `priority`, `delivery_date`, `notes`, each as `{ from, to }` |
| `issuance.self_pickup` | issuance | `from_status`, plus `changes` when field edits came along |
| `issuance.self_pickup_report` | issuance | `task_id`, `attempt_id`, `outcome`, `items_delivered`, `items_total`, `revision` (the issuance revision after the handover); the actor is the manager who handed over |
| `issuance.mark_urgent` | issuance | `from_priority`; one `batch_id` per request |
| `issuance.delete` | issuance | `reason`, `from_status` |
| `courier.create`, `courier.reactivate` | courier | `name`, `employee_id` |
| `courier.update` | courier | `changes` over `name`, `employee_id`, `id_number`, `phone`, `email`, `zones` |
| `courier.remove` | courier | `name`; one `batch_id` per request |
| `delivery.report` | delivery_task (`issuance_id` set) | `task_id`, `attempt_id`, `outcome`, `operation_id`, `items_delivered`, `items_total`, `revision` (the issuance revision after the report); the actor is the courier's account |
| `delivery.conflict_record` | delivery_conflict (`issuance_id` set) | `task_id`, `operation_id`, `rejection_code`, `submitted_revision` |
| `delivery.conflict_review` | delivery_conflict (`issuance_id` set) | `review_version` |
| `auth.login` | user | none |
| `auth.login_failed` | user (`actor_user_id` null; `entity_id` the account when the name is a real one) | `known_user`, and `username` only when it names an existing account: a name that matches no account is often a password typed into the wrong field, so it is not kept |
| `system.seed` | system (`actor_type = system`) | `users`, `couriers`, `issuances` |

The existing `Logger` lines stay as operator output; the table is the record. A manager reads it through `GET /api/audit` ([API](api.md)).

## Schema upgrade

Migrations arrived with the offline work and stay minimal: one hand written class per schema change under `server/src/migrations/`, a `DataSource` for the TypeORM CLI in `server/src/data-source.ts` (same `.env` and connection options as the app, `synchronize` always off there), and four scripts in `server/package.json`:

| Script | What |
| --- | --- |
| `npm run migration:run` | applies the pending migrations from the TypeScript sources (ts-node) |
| `npm run migration:run:prod` | the same from `dist/` (`npm run build` first), for a box without devDependencies |
| `npm run migration:revert` | reverts the last applied migration |
| `npm run migration:show` | lists the migrations and marks the applied ones |

Run `migration:run` (or `migration:run:prod`) before starting a new server build everywhere except a LOCAL machine with `DB_SYNCHRONIZE=true`, where `synchronize` adds the same objects on start and the migration becomes a no-op. The application never runs migrations by itself (no `migrationsRun`): a schema change is a deliberate step, not a side effect of a restart. TypeORM keeps the applied list in a `migrations` table it creates on the first run.

Five migrations so far, all guarded by `IF NOT EXISTS` and reversed in `down`, all adding objects only (nothing is wiped, the tables of the previous version are assumed to exist), all with column types and constraint names that match what `synchronize` generates from the entities, so a LOCAL database that ran either path shows no diff to the other:

- `OfflineSync1790600000000`: `issuances.revision`, `delivery_attempts.client_reported_at` and the `delivery_operations` table with its unique index.
- `ConflictEvidence1790800000000`: the `delivery_conflicts` table with its unique index on (`user_id`, `operation_id`) and the foreign key to `delivery_tasks`. The constraint names come from TypeORM's own naming strategy inside the migration.
- `NoRecipientWithoutDelivery1790900000000`: `delivery_attempts.recipient_type`, `delivery_conflicts.recipient_type` and `delivery_conflicts.signature_png` become nullable, for a report whose every line is "not delivered" (no one received, no one signed). `DROP NOT NULL` is a no-op where `synchronize` already did it. The revert puts the constraints back and is refused by PostgreSQL while such rows exist.
- `AuditLog1791000000000`: the `audit_log` table with its four indexes on (`issuance_id`, `at`), (`actor_user_id`, `at`), (`entity_type`, `entity_id`, `at`) and (`at`). No foreign keys by design; the primary key and the index names come from TypeORM's naming strategy inside the migration, like `ConflictEvidence`.
- `SelfPickupHandover1791100000000`: `issuances.delivered_by_user_id` (nullable integer, no foreign key, like `delivery_tasks.assigned_by`) and `delivery_tasks.courier_id` becomes nullable for the handover task. The revert puts `NOT NULL` back and is refused by PostgreSQL while handover tasks exist.
