---
title: 'Manager board on MUI Data Grid Premium'
type: 'feature'
created: '2026-10-07'
status: 'done'
base: '2b901f1'
context: ['AGENTS.md', 'client/src/manager/components/IssuancesTable.tsx', 'client/src/manager/components/BoardFilters.tsx', 'client/src/manager/pages/IssuancesBoard.tsx', 'client/src/styles/_manager.scss']
---

## Intent

**Problem:** The manager board renders its desktop rows with a hand written `<table>`; the product wants MUI Data Grid Premium there, multi-value filters, status quick-action buttons, a delivery date that opens on today and a narrower search box, all on top of the server paging that exists and is tested.

**Approach:** Swap the desktop branch of `IssuancesTable` for `DataGridPremium` in server mode (paging, sorting), wired to the board's existing `page` / `sort` / `selected` state and the unchanged `GET /api/issuances` response. The filter bar sends lists for status and city, which the server reads as `IN (...)` lists; one value keeps working as today, compared verbatim, the only difference being a value that itself contains a comma.

## Boundaries & Constraints

**Always:**
- `@mui/x-data-grid-premium@^8` (installed, 8.29.3; v9 needs MUI core 7) with `@mui/x-license` at the same version as an explicit dependency. License key from `VITE_MUI_X_LICENSE_KEY` in `client/src/main.tsx` when set; without it the grid shows its watermark, document that.
- Server mode everywhere: `paginationMode="server"`, `rowCount={total}`, `paginationModel={{ page: page - 1, pageSize: 15 }}`, `pageSizeOptions={[15]}`, `sortingMode="server"`, `disableMultipleColumnsSorting`. The grid never holds more than the page the API returned.
- Every grid feature that only makes sense on the full set is off: column filters, row grouping, aggregation, pivoting. The board's own filter bar is the only filter.
- The 15-row page size, the asc → desc → default sort cycle, the selectable statuses (unassigned, assigned, not_delivered, partially_delivered), the kebab menu with its five actions, the number link that opens the detail dialog, the badges, the empty text and the Hebrew strings stay as they are.
- v8 selection model is `{ type: 'include' | 'exclude', ids: Set }`. Map both shapes to concrete ids of the loaded selectable rows before calling `onSelect`; an `exclude` model must never reach the bulk actions.
- Under 900px (`compact`) the cards stay: nine columns do not fit a phone and the design there is the card list. The cards toolbar keeps the existing range label and the two arrow buttons; on desktop the grid footer shows the same `board_range` text through `slotProps.pagination.labelDisplayedRows`.
- `IssuancesBoard` is loaded with `React.lazy` + `Suspense` (the `page-loading` spinner) so the grid does not enter the courier's precached bundle.
- Client style: 2 spaces, double quotes, `t("key")` for every string, SCSS 4 spaces through `bp` mixins, MUI rules qualified (`.issuances-grid.MuiDataGrid-root`), comments in lowercase English saying why.

**Never:**
- No client side paging, sorting or filtering. No cursor paging. No change to the list response shape or to the sort map.
- No new query parameters. The only server change is that `status`, `priority` and `city` accept a comma list.
- No redesign of the conflicts or couriers tables; they keep `.issuances-table`.
- No other dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| open the board | first render | filters = empty + `date` = today's local date (`dayjs().format("YYYY-MM-DD")`); one request `?date=YYYY-MM-DD&page=1&page_size=15`; the grid shows that page, footer "1-15 מתוך N הנפקות" | - |
| next page | footer arrow | `page` 2 → request with `page=2`; grid rows replaced, `rowCount` unchanged | - |
| header click | column "לקוח" once / twice / thrice | asc → desc → no sort (server default), each a request with `sort=customer&order=`, page back to 1 | unknown column cannot be produced |
| status quick actions | click "נמסר", then "לא שובץ", then "נמסר" again | `status=delivered` → `status=delivered,unassigned` → `status=unassigned`; none active = no `status` param; page back to 1 | - |
| city multi select | pick two cities | `city=תל אביב,חיפה`; selected names shown in the field | - |
| priority | pick one | `priority=urgent` as today (two values, "both" is no filter, so it stays single) | - |
| clear filters | the clear button | every filter empty including the date; search box emptied | - |
| search | type 3 letters | 400 ms debounce then `search=` as today; the input is at most ~360px wide on desktop, full width on a phone | - |
| select all | header checkbox on a page with closed rows | only the selectable rows of the page are selected; bottom bar count matches | - |
| server list param | `status=assigned,delivered` | `i.status IN ('assigned','delivered')`; `status=assigned` unchanged; blanks and empty items dropped | - |
| phone | width < 900 | cards, select all, sort select, range + arrows, exactly as today | - |

