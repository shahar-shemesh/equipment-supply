---
title: 'Manager board phase 2A: actions, counts, sorting, side panel'
type: 'bugfix'
created: '2026-10-08'
status: 'approved'
base: '96eb6fb'
context: ['AGENTS.md', 'docs/manager-board-gap-analysis.md#B.5', 'server/src/issuances/issuance.rules.ts', 'client/src/manager/components/IssuancesTable.tsx']
---

## Intent

**Problem:** The manager board disagrees with its own server: the detail dialog treats `self_pickup` as closed although the transition table allows assign / edit / delete from it, `partially_delivered` rows can be selected for a bulk assign the server refuses with an English 409, the "משלוחים לפי עיר" counter counts `assigned` rows too, the three courier / city lists have no "לפי שם / לפי עומס" sort and the side panel cannot be hidden (gap analysis E1, E2, E3, E6, E7; spec 0.5 §4.1, §4.2).

**Approach:** Move the transition table to `shared/` so the client asks the same `canDo()` the server enforces, give the 409 of `assertCanDo` a structured body the client renders in Hebrew, count `unassigned` only in `summary()`, add one small sort toggle component used in the three lists, and a sidebar open / closed state on the board page.

## Boundaries & Constraints

**Always:** server stays the final authority (`assertCanDo` unchanged in meaning); all-or-nothing bulk assign stays; the six-status multi-select filters, their defaults and the page / selection behaviour stay untouched; every string through `t()`; `bp` mixins only; match file style (client double quotes, server single).

**Never:** add a transition, a status or a tab; touch the courier app, migrations, entities, the offline layer; change `mark-urgent`'s skip-closed-rows behaviour; change the `message` text of the 409 (e2e asserts on it); add a dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Detail of a `self_pickup` issuance | open dialog | "שינוי משנע" link, urgent switch, date field, handover report and delete all enabled; "העברה לאיסוף עצמי" hidden | - |
| Detail of `delivered` / `partially_delivered` / `deleted` | open dialog | switch and date disabled, no change courier / self pickup / delete button; one info line saying the status allows no change | - |
| Row menu of `partially_delivered` | kebab | every item disabled, a caption explains the status | - |
| Row menu of `self_pickup` | kebab | date, urgent, courier, delete enabled; self pickup disabled | - |
| Selection | page with `partially_delivered` rows | their checkbox disabled (not selectable), header "select all" skips them | - |
| 409 from assign / patch / delete | server body `{ code: 'status_not_allowed', sap_number, status, action }` | toast / inline alert in Hebrew: which issuance, its status, which action | `errorMessage()` falls back to `message` when `code` is absent |
| Summary | 3 unassigned + 2 assigned in one city | `by_city` count 3, rendered "3 לא שובצו" | city with 0 unassigned not listed (as today, GROUP BY only sees rows) |
| Sort toggle | "לפי עומס" + search "א" | the filtered rows, highest `pending` first, ties by name | - |
| Sort toggle | "לפי שם" (default) | Hebrew `localeCompare` order | - |
| Side panel | click "הסתרת פאנל" | aside gone, `.board` one column, button "הצגת פאנל צד" in the title row; filters / page / selection unchanged; choice kept in `localStorage` | storage unavailable: state still works for the session |

## Code Map

- `server/src/issuances/issuance.rules.ts` -- the table, `canDo`, `editableStatuses`, `assertCanDo` (nest only). Table moves out, file re-exports.
- `shared/@rules.ts` -- new: `IssuanceAction`, `allowedFrom`, `canDo`, `editableStatuses`, `actionKeys` (t keys per action).
- `server/src/issuances/issuances.service.ts:375-383` -- `summary()`, the `IN (unassigned, assigned)`.
- `client/src/utils/service.ts:48` -- `errorMessage`; gets the 409 code mapping (imports `i18next` default instance, already initialised in `main.tsx`).
- `client/src/manager/components/IssuancesTable.tsx:52-54,163-170` -- `canSelect`, the kebab menu.
- `client/src/manager/components/IssuanceDetailDialog.tsx:76` -- `closed`.
- `client/src/manager/components/SideWidgets.tsx`, `AssignCourierDialog.tsx` -- the three lists.
- `client/src/manager/components/SortToggle.tsx` -- new: `SortMode`, `SortToggle` (MUI `ToggleButtonGroup`), `sortByNameOrLoad()`.
- `client/src/manager/pages/IssuancesBoard.tsx` -- side panel state and the restore button.
- `client/src/styles/_manager.scss:3-13,644-668` -- `.board` columns, `.side-widgets`.
- `shared/i18n/he.ts` -- new keys.
- `docs/domain.md:24`, `docs/api.md:10`, `README.md:174` -- where the rules file and the 409 are documented.

