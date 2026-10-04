<!-- Moved out of README.md on 2026-10-04. The README keeps the entry-level summary; this file is the reference. -->

# Domain model and server rules

## Domain model

The spec and the designs use "issuance" (הנפקה) for several different things, so the schema separates them:

- **Issuance** (`issuances`): the SAP document. Who the customer is, where it goes, the priority. Exists whether or not anyone was sent to deliver it. Its status mirrors the latest delivery outcome. Its `revision` is the concurrency token of an offline delivery report, see [What invalidates a report](offline-sync.md#what-invalidates-a-report).
- **Issuance item** (`issuance_items`): one product line of the document, with catalog number, station number and serial. The courier answers delivered / not delivered per line, which is where partial delivery comes from.
- **Delivery task** (`delivery_tasks`): "go deliver issuance X", one issuance handed to one courier for a date. This is what the courier's board lists. Reassigning cancels the old task and creates a new one, so the history of who had it stays.
- **Courier** (`couriers`): whoever drives the equipment. Separate from `users`: a courier exists before anyone gives them a login (the sample data has two external companies without one).
- **Delivery attempt** (`delivery_attempts` + `delivery_attempt_items`): what the courier reported at the door: a result and reason per item, and who received plus the signature when at least one item was handed over. For a `not_delivered` attempt the four recipient columns and the signature are null: no one received and no one signed, so the screen never asked. Today one attempt closes a task; the table is ready for several attempts per task if "try again tomorrow" becomes a rule. `reported_at` is the server receipt time; `client_reported_at` is the device clock when the courier tapped send, kept separately because it is untrusted and can be hours earlier after an outage.
- **Delivery operation** (`delivery_operations`): the receipt of a report sent with an operation id: the account, the task, the attempt it created, a hash of the validated payload and the exact result body. The same id from the same account is answered with the stored result instead of a second attempt. Only successful reports get a row, and the row goes in the same transaction as the attempt.
- **Delivery conflict** (`delivery_conflicts`): a report the attempts route refused with a 409, handed over by the tablet as evidence: the account and courier (from the token), the original task and issuance, the revision the report was written against, the answers, the recipient and the signature (null when the signed report delivered nothing, the same rule as an attempt), the device time, a hash of the content, the rejection code and the authoritative state the server saw when it recorded it (`observed`). Review fields (`review_status`, `reviewed_by`, `reviewed_at`, `review_note`, `review_version`) are the manager's acknowledgment and sit apart from the submitted content, which never changes. Nothing here is a delivery: no attempt, no task close, no issuance status, no revision bump. Unique per (account, operation id).

Issuance statuses (`IssuanceStatus` in `shared/@core.ts`): `unassigned`, `assigned` (the courier sees it as waiting), `delivered`, `partially_delivered`, `not_delivered`, `self_pickup`, `deleted` (soft delete with a reason).

Terminology in the code follows the designers, not the original spec: issuance (not ניפוק), courier for משנע, warehouse manager for מנהל מחסן.

## Rules enforced on the server

**Status transitions.** `server/src/issuances/issuance.rules.ts` says from which status each manager action is allowed. Anything else is a 409 that names the issuance, its status and the action:

| From | assign | self pickup | delete | edit (priority, date, notes) |
| --- | --- | --- | --- | --- |
| unassigned, assigned, not delivered | yes | yes | yes | yes |
| self pickup | yes | no | yes | yes |
| delivered | no | no | no | no |
| partially delivered | no | no | no | no |
| deleted | no | no | no | no |

Bulk assignment is all or nothing: one closed issuance in the selection fails the whole batch and nothing is written. Mark urgent skips closed rows and reports how many changed.

**Delivery report validation** (`server/src/delivery/attempt.validation.ts`): exactly one answer per item, no unknown or duplicate item ids, `delivered` must be a real boolean, a reason from the closed list plus details up to 100 characters only on a line that was not delivered, another recipient needs name, numeric id and phone, the signature must be a real PNG (magic bytes checked) up to 1 MB. The recipient and the signature are required only when at least one line was delivered: a report whose every line is "not delivered" has no one to sign, so both may be left out and are stored as null (sent anyway, by an older build, they are checked and stored as before). The outcome is derived from the validated answers, never taken from the body. The JSON body is capped at 2 MB.

**Concurrency.** Every change to an issuance or its tasks locks the issuance row first (`SELECT ... FOR UPDATE`), always in the same order: issuance, then task. Two reports on the same task, or a report racing a reassignment, run one after the other and the second gets a 409. Closing a task is a conditional update on `status = pending` inside the same transaction, so nothing closes twice even without the lock. Related status changes are written together or not at all.

**Idempotent delivery reports.** A report that carries an `operation_id` (every report the tablet sends, see below) is looked up under the same locks before anything else: a stored operation of the same account with the same task and the same payload hash returns the stored result with `replayed: true`, even when the task closed meanwhile (that is the "commit succeeded, response lost" case). The same id with a different task or content is a 409 `operation_reused`. The lookup is scoped by the account (`user.sub`), so another account using the same id never sees the first account's result or signature. The receipt row is written in the same transaction as the attempt and the status changes; a rejected report leaves no row. A unique index on `(user_id, operation_id)` backs this up: a second identical request that gets past the lock hits the index, and the service answers it with the row the first request committed. Requests without an operation id behave exactly as before.

## Schema upgrade

Migrations arrived with the offline work and stay minimal: one hand written class per schema change under `server/src/migrations/`, a `DataSource` for the TypeORM CLI in `server/src/data-source.ts` (same `.env` and connection options as the app, `synchronize` always off there), and four scripts in `server/package.json`:

| Script | What |
| --- | --- |
| `npm run migration:run` | applies the pending migrations from the TypeScript sources (ts-node) |
| `npm run migration:run:prod` | the same from `dist/` (`npm run build` first), for a box without devDependencies |
| `npm run migration:revert` | reverts the last applied migration |
| `npm run migration:show` | lists the migrations and marks the applied ones |

Run `migration:run` (or `migration:run:prod`) before starting a new server build everywhere except a LOCAL machine with `DB_SYNCHRONIZE=true`, where `synchronize` adds the same objects on start and the migration becomes a no-op. The application never runs migrations by itself (no `migrationsRun`): a schema change is a deliberate step, not a side effect of a restart. TypeORM keeps the applied list in a `migrations` table it creates on the first run.

Three migrations so far, both guarded by `IF NOT EXISTS` and reversed in `down`, both adding objects only (nothing is wiped, the tables of the previous version are assumed to exist), both with column types and constraint names that match what `synchronize` generates from the entities, so a LOCAL database that ran either path shows no diff to the other:

- `OfflineSync1790600000000`: `issuances.revision`, `delivery_attempts.client_reported_at` and the `delivery_operations` table with its unique index.
- `ConflictEvidence1790800000000`: the `delivery_conflicts` table with its unique index on (`user_id`, `operation_id`) and the foreign key to `delivery_tasks`. The constraint names come from TypeORM's own naming strategy inside the migration.
- `NoRecipientWithoutDelivery1790900000000`: `delivery_attempts.recipient_type`, `delivery_conflicts.recipient_type` and `delivery_conflicts.signature_png` become nullable, for a report whose every line is "not delivered" (no one received, no one signed). `DROP NOT NULL` is a no-op where `synchronize` already did it. The revert puts the constraints back and is refused by PostgreSQL while such rows exist.