## Code Map

- `client/src/manager/components/IssuancesTable.tsx` -- the component to migrate: desktop `<table>` branch becomes `DataGridPremium`; the compact card branch, the shared kebab `Menu`, `selectable` and `RowAction` stay. It gains `page`, `total`, `onPage` props.
- `client/src/manager/pages/IssuancesBoard.tsx` -- owns `filters`, `sort`, `page`, `selected`, `load()`. Its `board__range` bar moves into the table component; `load()` builds params through `toQuery(filters)`.
- `client/src/manager/components/BoardFilters.tsx` -- `emptyFilters`, the fields, the debounce. Gains `initialFilters()`, `toQuery()`, the status quick actions and the city multi select.
- `client/src/components/StatusBadge.tsx` + `client/src/styles/_badges.scss` -- the status colors (`.status-badge--<status>`) the quick actions reuse.
- `client/src/styles/_manager.scss` lines 109-242 -- `.board-filters` and the `.issuances-table` skin (surface, 12px radius, 1px border, `surface-2` header, `primary-lighter` selected row) to reproduce on `.issuances-grid`.
- `client/src/routers/AppRouter.tsx` line 8 and 26 -- the static import to make lazy.
- `client/src/main.tsx` -- where the license key is set.
- `server/src/issuances/issuances.service.ts` lines 91-98 -- the three equality filters to turn into lists.
- `server/src/e2e/pagination.e2e.spec.ts` `describe('filters')` -- where the list form gets its tests.
- `docs/api.md` line 10, `README.md` lines 24, 28, 37, 152-154 -- the contract note, the status lines, the stack table, the test counts.

## Tasks & Acceptance

**Execution:**
- [ ] `client/package.json` -- add `@mui/x-license` `^8.29.3` (`npm install`, then check the file did not reflow) -- `LicenseInfo` is not re-exported by the premium package in v8.
- [ ] `client/src/main.tsx` + `client/.env.example` (new) -- `LicenseInfo.setLicenseKey` guarded by `import.meta.env.VITE_MUI_X_LICENSE_KEY`; the example file documents the variable.
- [ ] `client/src/routers/AppRouter.tsx` -- `React.lazy(() => import(...IssuancesBoard))` inside a `Suspense` with the `page-loading` spinner.
- [ ] `client/src/manager/components/BoardFilters.tsx` -- `emptyFilters` with `status: string[]`, `city: string[]`; `initialFilters()`; `toQuery(filters)` joining arrays with "," and dropping empties; `StatusQuickActions` (six `<button type="button" aria-pressed>` wrapping `StatusBadge managerView`, class `status-quick`, inactive faded, active full color with a ring); the city field as a multi `Select` with checkboxes and a joined `renderValue`; the search without `fullWidth`; the clear button resets to `emptyFilters`.
- [ ] `client/src/manager/components/IssuancesTable.tsx` -- `DataGridPremium` with columns `number` (link button), `customer` and `destination` (flex, wrapping cells via `getRowHeight={() => "auto"}`), `city`, `courier` (muted "detail_no_courier" when none), `priority` (`PriorityBadge`), `status` (`StatusBadge managerView`), `actions` (kebab, not sortable, no menu); `checkboxSelection`, `disableRowSelectionOnClick`, `isRowSelectable`; `autoHeight`; `loading`; `localeText` from `heIL` plus `noRowsLabel: t("board_empty")`; `hideFooterSelectedRowCount`; the unsorted icon slot set to `UnfoldMoreIcon` so idle headers keep the faint glyph of the design.
- [ ] `client/src/manager/pages/IssuancesBoard.tsx` -- `useState(initialFilters)`, `toQuery` in `load()`, `page` / `total` / `onPage` passed down, the range bar removed here.
- [ ] `client/src/styles/_manager.scss` -- `.issuances-grid.MuiDataGrid-root` skin, `.status-quick` states, `.board-filters__search` max width (phone: 100%), the quick actions row wrapping.
- [ ] `client/src/manager/components/boardFilters.spec.ts` (new) -- `toQuery` (arrays joined, empties dropped, strings passed through) and `initialFilters().date` equal to `dayjs().format("YYYY-MM-DD")`.
- [ ] `server/src/issuances/issuances.service.ts` -- `status`, `priority`, `city` through one `listOf()` helper and `IN (:...list)`; comment says the board's multi select sends a comma list and one value is a list of one.
- [ ] `server/src/e2e/pagination.e2e.spec.ts` -- two tests: `status=assigned,delivered` total equals the SQL `IN` count and every row is one of the two; `city=<a>,<b>` likewise. Blank items (`status=assigned,`) behave as the single value.
- [ ] `docs/api.md`, `README.md` -- list form noted on the issuances row; stack table names Data Grid Premium (watermark without a key); `## Status` line 24 mentions the grid, the quick actions and the multi select; test counts updated to the real numbers.