## Tasks & Acceptance

**Execution:**
- [ ] `shared/@rules.ts` -- move `allowedFrom` + comment, `canDo`, `editableStatuses`, add `actionKeys` -- one table for both sides (E1 "avoid duplicating rules").
- [ ] `server/src/issuances/issuance.rules.ts` -- import from shared, re-export, `assertCanDo` throws `ConflictException({ statusCode: 409, message: <same text>, code: 'status_not_allowed', sap_number, status, action })` -- compatible: `message` text unchanged, fields added (same shape as `delivery.service.ts:17`).
- [ ] `server/src/issuances/issuances.service.ts` -- `summary()` counts `unassigned` only; comment updated -- E3.
- [ ] `server/src/e2e/pagination.e2e.spec.ts` -- one test: `by_city` equals SQL `COUNT(*) ... WHERE status = 'unassigned' AND deleted_at IS NULL GROUP BY address_city` -- pins E3.
- [ ] `server/src/issuances/issuance.rules.spec.ts` -- assert the 409 body carries `code`, `sap_number`, `status`, `action`.
- [ ] `shared/i18n/he.ts` -- `conflict_status_not_allowed`, `action_assign` … `action_self_pickup_report`, `row_actions_blocked`, `detail_status_locked`, `widget_unassigned_count`, `sort_by_name`, `sort_by_load`, `side_panel_hide`, `side_panel_show`.
- [ ] `client/src/utils/service.ts` -- `errorMessage`: when `data.code === 'status_not_allowed'` build the Hebrew sentence from `i18next.t` with the status label (`statusKeys`) and the action label (`actionKeys`) -- E2 (5).
- [ ] `client/src/manager/components/IssuancesTable.tsx` -- `canSelect = canDo('assign') && canDo('edit')` (the two bar actions); menu items `disabled={!canDo(action, row.status)}`; a disabled caption item when any is blocked -- E2 (1-4).
- [ ] `client/src/manager/components/IssuanceDetailDialog.tsx` -- replace `closed` by `can(action)`; info alert when `edit`, `assign`, `delete` are all refused -- E1.
- [ ] `client/src/manager/components/SortToggle.tsx` + `sortToggle.spec.ts` -- the toggle and the pure sort, tested (name order, load order, tie, empty) -- E6.
- [ ] `client/src/manager/components/SideWidgets.tsx` -- sort toggle under each search, "X לא שובצו" label, a "הסתרת פאנל" button at the top of the aside (`onHide` prop) -- E3, E6, E7.
- [ ] `client/src/manager/components/AssignCourierDialog.tsx` -- sort toggle under the search, reset to "לפי שם" on open -- E6.
- [ ] `client/src/manager/pages/IssuancesBoard.tsx` -- `sideOpen` state from `localStorage` (`es_board_side`), `.board--no-side` class, restore button next to "איתור הנפקה" -- E7.
- [ ] `client/src/styles/_manager.scss` -- `.board--no-side { grid-template-columns: 1fr }` under `bp.wide`, `.side-widgets__bar` for the hide button -- E7.
- [ ] `docs/domain.md`, `docs/api.md`, `README.md` (open decision 1 wording, test counts) -- documentation follows the code.

**Acceptance Criteria:**
- Given a `self_pickup` issuance, when its detail opens, then the courier link, urgent switch and date are usable and a PATCH succeeds.
- Given a `partially_delivered` row, when the page renders, then its checkbox is disabled and "select all" never includes it.
- Given a 409 with `code: status_not_allowed`, when the client shows it, then the toast is Hebrew and names the issuance number, its status label and the action.
- Given a city with assigned and unassigned rows, when `/issuances/summary` answers, then its count equals the unassigned rows only and the widget prints "N לא שובצו".
- Given "לפי עומס" selected and a search typed, when the list renders, then only matching rows show, busiest first.
- Given the panel hidden and the page changed, when the panel is restored, then page, sort, filters and selection are what they were.

## Verification

**Commands:**
- `cd server && npx tsc --noEmit -p tsconfig.json` -- expected: no errors.
- `cd server && npm run test:unit` -- expected: all green, rules spec includes the new body assertion.
- `cd server && npm test` (docker up) -- expected: all green including the new summary test; `hardening.e2e` still matches `'delivered, assign is not allowed'`.
- `cd client && npx tsc --noEmit` and `cd client && npm test` -- expected: green, new `sortToggle.spec.ts` counted.

