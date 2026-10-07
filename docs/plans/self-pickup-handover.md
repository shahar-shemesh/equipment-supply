---
title: 'Self pickup handover: the warehouse manager completes the delivery'
type: 'feature'
created: '2026-10-07'
status: 'done'
base: 'f1c4d9c'
context: ['AGENTS.md', 'server/src/delivery/delivery.service.ts', 'client/src/courier/pages/TaskDetailPage.tsx']
---

## Intent

**Problem:** Moving an issuance to self pickup cancels its open task, but a `not_delivered` issuance still shows the courier of its closed task, and there is no way to complete the self pickup: the warehouse manager hands the equipment over at the warehouse and nothing records who did it, what was handed over, who received and signed.

**Approach:** Status `self_pickup` shows no courier at all. A new manager route takes the same report payload as the courier's attempt route (per line delivered / not delivered, recipient, signature), stores it as an attempt on a courier-less task, sets the issuance status from the outcome exactly as a courier report does, keeps `self_pickup = true`, and records the authenticated manager in a new column `issuances.delivered_by_user_id`. The board and the detail dialog show that manager where the courier would be. The client form is the courier's report form parts (`ItemReportCard`, the recipient toggle and fields, `SignaturePad`, `validateReportForm`) in a manager dialog opened from the issuance detail dialog.

## Boundaries & Constraints

**Always:**
- Reuse `validateItemAnswers`, `validateRecipient`, `validateSignature`, `handedOver`, `outcomeOf` from `server/src/delivery/attempt.validation.ts` unchanged. The outcome is derived from the answers, never from the body.
- The handover runs in one transaction that takes `lockIssuance` first, then writes the task, the attempt, the issuance update and the audit row, in that order.
- A new manager action is a row in `issuance.rules.ts` (`self_pickup_report`, allowed from `self_pickup` only), never an inline status check.
- `delivered_by_user_id` is `user.sub` from the token. The body never names the manager.
- Regular courier deliveries are byte-for-byte unchanged: `delivery.service.ts` is not touched; `delivered_by_user_id` stays null for them.
- Every entity change has a migration in `server/src/migrations/`, written with `IF NOT EXISTS` / `DROP NOT NULL` so it is a no-op on a LOCAL database that `synchronize` already updated.
- Every UI string goes through `t()` with its key in `shared/i18n/he.ts`; client 2 spaces double quotes, server single quotes, SCSS 4 spaces, comments in lowercase English explaining why.

**Never:**
- No `couriers` row for a manager. Managers never appear in `GET /couriers`, the assign dialog or the couriers page.
- No change to the offline data layer, the sync worker, the conflict rules or the courier's `TaskDetailPage`.
- No operation ids, revision check or offline queue on the manager route: it is online only.
- No new confirmation-only flow: the handover is the report form with its Send button, nothing less.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| assigned to self pickup | `PATCH /issuances/:id { self_pickup: true }` on an assigned issuance | task cancelled, `current_task` null, `delivered_by_user_id` null, board courier empty | none |
| not delivered to self pickup | same PATCH on a `not_delivered` issuance with a done task | status `self_pickup`, `current_task` null in GET and in the list, `courier_name` sort key null; the done task stays in `tasks` | none |
| handover, all delivered | `POST /issuances/:id/self-pickup/report` by a manager, every line delivered, customer recipient, png signature | 201 with the issuance: status `delivered`, `self_pickup` true, `delivered_by_user_id` = manager id, `delivered_by_name` = manager display name, one new done task with `courier_id` null and `assigned_by` = manager, one attempt with the item answers, revision + 1; the board shows the manager in the courier column | none |
| handover, nothing delivered | every line not delivered with reason and details, no recipient, no signature | status `not_delivered`, attempt with null recipient and signature, manager still recorded | none |
| handover, partial | first line delivered, second not | status `partially_delivered`, `self_pickup` true | none |
| wrong state | the route on an `assigned`, `delivered` or `deleted` issuance, or twice | nothing written | 409 naming the issuance and its status |
| wrong caller | a courier token | nothing written | 403 |
| malformed body | a string `delivered`, a duplicate item id, a missing signature with a delivered line | nothing written | 400 from the shared validators |
| courier flow | a courier reports an assigned task as before | identical to today, `delivered_by_user_id` null, the courier shown | as today |
| courier board | the handover task | never listed for any courier (`courier_id` null) | none |

## Code Map