**Acceptance Criteria:**
- Given the seeded dev database, when the board opens, then the network shows one list request with today's date and `page=1&page_size=15`, and the grid shows those rows with "1-15 מתוך N הנפקות" in its footer.
- Given the date filter cleared, when the footer goes to page 2 and then a header is clicked, then each step is one request (`page=2`, then `sort=...&page=1`) and the rows change accordingly; no request ever asks for more than 15 rows.
- Given two status buttons pressed, when the list request is inspected, then `status=` carries both values joined by a comma and the total equals the sum of the two single-status totals.
- Given the header checkbox clicked on a page that holds a delivered row, when the bottom bar is read, then the count equals the selectable rows of that page and the delivered row is unchecked.
- Given a 375px viewport, when the board renders, then the card list, select all, sort select and range arrows look and work as before.
- Given `npm run build` in `client/`, when the output is listed, then the data grid sits in the board's chunk, not in the entry chunk.

## Verification

**Commands:**
- `cd client && npx tsc --noEmit -p tsconfig.json` -- expected: clean.
- `cd client && npm test 2>&1 | tail -20` -- expected: all pass, the new spec included.
- `cd client && npm run build 2>&1 | tail -25` -- expected: builds; the grid in a lazy chunk.
- `cd server && npx tsc --noEmit -p tsconfig.json && npm run test:e2e 2>&1 | tail -20` -- expected: all pass (PostgreSQL on 5433).

**Manual checks:**
- Dev servers already run on 3000 (API) and 5173 (client, HMR); do not restart them. In the browser pane: open the board as `manager` / `1234`, check the console for errors, walk the matrix rows above and read the requests with the network tool.

## Design Notes

The grid gets the board's state, not the other way round: `page`, `sort` and `selected` stay in `IssuancesBoard` as today, the grid only renders them and reports clicks. That keeps `changeFilters` / `changeSort` resetting the page exactly as before.

Priority stays a single select: with two values, selecting both is the same as no filter.

## Implementation Notes

2026-10-07, implemented as planned with these departures:

- `pagination` has to be set on `DataGridPremium`. The premium grid does not page by default (the MIT one does); without it the footer is a plain row count and `paginationMode` means nothing. Found in the browser, not in the types.
- The footer range goes through `localeText.paginationDisplayedRows`, not `slotProps.pagination.labelDisplayedRows`: v8's `GridPagination` takes no props and the material adapter reads the label from the locale text.
- `sortModel`, `paginationModel`, `rowSelectionModel` and `columns` are memoized. The grid compares them by reference: a fresh `[]` for "no sort" on each render counted as a sort change, and the grid's own `sortModelChange` handler sent page 2 straight back to page 1 (two requests per arrow click). `onOpen` is read through a ref so the columns memo depends on `t` only and a width the manager dragged survives a reload of the rows.
- `disableColumnMenu` joined the switched off features: the header menu is the way into pinning, hiding and grouping, nothing of it belongs on the board.
- `columnUnsortedIcon` is a two line wrapper around `UnfoldMoreIcon` that drops the slot's `sortingOrder` prop (an svg would print it as an unknown attribute).
- `PAGE_SIZE` moved from `IssuancesBoard` to `IssuancesTable` (exported): the grid needs it for its model and the cards for the range text.
- The status dropdown left the filter row, the quick actions replace it. They sit next to the search on a first line (`.board-filters__top`); the search is capped at 360px there and full width on a phone.
- The rows-per-page select in the footer is hidden by css, it has one option.
- The fixed column widths add up to 962 so the nine columns fit a 1024 viewport. The grid still reports a 15px overflow there: it computes the flex widths once, before the page's vertical scrollbar appears, and does not rehydrate them on resize (`--DataGrid-columnsTotalWidth` stayed 982 while the viewport went 1024 to 1000). Cosmetic, the old table scrolled at that width too; none of it above 1040.

