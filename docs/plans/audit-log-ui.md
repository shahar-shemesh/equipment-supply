---
title: 'Audit log screen for the warehouse manager (יומן פעילות)'
type: 'feature'
created: '2026-10-28'
status: 'approved'
base: '4aeac79'
context: ['AGENTS.md', 'server/src/audit/audit.service.ts', 'server/src/audit/audit.validation.ts', 'client/src/manager/components/IssuancesTable.tsx', 'client/src/manager/components/BoardFilters.tsx', 'client/src/manager/components/ConflictDetailDialog.tsx']
---

## Intent

**Problem:** `audit_log` records every state change and `GET /api/audit` reads it, but a manager has no screen: who assigned, who edited, what a delivery report said is only reachable with a database client. The rows carry ids only (no names, no SAP number), the endpoint has no text search, no multi action filter and no sort direction.

**Approach:** A read only manager page `/manager/audit` ("יומן פעילות") on the same data grid, filter toolbar and dialog patterns as the board, over the existing endpoint extended in place: `q`, a comma list for `action`, `order`, and three display fields resolved per page (`actor_name`, `issuance_number`, `courier_name`). One formatting module turns actions, fields and details into Hebrew; a drawer shows one event with its `changes` as a before / after table.

## Boundaries & Constraints

**Always:**
- The audit table and `AuditService.record*` stay untouched: no new column, no migration, nothing written by the screen.
- Every filter, the page and the order are the server's. The client holds one page (`size` 25) and sends new parameters on every change; a filter change goes back to page 1; only the newest response is applied (a sequence ref in the page), older ones are dropped.
- `@Roles(UserRole.manager)` stays on `AuditController`; the client route sits under the existing `/manager` `RequireRole`.
- Query validation stays by hand in `audit.validation.ts`: a value that is not what the parameter means is a 400, never a silent default. `action=a,b` is a list, a repeated parameter (`action=a&action=b`, an array) stays a 400.
- Every UI string through `t()` with the key in `shared/i18n/he.ts`; the enum to key maps live in one module, `client/src/utils/auditFormat.ts`.
- `details` is rendered, never mutated. Unknown actions, fields and detail keys print a readable fallback (the raw identifier), never an empty cell, never `[object Object]`.
- The grid chunk stays out of the courier precache: `AuditPage` is lazy like the board and `**/AuditPage-*.js` joins `globIgnores` in `client/vite.config.ts`.

**Never:**
- No new endpoint, no users list endpoint, no export, no issuance detail dialog on this page (the drawer offers "every event of this issuance" instead, through the existing `issuance_id` filter).
- No sort on columns other than the timestamp (`order` is the only sort the server has); no client side sorting or paging.
- No raw JSON as the primary view: the technical fallback is a collapsed "פרטים טכניים" block at the end of the drawer.
- No new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Default page | GET /api/audit | newest first (`at` desc, `id` desc), 50 rows, each with `actor_name`, `issuance_number`, `courier_name` | none |
| Oldest first | `order=asc` | `at` asc, `id` asc | `order=sideways` 400 |
| Two actions | `action=issuance.assign,issuance.edit` | rows of either | one unknown member 400; `action` as array 400 |
| Text search | `q=דנה` / `q=manager` / `q=7000001` | rows whose `actor_username`, the user's `display_name` / `username`, or the issuance `sap_number` contain it (ILIKE) | `q` over 100 chars 400; blank `q` = no filter |
| Deleted account / system row | `actor_user_id` without a users row, or null | `actor_name` null; the client prints `actor_username`, or "מערכת" for `actor_type` system | none |
| Courier row | `entity_type` courier | `courier_name` from `couriers` by `entity_id` (inactive rows included); an assign row gets it from `details.courier_id` | missing courier -> null, the client prints `#id` |
| Edit row in the drawer | `details.changes = { priority: {from, to}, delivery_date: {...} }` | a table שדה / ערך קודם / ערך חדש with Hebrew field names, dates DD/MM/YYYY, priority and status labels, null as "ריק", arrays joined | a non scalar `from`/`to` prints as text, never crashes |
| Row without changes | `issuance.assign`, `delivery.report`... | a one line Hebrew summary built from `details`, plus the known detail keys as label / value rows | unknown keys print the key |
| Date range | from 29/10/2026, to 28/10/2026 | the toolbar marks both fields invalid and sends nothing until fixed | the server's 400 is not reached |
| Fast filter changes | two requests in flight, the first answers last | the grid shows the second response | the stale one is ignored |
| Request failure | network error / 500 | an error Alert with the message and a "נסה שוב" button, the previous rows stay | none |
| Courier calls the API | courier token | 403 (unchanged) | guard |