**Manual checks (only when no CLI check applies):**
- Dev client on 5173: detail of a self pickup row; kebab on a partially delivered row; "לא שובצו" labels; the sort toggles with a search; hide / show panel at 1280, 1440, 1920 with no horizontal scroll; grid columns reflow when the panel goes.

## Design Notes

The data grid flexes its columns against the width it measured at mount (`_manager.scss:108-117`). After hiding the panel at 1440+ the main column grows by ~430px; check that the grid re-measures (it has a ResizeObserver on its root). If it does not, remount it with `key={sideOpen}` and accept the lost drag widths; note it under Implementation Notes.

## Implementation Notes

- 2026-10-08, implemented in the planning session itself (the files were already loaded; the two review subagents stay independent).
- The table moved to `shared/@rules.ts` with its comment; `issuance.rules.ts` re-exports and keeps `assertCanDo` with the structured body (same `message` text, so `hardening.e2e` is untouched).
- Selection eligibility is `canDo('assign') && canDo('edit')`: the bar has exactly those two actions. With today's table the two sets are identical, the `&&` is there so a future row change cannot silently widen one of them.
- The kebab disables instead of hiding and puts a disabled caption first (`row_actions_blocked`), so the manager sees the reason without a toast. The detail dialog shows an info alert (`detail_status_locked`) only when no action at all is allowed.
- `summary()` has no date filter today and still has none (the courier load next to it counts all dates too). The brief's "preserve existing date filtering" had nothing to preserve; whether the panel should follow the board date is an open question for the user.
- `errorMessage()` in `service.ts` words the 409 through the `i18next` default instance (`main.tsx` initialises it before any request).
- Side panel state is `useState` seeded from `localStorage` (`es_board_side`), with try/catch for a blocked storage.
- Dev servers for the manual pass run from two temporary `launch.json` entries on 3001 / 5174 against `equipment_supply_test` (the main checkout's servers hold 3000 / 5173); the entries are removed before the final report.

## Plan Change Log

- 2026-10-08: the Design Notes fallback is now the implementation. The grid did re-flex on a wider box after a window resize event, but never on a narrower one (headers stayed at 1359px inside a 929px root), so `IssuancesTable` gets `key={sideOpen ? ... : ...}` in `IssuancesBoard.tsx` and remounts on the toggle. Dragged column widths are lost on the toggle; page, sort, filters and selection are the board's state and were verified to survive.
- 2026-10-08: `AssignCourierDialog` gets an `onConflict` prop; the board reloads on a 409 from the dialog, the kebab and the detail dialog (see triage below).

## Review Triage Log

Pass 1, 2026-10-08, edge-case-hunter + verification-gap on `build-manager-board-phase-2a.diff`.

| # | Finding | Verdict | Evidence / action |
|---|---------|---------|-------------------|
| 1 | `load()` keeps a selected row whose new status is not selectable | fixed | `IssuancesBoard.tsx` filter now `r.id === id && canSelect(r)` |
| 2 | kebab 409 leaves a stale row and repeats the 409 | fixed | `failed()` in the board reloads on 409; same for `AssignCourierDialog` via `onConflict`; verified in the browser (deleted row vanished, selection cleared) |
| 3 | detail dialog 409 leaves stale controls | fixed | `failed()` in the dialog reloads the issuance and the board on 409 |
| 4 | caption says "some actions" when all are disabled | fixed | `row_actions_all_blocked`; verified on a partially delivered row |
| 5 | a city with zero unassigned rows disappears from the widget | deferred | same as before the change (GROUP BY on live rows); documented in `docs/api.md`. Listing zeros is a product choice |
| 6 | `canSelect` had no test | fixed | `describe("canSelect")` in `issuancesTable.spec.ts` over every status |
| 7 | `errorMessage` 409 branch had no test | fixed | `client/src/utils/service.spec.ts` (hebrew sentence, fallbacks) |
| 8 | kebab / dialog gating and the panel toggle rely on manual checks | deferred | the repo keeps React components out of automation (README); the pure parts are tested, the rest was verified in the browser at 1280 / 1440 / 1920 |
| 9 | SCSS comment claimed order, not specificity, decides | fixed | comment corrected |
| 10 | 409 names the bare `sap_number`, the table shows `displayNumber()` with the prefix | deferred | the 409 body carries no prefix; adding `number_prefix` to the body is a small server change for the user to decide |