Files touched: `client/package.json` and `client/package-lock.json` (`@mui/x-license`), `client/.env.example` (new), `client/src/main.tsx`, `client/src/routers/AppRouter.tsx`, `client/src/manager/components/BoardFilters.tsx`, `client/src/manager/components/IssuancesTable.tsx`, `client/src/manager/components/boardFilters.spec.ts` (new), `client/src/manager/pages/IssuancesBoard.tsx`, `client/src/styles/_manager.scss`, `server/src/issuances/issuances.service.ts`, `server/src/e2e/pagination.e2e.spec.ts`, `docs/api.md`, `README.md`.

Surprises and open items:

- Workbox precaches every built chunk (`globPatterns: **/*.js`), so the lazy board chunk (807 kB) and the premium package's excel export chunk (`exceljs.min`, 1 MB, loaded only by an export the board never calls) still land in the courier's precache: 10 entries, 2.5 MB. The lazy split keeps them out of the entry chunk as the acceptance asks; keeping them out of the precache needs `globIgnores` in `client/vite.config.ts`, outside this plan.
- The dev api on 3000 runs `nest start` without a watcher from a dist built before the server change, so a comma list reaches it as one literal value and returns no rows until it is restarted. The list form is covered by the two new e2e tests (totals against sql, the sum of the two single status totals, the blank item).
- `@mui/x-telemetry` ships with v8 and is off by default (`MUI_X_TELEMETRY_DISABLED`), nothing to set.
- The seed has no urgent issuance that is delivered or unassigned, so `status=delivered,unassigned&priority=urgent` is an honest empty page.

Verification: `npx tsc --noEmit` clean on both sides; client 76 tests in 8 files; server e2e 72 in 6 suites (the unit suite is untouched and was not rerun); `npm run build` puts the grid in `IssuancesBoard-*.js`; every matrix row walked in the browser pane against the running dev servers (requests read with the network tool, the old api for the multi value rows).

## Plan Change Log

- 2026-10-07, after the edge-case review: `listOf()` no longer trims (a padded city offered by the summary must still match, as the old `= :city` did); the city multi select splits a string value (browser autofill); `load()` clamps a page that outlived its rows so the cards behave like the grid; a `ChunkBoundary` around the lazy board route shows a reload line instead of a blank page when the chunk fails to load (stale index after a deploy, network drop); the dead `th.sortable` / `.is-selected` / `.col-menu` rules of the old table left `_manager.scss`.
- 2026-10-07, after the verification-gap review: the two grid-to-board adapters (`selectionToIds`, `sortModelToState`) are exported from `IssuancesTable.tsx` and pinned by `issuancesTable.spec.ts` (the grid module is mocked there, vitest cannot resolve its esm directory imports); `priority=urgent,normal` got its e2e test; `globIgnores` in `client/vite.config.ts` keeps the board chunk and the grid's excel chunk out of the courier precache (2.5 MB back to 0.75 MB), which the AppRouter comment had claimed without it.

## Review Triage Log

Verification-gap review, 2026-10-07:
- `priority` comma list documented but untested: real, fixed (one e2e test).
- selection / sort / page adapters between the grid and the board untested: real, fixed by exporting the two non trivial ones as pure functions with a spec; the page offset (`page - 1` / `m.page + 1`) stays inline, two lines read by eye and covered by the browser check.
- `initialFilters()` caller (the board) has no render test: deferred, a board render spec needs the service layer, the dialogs and the grid mocked; the helper spec and the manual open-the-board check carry it.
- the lazy chunk split has no build-output assertion: deferred, the repo asserts nothing about `dist`.
- AppRouter comment claimed the courier precache skips the chunk while workbox precached every js: real, fixed with `globIgnores` so the claim is true, comment reworded.
- `localeText` rebuilt on every render: harmless, wrapped in `useMemo` for consistency with the comment above the models.

Edge-case review, 2026-10-07:
- lazy board chunk failing to load unmounts the app into a blank page: real, fixed with `ChunkBoundary` in AppRouter (message + reload).
- a city containing a comma splits into two tokens: refuted for this data (Israeli city names carry no comma, the dropdown offers the stored values) and recorded as the one known limit of the comma form in the plan Intent.
- `trim()` in `listOf` breaks a padded city that the old verbatim compare matched: real, fixed, no trim.
- MUI multiple select can hand a comma string (autofill): real, fixed with the documented split.
- cards on a page that outlived its rows show an empty list: real, pre-existing for the old table too, fixed in `load()` (two lines) so both layouts behave alike.
- dead `th.sortable` / `.sort-hint` / `.is-sorted` / `tr.is-selected` / `.col-menu` rules: real, removed; `.col-check` stays for the couriers table.
- "one value keeps working exactly as today" overstated: wording amended (verbatim compare, comma excepted).
- README undercount: already fixed after the verification-gap review (228 tests).
