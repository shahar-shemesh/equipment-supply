---
title: 'Remove one item from an issuance'
type: 'feature'
created: '2026-10-13'
status: 'approved'
base: '453a3f2'
context:
  - AGENTS.md
  - server/src/issuances/issuances.service.ts
  - server/src/e2e/audit.e2e.spec.ts
  - client/src/manager/components/IssuanceDetailDialog.tsx
---

## Intent

**Problem:** An issuance holds several SAP lines but the manager can only act on the whole document. A line the customer no longer wants cannot be taken off without deleting the issuance.

**Approach:** A new manager action `remove_item` in the transition table, `DELETE /api/issuances/:id/items/:itemId` that soft deletes the line under the issuance lock and bumps `revision`, and a delete icon per line in the detail dialog with its own confirm step. The rest of the issuance, its tasks, attempts, signatures and audit rows are not touched.

## Boundaries & Constraints

**Always:**
- One transaction: `lockIssuance` first, then the item. `em.update`, never `save` (AGENTS pitfalls).
- Soft delete: `issuance_items.removed_at` as a TypeORM `@DeleteDateColumn`. `delivery_attempt_items.item_id` points at the line with no foreign key, so past attempts keep their reference. TypeORM then drops removed lines from every `relations` and `leftJoinAndSelect` load (verified in `SelectQueryBuilder.createJoinExpression`), so the board, the detail, the courier board, `myTask` and both report validators see live lines only with no code change.
- `remove_item` is allowed from the `edit` row: `unassigned`, `assigned`, `not_delivered`, `self_pickup`. Everything else is the usual 409 `status_not_allowed`.
- Removing the last line is refused with 409 `{ code: 'last_item', sap_number }`: `validateItemAnswers` rejects an issuance with no lines, so an empty issuance could never be delivered. The manager deletes the issuance instead. Nothing is deleted automatically.
- The removal bumps `revision` and leaves the open task alone. A courier's stale offline report must reach the existing 409 `revision_changed` under the lock, and a replay of an already applied report must still be answered from the stored operation. See Design Notes.
- Audit row `issuance.remove_item` on the same transaction, details `item_id`, `line_no`, `product_name`, `items_left`, `revision`.
- Every string through `t()`; the new 409 worded in Hebrew by `errorMessage` like `status_not_allowed`.

**Never:**
- No hard delete, no cascade to tasks or attempts, no status change, no task cancellation.
- No new dependency. No DTO classes. No change to the offline conflict rules themselves, only the path a stale report takes to reach them.
- No item editing, adding or restoring. No removal from the board rows, only the detail dialog.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Remove one of two | `assigned`, items A,B, pending task | 200 with the issuance as `GET /issuances/:id` returns it: items `[A]` unchanged, `revision + 1`, status and task untouched, one audit row | none |
| Repeat the same call | B already removed | 404 `item <id> not found in issuance <id>` | no audit row |
| Unknown or foreign item | item id of another issuance, or `abc` | 404 for a foreign id, 400 for a non integer | nothing written |
| Unknown issuance | id 999999 | 404 `issuance 999999 not found` | nothing written |
| Last line | one live item | 409 `code: 'last_item'`, item stays | Hebrew `item_remove_last` in the dialog |
| Closed status | `delivered`, `partially_delivered`, `deleted` | 409 `status_not_allowed`, `action: 'remove_item'` | dialog shows no icons, 409 wording if raced |
| Courier token | role courier | 403 | none |
| Stale offline report | B removed, tablet sends answers A,B with the old revision | 409 `revision_changed`, nothing written | tablet keeps it as a conflict as today |
| Replay after removal | report applied, B removed from `not_delivered`, same operation retried | stored result with `replayed: true` | none |
| Fresh report | tablet refreshed, answers `[A]` with the new revision | 201 as before | none |

## Code Map

- `shared/@rules.ts` -- `IssuanceAction`, `allowedFrom`, `actionKeys`: the new row.
- `shared/@core.ts` -- `AuditAction.issuance_remove_item`, `IIssuanceItem.removed_at?`.
- `shared/i18n/he.ts` -- `action_remove_item`, `item_remove`, `item_remove_last`, `item_remove_confirm_title`, `item_remove_confirm_text`, `item_remove_confirm_button`, `item_removed`.
- `server/src/entities/issuance-item.entity.ts` -- `removed_at` column.
- `server/src/migrations/1791200000000-RemoveIssuanceItem.ts` -- guarded `ADD COLUMN IF NOT EXISTS`, same shape as `1791100000000-SelfPickupHandover.ts`.
- `server/src/issuances/issuances.service.ts` -- `removeItem(id, itemId, user)` next to `softDelete`, returns `this.findOne(id)` like `update`.
- `server/src/issuances/issuances.controller.ts` -- `@Delete(':id/items/:itemId')`.
- `server/src/delivery/delivery.service.ts` -- `report()`: the stale report path (Design Notes).
- `client/src/utils/service.ts` -- `errorMessage`: `last_item`.
- `client/src/manager/components/IssuanceDetailDialog.tsx` -- the icon, the confirm dialog, the feedback.
- `client/src/styles/_manager.scss` -- `&__items .item-lines` gets the action placement.
- `docs/api.md`, `docs/domain.md`, `docs/offline-sync.md`, `README.md` -- route, table column, audit row, bump source, status line, open decision, test counts.