- `server/src/entities/issuance.entity.ts` -- add `delivered_by_user_id` (nullable int, no foreign key, like `delivery_tasks.assigned_by`) and a `delivered_by` ManyToOne to `User` with `createForeignKeyConstraints: false` and `@JoinColumn({ name: 'delivered_by_user_id' })`, so the name loads with `relations`.
- `server/src/entities/delivery-task.entity.ts` -- `courier_id` becomes nullable; `courier` stays a ManyToOne.
- `server/src/migrations/` -- new `1791100000000-SelfPickupHandover.ts`: `ALTER TABLE issuances ADD COLUMN IF NOT EXISTS delivered_by_user_id integer NULL`, `ALTER TABLE delivery_tasks ALTER COLUMN courier_id DROP NOT NULL`; down reverses, noting that `SET NOT NULL` fails while handover tasks exist.
- `server/src/issuances/issuance.rules.ts` -- `self_pickup_report: [IssuanceStatus.self_pickup]`.
- `server/src/issuances/issuances.service.ts` -- `COURIER_NAME_SQL` becomes `CASE WHEN i.status = 'self_pickup' THEN NULL ELSE COALESCE(<the subselect, with LEFT JOIN couriers>, (SELECT u.display_name FROM users u WHERE u.id = i.delivered_by_user_id)) END`; `withCurrentTask` returns `current_task: null` for status `self_pickup`, strips `delivered_by` and adds `delivered_by_name`; both `find` calls load `delivered_by`; new `reportSelfPickup(id, body, user)`.
- `server/src/issuances/issuances.controller.ts` -- `@Post(':id/self-pickup/report')`, the manager role is already on the controller.
- `server/src/e2e/pagination.e2e.spec.ts` -- its `COURIER_SQL` must stay identical to the service expression (the courier sort walk compares against it).
- `server/src/delivery/conflicts.service.ts:103` -- `current_task_id` is computed from the open task there, not from `withCurrentTask`; leave it.
- `shared/@core.ts` -- `IIssuance.delivered_by_user_id?`, `delivered_by_name?`; `AuditAction.issuance_self_pickup_report = "issuance.self_pickup_report"`.
- `shared/i18n/he.ts` -- keys for the button, the dialog title and the done line; reuse `submit`, `submit_done`, `form_incomplete`, `recipient_*`, `signature*`, `item_n`.
- `client/src/manager/components/SelfPickupReportDialog.tsx` (new) -- the form; `client/src/manager/components/IssuanceDetailDialog.tsx` -- the button for status `self_pickup` and the courier fallback; `IssuancesTable.tsx:140`, `IssuanceCard.tsx:45` -- the courier fallback.
- `client/src/styles/_courier.scss` -- `.task-section`, `.item-report`, `.toggle-pair`, `.recipient-fields`, `.char-count`, `.signature-pad` are top level and reusable; `_manager.scss` gets only what the dialog itself needs.
- `docs/api.md`, `docs/domain.md` (transition table, audit table), `README.md` (Status, Tests, remove open decision 14).

## Tasks & Acceptance

**Execution:**
- [ ] `server/src/entities/issuance.entity.ts`, `server/src/entities/delivery-task.entity.ts`, `server/src/migrations/1791100000000-SelfPickupHandover.ts` -- the two schema changes and their migration -- the handover needs a home for the attempt and a record of who did it.
- [ ] `server/src/issuances/issuance.rules.ts`, `server/src/issuances/issuance.rules.spec.ts` -- the `self_pickup_report` row and its unit checks (allowed from `self_pickup` only, every other status refused).
- [ ] `server/src/issuances/issuances.service.ts` -- the courier pick (null for `self_pickup`, the manager as fallback), `delivered_by_name`, and `reportSelfPickup`: load the issuance with items for validation, validate with the shared functions, then the locked transaction: `assertCanDo('self_pickup_report')`, task `{ issuance_id, courier_id: null, status: done, closed_at: new Date(), scheduled_date: issuance.delivery_date, assigned_by: user.sub }`, attempt with items, `em.update(Issuance, id, { status: outcome, revision: issuance.revision + 1, delivered_by_user_id: user.sub })`, audit `issuance_self_pickup_report` with `{ task_id, attempt_id, outcome, items_delivered, items_total, revision }`; return `findOne(id)`. One log line.
- [ ] `server/src/issuances/issuances.controller.ts` -- the route.
- [ ] `shared/@core.ts`, `shared/i18n/he.ts` -- the fields, the audit action, the keys.
- [ ] `server/src/e2e/self-pickup.e2e.spec.ts` (new) -- own fixture in the style of `hardening.e2e.spec.ts`; one `it` per matrix row, plus: the audit row with the manager as actor, `GET /issuances?sort=courier&order=desc` places the manager's name where the same SQL does, and `GET /delivery/tasks` for the courier never lists the handover task.
- [ ] `client/src/manager/components/SelfPickupReportDialog.tsx` -- a `Dialog` with the item cards, the recipient block, the pad and a Send button; validate with `validateReportForm({ issuance } as IDeliveryTask, form)` and translate the keys like `translate` in `TaskDetailPage.tsx`; build the payload the way `submitReport` in `client/src/courier/offline/store.ts` does (recipient and signature null when nothing was delivered); `post` to the route; on success show the `success-dialog` block and call `onChanged`.
- [ ] `client/src/manager/components/IssuanceDetailDialog.tsx`, `IssuancesTable.tsx`, `IssuanceCard.tsx` -- `current_task?.courier?.name || delivered_by_name || t("detail_no_courier")`; the detail dialog shows the handover button when the status is `self_pickup`.
- [ ] `docs/api.md`, `docs/domain.md`, `README.md` -- the route, the transition row, the audit row, the counts, decision 14 removed.