## Code Map

- `server/src/audit/audit.validation.ts` -- `parseAuditQuery`: add `q`, `order`, the comma list for `action`; export `Q_MAX`.
- `server/src/audit/audit.service.ts` -- `list()`: the new where clauses, the order, then three `IN (...)` lookups (users, issuances, couriers) for the page's ids; `toEntry` gets the names.
- `shared/@core.ts` -- `IAuditEntry` gains `actor_name`, `issuance_number`, `courier_name` (all `string | null`); the query comment above `IAuditPage` lists the new parameters.
- `server/src/e2e/audit.e2e.spec.ts` -- the shape assertion gains the three keys; new cases for `q`, `order`, the action list and their 400s.
- `client/src/utils/auditFormat.ts` -- `actionLabel`, `entityTypeLabel`, `actorLabel`, `entityRef`, `summary`, `changeRows`, `detailRows`, `formatValue`; the only place that knows the detail keys.
- `client/src/manager/pages/AuditPage.tsx` -- title, subtitle, state (filters, page, order), the request with the sequence ref, error Alert with retry, the drawer.
- `client/src/manager/components/AuditFilters.tsx` -- search (400 ms debounce), action multi select (the city field pattern: Autocomplete, checkboxes, chips), two `DateField`s with range validation, the actor / issuance chips, "ניקוי סינון"; exports `emptyAuditFilters`, `toAuditQuery`.
- `client/src/manager/components/AuditTable.tsx` -- `DataGridPremium` in server mode with `className="issuances-grid audit-grid"` (the board's skin), memoised models, only `at` sortable; under 900px a list of cards with the `board__range` bar.
- `client/src/manager/components/AuditDetailsDrawer.tsx` -- MUI `Drawer` on the end side (anchor "right" lands on the visual left under the rtl cache, see the comment in ManagerLayout), full width on a phone; general kv rows, the changes table, the detail rows, the technical block, the two filter buttons.
- `client/src/routers/AppRouter.tsx`, `client/src/manager/ManagerLayout.tsx` -- the lazy route and the nav link (desktop header and drawer) with `HistoryIcon`.
- `client/src/styles/_manager.scss` -- `.audit-page`, `.audit-cards`, `.audit-drawer`, `.audit-changes` blocks at the end.
- `shared/i18n/he.ts` -- `nav_audit`, `audit_*` keys in one new section.
- `client/vite.config.ts`, `docs/api.md`, `README.md` (`## Status`, the client tree line, `## Tests` counts).

## Tasks & Acceptance

**Execution:**
- [ ] `server/src/audit/audit.validation.ts` + `audit.validation.spec.ts` -- `q` (string, trimmed, 1..100), `order` (`asc`|`desc`, default `desc`), `action` as a comma list -- the contract the UI sends
- [ ] `server/src/audit/audit.service.ts` -- where clauses for `q` and the list, `orderBy` by `order`, the three lookups, the enriched entry -- names instead of ids on screen
- [ ] `shared/@core.ts` -- the three fields on `IAuditEntry` -- both sides compile against one contract
- [ ] `server/src/e2e/audit.e2e.spec.ts` -- the matrix rows above -- the filters against the real database
- [ ] `shared/i18n/he.ts` -- `nav_audit`, labels for every `AuditAction`, `AuditEntityType`, change field and detail key, the page texts -- Hebrew first
- [ ] `client/src/utils/auditFormat.ts` + `auditFormat.spec.ts` -- the formatting module and its matrix tests (unknown action, nested object, null, arrays, dates) -- one place for the mapping
- [ ] `client/src/manager/components/AuditFilters.tsx` + `auditFilters.spec.ts` -- the toolbar; tests for `toAuditQuery`, the range check, reset -- the query stays predictable
- [ ] `client/src/manager/components/AuditTable.tsx` -- the grid and the compact cards -- the board's look
- [ ] `client/src/manager/components/AuditDetailsDrawer.tsx` -- the drawer -- one event readable
- [ ] `client/src/manager/pages/AuditPage.tsx` + `auditPage.spec.ts` -- the page; tests with a mocked service and a stub grid: query params per page / sort / filter, loading, empty, error with retry, the stale response, the drawer opening on a row -- the behaviour the manager sees
- [ ] `client/src/routers/AppRouter.tsx`, `client/src/manager/ManagerLayout.tsx`, `guards.spec.ts`, `ManagerLayout.spec.ts`, `client/vite.config.ts` -- route, nav, precache -- reachable and protected
- [ ] `client/src/styles/_manager.scss` -- the four blocks -- responsive through the `bp` mixins only
- [ ] `docs/api.md`, `README.md` -- the row of `GET /audit`, the status line, the client tree, the test counts -- docs match the code

**Acceptance Criteria:**
- Given a manager session, when "יומן פעילות" is clicked in the header or the phone drawer, then `/manager/audit` opens with the newest events first and the nav item highlighted.
- Given a courier session, when `/manager/audit` is typed, then the courier lands on `/courier`; when `GET /api/audit` is called with the courier token, then 403.
- Given 60 rows, when the second page is opened, then the request carries `page=2&size=25` and the footer reads "26-50 מתוך 60 אירועים".
- Given the timestamp header is clicked, when the grid asks for asc, then the request carries `order=asc`; a filter change afterwards sends `page=1`.
- Given an `issuance.edit` row, when it is opened, then the drawer shows "עדיפות: רגילה -> דחוף" as a table row, and no raw JSON unless "פרטים טכניים" is expanded.
- Given a row whose action is not in the client's map, when it renders, then the cell prints the raw action and nothing throws.

## Verification

**Commands:**
- `cd server && npm run test:unit` -- expected: all pass, the validation spec with its new cases
- `cd server && npm test` (after `docker compose up -d`) -- expected: all pass, `audit.e2e.spec.ts` included
- `cd server && npx tsc --noEmit -p .` -- expected: clean
- `cd client && npx tsc --noEmit -p .` -- expected: clean
- `cd client && npx vitest run` -- expected: the new specs pass; `store.spec.ts > readTask` is a pre-existing failure (handoff of 2026-10-28), not this plan's

**Manual checks (only when no CLI check applies):**
- Browser pane at 1280 and 375: the page, a filter round trip in the network log, the drawer side and width, the phone cards.

## Design Notes

- `q` on the server: `(a.actor_username ILIKE :like OR a.actor_user_id IN (SELECT u.id FROM users u WHERE u.display_name ILIKE :like OR u.username ILIKE :like) OR a.issuance_id IN (SELECT i.id FROM issuances i WHERE i.sap_number ILIKE :like))`. The OR forces a scan of the rows the other filters leave; `users` and `couriers` are tiny, `issuances` is indexed on `sap_number`. Acceptable at this table's growth, noted in `docs/api.md`.
- The lookups after `getManyAndCount`: `ds.getRepository(User).find({ where: { id: In(ids) } })` style, one per table, skipped when the id set is empty. No join in the main query, so offset / limit stays safe (AGENTS.md pitfall).
- The grid models (`sortModel`, `paginationModel`, `columns`) are `useMemo` with stable references, as `IssuancesTable.tsx` explains; `onOpen` goes through a ref.
- Filter state: `{ q, actions: AuditAction[], from, to, actor: { id, label } | null, issuance: { id, label } | null }`; `toAuditQuery` maps it to `q`, `action` (comma list), `from`, `to`, `actor_user_id`, `issuance_id`. The chips are set only from the drawer, so their labels come from the row that was open.
- Summaries live in `he.ts` with interpolation (`audit_summary_assign: "שויכה למשנע {{courier}}"`); `auditFormat.summary(entry, t)` picks the key by action and fills it from `details`, falling back to the action label when a value is missing.

## Implementation Notes

2026-10-28, implemented in the worktree `warehouse-audit-log-ui-dead61` on top of `4aeac79`. Nothing committed.

Decisions taken while implementing:

- `parseAuditQuery` returns `actions: AuditAction[] | null` (the field was `action`); the unit spec's `toEqual` of the empty query moved with it. Members are trimmed and deduplicated, an empty member (`a,`) is a 400 like an unknown one.
- `q` is not escaped for `ILIKE` wildcards, like the board's search in `issuances.service.ts`; a `%` typed by a manager matches wider, nothing breaks.
- The lookups use `this.rows.manager.getRepository(...)` so `AuditModule` keeps its single `forFeature([AuditLog])`; `select` narrows each read to id and the one column. `issuance_number` is the bare `sap_number` (no `number_prefix`: it is stored uninterpreted, open question in the entity).
- The table's columns are מועד / משתמש / פעולה / הנפקה / פרטים plus an open link; the row click opens the drawer too, as on the conflicts page. `entityRef` (type + name) is printed in the drawer, the issuance column prints the number alone.
- The toolbar reuses the board's classes (`board-filters`, `board-filters__search`, `board-filters__row`, `board-filters__date`, `board-filters__clear`) and the city option class for the action list; its own extras are nested under `.audit-page`. The clear button reuses `filter_clear` ("נקה סינון") rather than a new "ניקוי סינון" key. (Superseded: the Plan Change Log below moved it to `audit_filter_clear`.)
- An invalid range is marked by a class on the two `DateField`s (`is-invalid`, the picker's outline in the danger color) and a `.field-error` line under the row; `DateField` itself was not changed (no `error` prop). The page skips the request while `rangeInvalid` is true, the filter state still updates so the chips and the clear button keep working.
- The drawer's "פרטים טכניים" is a native `<details>` with the row as json, `direction: ltr`.
- Summaries carry no quotation marks around interpolated values (`escapeValue` is false, plain text either way).
- Rollup would have put the grid and the pickers, now shared by two lazy pages, into chunks of its own naming, and the precache glob would have taken them: `manualChunks` pins them to `mui-x-grid` and `mui-x-pickers` and `globIgnores` gets `**/mui-x-*.js` next to `**/AuditPage-*.js`. `@mui/x-license` stays out of the rule because `main.tsx` imports it. Checked on `npm run build`: the two chunks exist (756 kB and 546 kB), `dist/sw.js` precaches 17 entries / 542 KiB and names no `mui-x` chunk.
- The nav link carries `HistoryIcon`, which needed `display: inline-flex; gap` on the header links and a `gap` on the drawer links in `_layout-manager.scss` (a file outside the code map, two lines).
- `AuditOrder` lives in `AuditTable.tsx` on the client and in `audit.validation.ts` on the server; the plan put no new type in `shared/@core.ts` and the two literals are the query parameter's own words.

Files touched: `shared/@core.ts`, `shared/i18n/he.ts`; `server/src/audit/audit.validation.ts`, `audit.validation.spec.ts`, `audit.service.ts`, `server/src/e2e/audit.e2e.spec.ts`; `client/src/utils/auditFormat.ts` (+ spec), `client/src/manager/components/AuditFilters.tsx` (+ spec), `AuditTable.tsx`, `AuditDetailsDrawer.tsx`, `client/src/manager/pages/AuditPage.tsx` (+ spec), `client/src/routers/AppRouter.tsx`, `guards.spec.ts`, `client/src/manager/ManagerLayout.tsx`, `ManagerLayout.spec.ts`, `client/src/styles/_manager.scss`, `_layout-manager.scss`, `client/vite.config.ts`; `docs/api.md`, `README.md`.

Surprises: the live rows of the SAP import list issuance columns in `changed` (`customer_name`, `address_city`, `items[1].product_name`...) that printed raw; the customer and address columns got field labels, the `items[n].x` entries stay raw by design. The one pre-existing client failure (`store.spec.ts > readTask`) is still there and is not this plan's.

## Plan Change Log

2026-10-28, after the implementer returned (main session), against the task text rather than a reviewer finding:

- The table prints the spec columns: תאריך ושעה / משתמש / פעולה / סוג ישות / מזהה ישות / פרטים plus the open link. The implementer had merged type and reference into one "הנפקה" column, which left a courier row with no name on the table (its summary says "עודכנו: טלפון" only). `entityRef` (type + name in one string, drawer only) became `entityIdLabel` (the reference alone, in the table, the cards and the drawer; the issuance number on a delivery or a rejected report too), with `entityTypeLabel` next to it. The drawer's separate "הנפקה" line went with it, the issuance number is the reference of those rows now.
- Wording from the task text: the subtitle "מעקב אחר פעולות ושינויים שבוצעו במערכת", the placeholder "חיפוש ביומן הפעילות - שם משתמש או מספר הנפקה", the clear button "ניקוי סינון" (`audit_filter_clear`, the board keeps its "נקה סינון"), "עדכון פרטי הנפקה" and "דיווח מסירה" for the two action labels.
- The search debounce reads the filters through a ref when the pause ends: a pick made during the 400 ms was overwritten by the copy the effect closed over (the board has the same race; left there, out of scope).
- The date range test of `auditPage.spec.ts` gets a 15 s timeout: 1.5 s alone, past 5 s while the server suite ran next to it (it failed that way on the main session's first full run).

- The import's `changed` entries for a line (`items[N].inserted|removed|restored|<column>`, transform.ts of the ETL) print as "שורה N נוספה / הוסרה / הוחזרה" and "שורה N: מוצר" instead of the raw path: a live update row listed sixteen of them in one summary. `fieldLabel` knows the five line columns; an unknown column keeps its name after "שורה N:".

## Review Triage Log

2026-10-28, verification-gap reviewer (six findings):

- The compact card layout of `AuditTable` was never mounted by a test -- **fixed**: `auditPage.spec.ts` got a mutable breakpoint mock and a second describe under 900px (a card per event, the range numbers, the two arrows disabled at the ends and the page each sends, the order toggle round trip from page 1, the empty text, a card opening the drawer). The `t` mock prints the range values for that.
- The debounce's ref had no test changing a filter during the pause -- **fixed**: `auditFilters.spec.ts` types, re-renders with an action picked, and asserts the debounced call carries both.
- The audit link in the phone drawer nav was outside every test -- **fixed**: `ManagerLayout.spec.ts` renders below the desktop width, opens the hamburger and reads the six drawer links in order.
- Only the asc half of `orderFromModel` was exercised -- **fixed**: `auditTable.spec.ts` (new, the grid mocked like `issuancesTable.spec.ts`) covers asc, desc, a null sort and an empty model; the page spec's stub got a desc button and the round trip back to newest first.
- The precache ignore list and the pinned chunk names are checked by a manual build only -- **deferred**: an automated check needs `npm run build` in the test path (compare the entry chunk's static imports with the manifest in `dist/sw.js`); the repo verifies the offline shell by hand today (AGENTS.md). The build was run twice for this change, 17 entries / 543 KiB, no `mui-x` chunk in `sw.js`.
- The board's search debounce keeps the stale closure -- **deferred**: out of this plan's scope (Plan Change Log); the same ref and the same spec apply to `BoardFilters.tsx` when it is taken up.
- The stale sentence in Implementation Notes about `filter_clear` -- **fixed** (marked superseded).

2026-10-28, edge-case hunter (five findings):

- A search longer than 100 characters reached the server and came back as an English 400 -- **fixed**: the search box carries `maxLength` `SEARCH_MAX` (the server's `Q_MAX`), asserted in `auditFilters.spec.ts`.
- The two days went as bare dates, which the server reads as utc midnight, so the first two or three hours of the "from" day dropped out and the next day's leaked in -- **fixed**: `toAuditQuery` sends `dayjs(day).startOf("day").format()` (a date time with the zone it was picked in, the shape `DATE_RE` takes) and the day after "to" as the exclusive end; both specs assert the shape. Checked against the running server from the browser pane.
- `%` and `_` in `q` are not escaped before the `ILIKE` -- **refuted**: deliberate, the board's search does the same (`issuances.service.ts`), noted in the plan's Implementation Notes and in `docs/api.md`; a wildcard typed into a read only search widens the match and nothing else.
- Modules neither `manualChunks` branch names (`@mui/x-virtualizer`, parts of `@mui/x-internals`) could land in a shared chunk under rollup's own name inside the precache -- **refuted by the build**: `dist/assets` holds `mui-x-grid`, `mui-x-pickers`, `AuditPage`, `IssuancesBoard`, `exceljs`, the entry and a 2 kB `ArrowDownward` icon chunk; the manifest in `dist/sw.js` lists the entry, its css, the fonts, the qr worker and that icon chunk (17 entries, 543 KiB). The virtualizer is inside the grid chunk, the internals the entry needs are inside the entry.
- Retry on the error alert while the range is invalid sent nothing and said nothing -- **fixed**: the button is left out while `rangeInvalid(filters)`; the toolbar's own line under the dates says what to fix.