## Tasks & Acceptance

**Execution:**
- [ ] `shared/@rules.ts`, `shared/@core.ts`, `shared/i18n/he.ts` -- add the action, the audit action, the item field and the keys -- contract first, both sides import it.
- [ ] `server/src/entities/issuance-item.entity.ts` + migration -- `@DeleteDateColumn({ type: 'timestamptz', nullable: true }) removed_at`, comment says why soft (attempt lines keep the id, no FK) -- LOCAL synchronizes, production needs the migration.
- [ ] `server/src/issuances/issuances.service.ts` -- `removeItem`: `Number.isInteger(itemId) && itemId > 0` else 400; transaction: `lockIssuance` → 404 → `assertCanDo('remove_item')` → `em.findOne(IssuanceItem, { where: { id: itemId, issuance_id: id } })` → 404 → `em.count(IssuanceItem, { where: { issuance_id: id } })` → 1 means 409 `last_item` → `em.update(IssuanceItem, itemId, { removed_at: new Date() })` → `em.update(Issuance, id, { revision: issuance.revision + 1 })` → `audit.record` → logger line. After the transaction `return this.findOne(id)`.
- [ ] `server/src/issuances/issuances.controller.ts` -- the route, `+itemId`.
- [ ] `server/src/delivery/delivery.service.ts` -- when `issuanceRevision != null && issuanceRevision !== task.issuance.revision`, validate the answers against live plus removed lines (`withDeleted: true`, `removed_at: Not(IsNull())`) so the request reaches the lock; replace the "cannot happen through a real flow today" comment.
- [ ] `client/src/utils/service.ts` -- `last_item` → `t("item_remove_last", { number })`.
- [ ] `client/src/manager/components/IssuanceDetailDialog.tsx` -- per line an `IconButton` (`DeleteOutlineIcon`, `aria-label`) shown when `can("remove_item")`, disabled with a `Tooltip` on a `span` when it is the only line; state `removeTarget: IIssuanceItem | null` and `removing`; nested `Dialog` with `confirm-dialog` like the delete confirm, confirm button disabled with a 16px `CircularProgress` while in flight (MUI 5.16, no `loading` prop); on success `setIssuance(result)`, an inline `Alert severity="success"` with `item_removed`, `onChanged()`; on failure `failed(e)` and also reload on 404 (the line went meanwhile). The red alert of undelivered lines skips a line that is no longer on the issuance.
- [ ] `client/src/styles/_manager.scss` -- the icon sits at the trailing edge of the line (`inset-inline-end`, no raw `@media`), qualify any MUI rule.
- [ ] `server/src/issuances/issuance.rules.spec.ts` -- `remove_item` per status.
- [ ] `server/src/e2e/remove-item.e2e.spec.ts` -- own `fixture()` like `audit.e2e.spec.ts`; every matrix row above, plus: the remaining line is byte-for-byte the same (`id`, `line_no`, fields), the task is still `pending` with the same courier, `GET /delivery/tasks/:id` as the courier no longer lists the line, the audit row and that a refused call writes none.
- [ ] `client/src/utils/service.spec.ts` -- the Hebrew wording of `last_item`.
- [ ] Docs: `docs/api.md` row; `docs/domain.md` table column `remove item`, audit row, item line mentions `removed_at`; `docs/offline-sync.md` "What invalidates a report": item removal bumps and leaves the task alone, the stale report now reaches the check; `README.md` Status line, `## Open decisions` item 14 (allowed statuses follow the edit row and the last line is refused: both assumptions), test counts.

**Acceptance Criteria:**
- Given an `assigned` issuance with two lines and a pending task, when the manager removes one, then the response lists the other line unchanged, `revision` moved by one, the task is still pending with its courier, and `GET /api/audit?issuance_id=` has one `issuance.remove_item` row.
- Given a line already removed, when the same DELETE is sent again, then 404 and the audit log has no second row.
- Given an issuance with one live line, when its removal is requested, then 409 `last_item` and the line is still returned by the detail.
- Given a `delivered` issuance, when a line removal is requested, then 409 `status_not_allowed` with `action: 'remove_item'`.
- Given a tablet report written against the old line set and revision, when it reaches the attempts route after the removal, then 409 `revision_changed` and no attempt row; the same operation retried after it was applied earlier is still replayed.
- Given the detail dialog on a `delivered` issuance, when it renders, then no remove icon is shown; on an `assigned` one with two lines both icons are enabled and the confirm step names the product.