**Acceptance Criteria:**
- Given an assigned or a not delivered issuance, when the manager moves it to self pickup, then `GET /issuances/:id` has `current_task: null` and `delivered_by_user_id: null`, and its list row sorts with a null courier.
- Given a self pickup issuance, when the manager sends a report with every line delivered, then the issuance is `delivered`, `self_pickup` is true, `delivered_by_user_id` equals the token's `sub`, and the list row's courier shows the manager's display name.
- Given a self pickup issuance, when a courier token, a malformed body or a second report arrives, then nothing is written and the status is 403, 400 or 409 respectively.
- Given an assigned task, when its courier reports it, then the response, the task and the audit row are what the hardening and offline specs assert today, and `delivered_by_user_id` stays null.

## Verification

**Commands:**
- `cd server && npx tsc --noEmit` -- expected: no output.
- `cd server && npm run test:unit 2>&1 | tail -20` -- expected: every suite passes, the rules spec gained its cases.
- `cd server && npm test 2>&1 | tail -40` -- expected: every suite passes with the database up (`docker compose up -d`), the new spec included.
- `cd client && npx tsc --noEmit -p tsconfig.json && npm test 2>&1 | tail -20` -- expected: clean, the 79 tests still pass.
- `cd client && npm run build 2>&1 | tail -15` -- expected: a build with no errors.

**Manual checks (only when no CLI check applies):**
- The dialog on a self pickup row: items, recipient toggle, pad, Send; after Send the detail shows the manager under שליח and the badge נמסר.

## Design Notes

Why a courier-less task and not a new table: an attempt with its items and signature already hangs off a task, the detail dialog already reads `current_task.attempts` for the undelivered lines alert, and the courier side filters by `courier_id`, so a null courier is invisible there. `self_pickup` is a waiting state like `unassigned`: the courier side of the issuance ended, so no task is current until the handover writes one.

## Implementation Notes

2026-10-07, implemented on top of the uncommitted seed / pagination step (kept as found).

Files touched:
- Server: `entities/issuance.entity.ts` (`delivered_by_user_id` + `delivered_by` ManyToOne without a constraint), `entities/delivery-task.entity.ts` (`courier_id` nullable), `migrations/1791100000000-SelfPickupHandover.ts` (new), `issuances/issuance.rules.ts` + `.spec.ts` (`self_pickup_report` row, one case), `issuances/issuances.service.ts` (`COURIER_NAME_SQL` as planned and now exported, `withCurrentTask`, both `find`s load `delivered_by`, `reportSelfPickup`), `issuances/issuances.controller.ts` (the route), `e2e/pagination.e2e.spec.ts` (the `COURIER_SQL` copy), `e2e/self-pickup.e2e.spec.ts` (new, 12 cases).
- Shared: `@core.ts` (`IIssuance.delivered_by_user_id` / `delivered_by_name`, `IDeliveryTask.courier_id` nullable, `AuditAction.issuance_self_pickup_report`), `i18n/he.ts` (`self_pickup_report`, `self_pickup_report_title`, `self_pickup_report_done`).
- Client: `manager/components/SelfPickupReportDialog.tsx` (new), `IssuanceDetailDialog.tsx` (button + nested dialog + courier fallback), `IssuancesTable.tsx`, `IssuanceCard.tsx` (fallback), `styles/_manager.scss` (`.handover-dialog`, three rules).
- Docs: `docs/api.md` (route row, contract paragraph), `docs/domain.md` (transition column, handover paragraph, audit row, task description, fifth migration), `README.md` (Status, Tests 163 server / 242 total, five migrations, layout lists, decision 14 removed).