## Verification

**Commands:**
- `cd server && npx tsc --noEmit -p tsconfig.json` -- expected: no output.
- `cd server && npm run test:unit 2>&1 | tail -40` -- expected: all suites pass, the rules spec counts one more test.
- `cd server && docker compose up -d && npm test 2>&1 | tail -40` -- expected: all suites pass including `remove-item.e2e.spec.ts`; `offline-sync` and `conflicts` still pass their `revision_changed` cases.
- `cd client && npx tsc --noEmit && npm test 2>&1 | tail -40` -- expected: pass, `service.spec.ts` one more test.

**Manual checks:**
- Dev server, open a two line issuance from the board: trailing delete icon on each line, confirm dialog names the product, the line disappears without a reload, the success alert shows, the board row's item count follows. Check at 390px too: the icon stays inside the card.

## Design Notes

Why the stale report path changes in `delivery.service.report`: validation runs before the transaction, so a report answering a removed line would die with a 400 `unknown item` and the tablet would file it as `invalid` instead of the designed 409 `revision_changed` with evidence. A revision check before the transaction is wrong too: a legitimate replay carries the revision from before the report that bumped it, and must be answered from the stored operation first. So the check stays where it is and the validator is simply handed the removed lines as well when the submitted revision is behind, which lets the request reach the replay lookup and then the revision check. A report without a revision (legacy, no operation id) keeps validating against live lines only.

## Implementation Notes

2026-10-13, implemented as planned. Every task box above is done.

**Decisions**

- `remove_item` is its own row in `allowedFrom` with the same four statuses as `edit`, not an alias of it: a `Record` literal cannot refer to itself, and the rules spec asserts `allowedFrom.remove_item` equals `allowedFrom.edit` so the two cannot drift.
- `removeItem` sets `removed_at` with `em.update`, as the plan says. Checked `UpdateQueryBuilder` in `server/node_modules/typeorm`: it has no special handling for the delete date column, so a plain update sets it; `SelectQueryBuilder.createJoinExpression` (line 986) adds `removed_at IS NULL` to every relation join, and `find` / `count` on the item entity get the same filter from `applyFindOptions`. That is why the repeat call and the foreign id both fall out of the same `findOne` as 404 with no extra code.
- The last line check is `em.count` of the live lines after the 404, so the count never includes the line about to go. 409 body: `{ statusCode, message, code: 'last_item', sap_number }`, worded in the client by `errorMessage` from `sap_number` alone (no `displayNumber` prefix: the server has none).
- `delivery.service.report`: the removed lines are fetched through `this.tasks.manager.find(IssuanceItem, { ..., withDeleted: true })` so no repository injection and no module change were needed. The legacy request (no revision) and a request at the current revision validate against the live lines only; the e2e spec covers both sides (a two line answer at the current revision is still a 400).
- Client: the icon is wrapped in a `span` so the tooltip works on the disabled button; the tooltip reads `item_remove` when enabled and `item_remove_last` (with the number) when it is the only line. The success `Alert` sits right above the items section, not at the top, since that is where the manager is looking. The confirm dialog cannot be dismissed while the request is in flight. A 404 reloads the dialog and the board like a 409 does.
- SCSS: `.item-lines` is `position: relative`, the icon is an absolutely placed `.item-lines__remove` at `inset-inline-end: 0`, and a modifier `.item-lines--removable` adds `padding-inline-end: 44px` only when `can("remove_item")`, so closed issuances keep the old layout to the pixel. No MUI rule was needed, so nothing to qualify.
- Migration `1791200000000-RemoveIssuanceItem.ts` spells the column `timestamptz NULL` like `OfflineSync` did; the revert drops it, which turns every removed line live again (documented in `docs/domain.md`).

**Files touched**

`shared/@rules.ts`, `shared/@core.ts`, `shared/i18n/he.ts`, `server/src/entities/issuance-item.entity.ts`, `server/src/migrations/1791200000000-RemoveIssuanceItem.ts` (new), `server/src/issuances/issuances.service.ts`, `server/src/issuances/issuances.controller.ts`, `server/src/delivery/delivery.service.ts`, `server/src/issuances/issuance.rules.spec.ts`, `server/src/e2e/remove-item.e2e.spec.ts` (new, 6 tests), `client/src/utils/service.ts`, `client/src/utils/service.spec.ts`, `client/src/manager/components/IssuanceDetailDialog.tsx`, `client/src/styles/_manager.scss`, `docs/api.md`, `docs/domain.md`, `docs/offline-sync.md`, `README.md`. Nothing outside the Code Map.

**Verification**

- `server`: `tsc --noEmit` clean; `npm run test:unit` 80 tests in 10 suites; `npm test` 174 tests in 18 suites (80 unit, 94 e2e), `offline-sync` and `conflicts` still pass their `revision_changed` cases, `remove-item.e2e.spec.ts` green on the first run.
- `client`: `tsc --noEmit` clean; `npm test` 95 tests in 11 files. README counts updated to 269 (174 server, 95 client), six migrations.
- Manual, in the browser pane against a dev pair started on 3001 / 5174 (`PORT`, `API_PROXY_TARGET`; ports 3000 / 5173 were held by another session's older build that answered 404 on the new route): issuance 2000592 (id 76, unassigned, four lines) opened from the board, a trash icon on every line, the confirm names the product ("תחנת עגינה"), the line left the list without a reload, the green alert "הפריט "תחנת עגינה" הוסר מההנפקה" appeared, three icons left. DB after: `revision` 1 to 2, line 1 `removed_at` set, status unchanged, one `issuance.remove_item` audit row with the planned details, the logger line in the server output. At 390px: three icons, each 44px at the trailing edge inside the card (16..374 of 390), no overlap with the values, `scrollWidth` equals `innerWidth`.

**Surprises**

- The board has no item count column or card count in this build, so "the board row's item count follows" had nothing to observe; the detail and the API agree, which is what the count would have mirrored.
- The manual check removed line 1 of seeded issuance 2000592 in the local `equipment_supply` database (soft, `removed_at` set), and the 3001 server's `synchronize` added the `removed_at` column there. A re-seed brings the line back.
- The comment on `Issuance.revision` in `server/src/entities/issuance.entity.ts` still says every bump also cancels or closes the task and names SAP changes as the future bump source that leaves the task alone. That file is outside the Code Map so it was left as is; it should say that a line removal is that source now. One line, for the next touch of that file.

## Review Triage Log

2026-10-13, one pass, two reviewers (edge-case-hunter with the plan as claims file, verification-gap) on the working tree diff.

**Fixed**

- Stale report after two removals (both reviewers): `known` was the live lines plus every removed line, and the validator wants one answer per known line, so a snapshot taken between two removals, or a replay after a later removal, died as a 400 before the lock. `delivery.service.linesAsSigned` now adds only the removed lines the report names; every live line is in any snapshot since lines are only ever taken off, an id that never belonged and a duplicate still fail. Two e2e cases added (409 `revision_changed` for the stale snapshot, replay after two removals).
- Legacy report (no revision) racing a removal between validation and lock (edge-case-hunter): an attempt row on a gone line. Under the lock the revision is now held to the one validated against (`issuanceRevision ?? task.issuance.revision`), so it is a `revision_changed` like the tablet's.
- Handover (`reportSelfPickup`) racing a removal the same way (edge-case-hunter): under the lock `locked.revision !== issuance.revision` is a 409 `revision_changed` with `sap_number`; `errorMessage` words it (`handover_revision_changed`, the `conflict_revision_changed` key is the courier's) and the dialog reloads. One client test added.
- Path ids past int4, or a non numeric issuance id (edge-case-hunter): were a database error (500). Both ids go through `isId` (positive, at most 2147483647) for a 400; three e2e assertions added.
- Stale success alert next to a later error in the dialog (edge-case-hunter): `setRemoved("")` in the catch.
- Courier task list never asserted after a removal (verification-gap): the hand written join of `GET /delivery/tasks` now asserted next to the single task route.
- Conflict review shows a removed line as `#id` (verification-gap, other findings): `conflicts.service.findOne` loads the issuance lines `withDeleted`, so the review names the line in dispute; `docs/api.md` says it is the one response that lists removed lines.
- Stale comment on `Issuance.revision` (verification-gap noted the diff was behind): updated before the review returned.

**Deferred**

- The migration is executed by no test; the five earlier ones are in the same position by documented practice (`docs/domain.md`), and the statement matches the entity on reading.
- The dialog's alert filter and its 404 reload are not automated; the repo verifies components by hand. Manual check to add to the list: a `not_delivered` issuance whose undelivered line was removed shows no alert for it; a second manager's removal racing into a 404 reloads the lines.

**Refuted**

- Dialog closed and reopened on another issuance while the DELETE is in flight (edge-case-hunter): the confirm dialog cannot be dismissed while `removing` and covers the outer dialog's close control and the board, and MUI hands Escape to the top modal only, so the issuance id cannot change mid request. The same shape exists for the PATCH calls already.