Decisions:
- `withCurrentTask` returns `delivered_by_name: null` while the status is `self_pickup`, mirroring the `CASE` in the SQL: otherwise a row handed over once and moved to self pickup again would show the manager in the column while its sort key is null. `delivered_by_user_id` itself is left as stored by every other flow (PATCH self pickup, assign, delete do not clear it); it is "who last handed over", the audit row and the handover task keep the history.
- `delivered_by` is destructured out of the response in `withCurrentTask`: the relation is a `users` row with the password hash, only `display_name` leaves the server (asserted in the e2e).
- The handover task gets `scheduled_date: issuance.delivery_date` and `assigned_by: user.sub`, born `done` with `closed_at` now, `client_reported_at` null on the attempt.
- Validation runs before the transaction (400 before 409), the same order as `delivery.service.report`; the 409 message is the one `assertCanDo` produces.
- `COURIER_NAME_SQL` is exported so the new spec checks the sort against the very expression; the pagination spec keeps its literal copy on purpose (it guards drift).
- The client dialog duplicates the ten line `translate` of `TaskDetailPage` instead of exporting it from the courier page (the plan forbids touching that file).
- `.handover-dialog__submit.MuiButton-root` (two classes) instead of the `!important` the courier strip uses.

Surprises:
- `tsc` refused `{ item_id, ...answers[id] }` as `IDeliveryAttemptItem[]` (`delivered` optional until validation); a cast after `validateReportForm` passes.
- The test database had `AuditLog1791000000000` unapplied in its `migrations` table; `DB_NAME=equipment_supply_test npm run migration:run` applied it and the new one as no-ops over the synchronized schema.
- The dev server on port 3000 belongs to another session and still runs the old code (no `delivered_by_name` in its answers); the browser check covered the dialog through the Vite dev server only (button on a self pickup row, item card, recipient fields, pad, Send), nothing was sent. The screenshot capture of the pane timed out twice; the structure was read through the accessibility tree.

Verification: `npx tsc --noEmit` (server, client) clean; `npm test` server 17 suites / 163 tests green (new spec 12/12); client `npm test` 79/79; `npm run build` client clean.

## Plan Change Log

## Review Triage Log

## Plan Change Log

- 2026-10-07, review: `delivered_by_user_id` is cleared by `assign()` and by the move to self pickup. The plan said nothing about it, so a handover that collected nothing followed by a courier delivery kept the manager on the issuance. Must survive: a courier delivery never carries a manager's id; the handover task stays in the task history.
- 2026-10-07, review: a `not_delivered` issuance moved to self pickup loses its undelivered-lines alert in the detail dialog, because `current_task` is null while waiting. Accepted: the courier side of the issuance ended and the alert belonged to that attempt; the attempt stays under `tasks`.

## Review Triage Log

Edge-case hunter (3 findings):
- fixed: `delivered_by_user_id` stale after a nothing-collected handover reassigned to a courier. `assign()` and the self pickup switch in `update()` clear it; e2e "a handover that collected nothing..." walks the sequence.
- fixed: the dialog left the form open on a 409. `SelfPickupReportDialog` calls `onChanged` on a 409 so the detail and the board show the state the issuance moved to.
- fixed (same root as the first): the claim "null for every courier delivery" now holds because `assign()` clears the record before any courier task exists.

Verification gap (5 findings + 1 note):
- fixed: the LEFT JOIN path (courier's done task, then a handover) had no test; e2e "after a courier left it not delivered..." asserts the column, `current_task` and the raw sort key.
- fixed: the waiting-null guard with a stored deliverer; the same sequence test asserts `delivered_by_name: null` and the null sort key on the second self pickup (the id is cleared now, the guard stays as belt and braces).
- refuted as a gap in this session: the client Send was exercised live on the second API (port 3002) and client (5174): the form posted `POST /issuances/232/self-pickup/report` 201, the issuance came back delivered / self pickup / `delivered_by_user_id` 1 / "דנה לוי", audit row `issuance.self_pickup_report` by `manager`, the board row shows the name under משנע and נמסר. The nothing-delivered payload branch is proven at the API by the e2e, not by a client spec: deferred, a vitest of the dialog in the FindNumberDialog style.
- deferred: rendering tests for the three courier fallbacks (repo convention: most React components outside automation).
- fixed by a manual check: the migration was run on the test database rewound to the previous schema (column dropped, NOT NULL restored, migration row deleted): `up` added `issuances.delivered_by_user_id integer NULL` and made `delivery_tasks.courier_id` nullable (information_schema read before and after).
- noted in the Plan Change Log: the undelivered-lines alert disappears while waiting.

Counts after triage: server 165 (78 unit, 87 e2e) in 17 suites, client 79; README updated.

