---
title: 'Manager board phase 3: visual polish inside the Figma design'
type: 'chore'
created: '2026-10-11'
status: 'approved'
base: '96eb6fb (plus the uncommitted phase 2A tree)'
context: ['AGENTS.md', 'client/src/styles/_manager.scss', 'client/src/manager/components/IssuancesTable.tsx']
---

## Intent

**Problem:** The board follows `design/צד מנהל מחסן/לוח ניהול הנפקות.png` but reads heavier than it: 16px cells make rows alternate 45 / 63px at 1440 (addresses wrap in a 137px column), the filter controls come in three heights (32 / 36.5 / 40), the side widgets have a thick bar and a default scrollbar, and the phase 2A controls (sort toggle, hide / show) were dropped in unstyled.

**Approach:** Presentation only. 14px cells with a 52px row floor and column floors re-measured for that size, one 40px height for the toolbar controls and 36px pills, the footer on a tinted strip (the designer's note next to the export), lighter widget rows and a thin scrollbar, and the phase 2A controls given the same tokens. No change to markup that carries behaviour, to the filters, to the models or to the API.

## Boundaries & Constraints

**Always:** the blue-header design language of the export (not the white-header iteration in `image 35.png`, which the project never adopted); the six status pills; `bp` mixins only; two-class selectors on MUI (`.issuances-grid.MuiDataGrid-root`); the grid's three memoised models and `getRowHeight` auto (wrapped addresses still grow a row).

**Never:** tabs, counters, KPI cards; new dependencies; changes to selection eligibility, sorting, paging, the 1440 breakpoint, the cards under 900px, or any server file.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 1440, panel shown | grid 929px | no horizontal scroll inside the grid, one-line rows 52px, headers full | a long address wraps and grows its row only |
| 1280 and 1920, panel shown / hidden | grid 1201 / 1361 / 1409 / 1841px | columns flex into the width, no scroll, row floor unchanged | - |
| toolbar | search, pills, fields, buttons | search and fields 40px, pills 36px, buttons 40px, one baseline | - |
| widget list | 25 cities | thin scrollbar, 48px rows, bar under the courier name does not touch the next row | - |

## Code Map

- `client/src/styles/_manager.scss` -- `.board`, `.board-filters`, `.status-quick`, `.issuances-grid`, `.side-widgets`, `.widget`, `.sort-toggle`.
- `client/src/styles/_badges.scss` -- status and priority pills, shared with the courier app: not touched, the board overrides inside the grid.
- `client/src/manager/components/IssuancesTable.tsx` -- `minWidth` / `flex` / `maxWidth` per column (the floors are measured for 14px).

## Tasks & Acceptance

**Execution:**
- [x] `_manager.scss` grid block -- 14px, `--grid-row-min: 52px` on the cells, hover tint, tinted footer -- the row of the export.
- [x] `IssuancesTable.tsx` -- floors 132 / 94 / 154 / 90 / 124 / 84 / 142 (+ 50 + 50 = 920) -- fits the 927px (15px scrollbar) or 925px (17px) the grid gets inside its border at 1440.
- [x] `_manager.scss` toolbar -- 40px buttons, 36px pills, 14px -- one height.
- [x] `_manager.scss` grid block -- 13px pills with 15px icons inside the grid only; `_badges.scss` untouched, it is the courier's sheet too -- proportion to the 14px cell.
- [x] `_manager.scss` widgets -- 16px body, 48px rows, 3px bar, thin scrollbar, sort toggle and hide button styled -- phase 2A controls fit.

**Acceptance Criteria:**
- Given the board at 1440 with the panel, when today's page renders, then every one-line row measures 52px and `scrollWidth === clientWidth` on the page and on the grid's scroller.
- Given 1280 and 1920 with the panel shown and hidden, when measured, then no horizontal overflow and no truncated header title.
- Given a `partially_delivered` row and a `self_pickup` row, when their kebab and detail open, then phase 2A behaviour is unchanged (disabled items, caption, enabled self pickup controls).

## Verification

**Commands:**
- `cd client && npx tsc --noEmit` -- expected: clean.
- `cd client && npm test` -- expected: 93 green (no test touches styles).
- `cd client && npm run build` -- expected: a dist with no errors.

**Manual checks (only when no CLI check applies):**
- Browser at 1280 / 1440 / 1920, panel shown and hidden: row heights, column widths, overflow, toolbar baseline, widget list; screenshots saved for the report.

## Implementation Notes

- 2026-10-11, done in the session itself (a visual loop in the browser pane); the two reviews stayed independent.
- Column floors at 14px, measured on the seeded page with a canvas `measureText`: number 132 (the title "מספר הנפקה" 78 + the 28px sort button + 24 inset; 120 truncated it), customer 96, destination 156, city 92, courier 124, priority 84, status 142; plus 50 + 50 = 926 for the 929 the grid gets at 1440.
- Measured after the change, fresh load at each width (the grid flexes on mount only): 1440 shown 929 / hidden 1361, 1280 1201 (panel under the table, as before), 1920 shown 1409 / hidden 1841. Every one-line row 52px, `--DataGrid-hasScrollX` 0, page `scrollWidth === clientWidth`, no truncated header title, toolbar on two lines everywhere.
- `min-height: var(--grid-row-min)` on `.MuiDataGrid-cell` is the row floor: the rows are `getRowHeight` auto and the grid measures them, so a wrapped address still grows its row above 52px.
- The footer strip (`--color-bg`) is the designer's note next to the export ("הורדת כמות תוצאות ודפדוף מתחת לטבלה עם צבע רקע"). The other note there, a subtle colour change of the widget titles, names no colour; the headers stay the primary blue of the export.
- The first pass changed `_badges.scss` (shared with the courier app) to 13px pills; the verification review caught that no courier screen was in the manual pass, so the sheet is back to HEAD and the grid block carries the sizes under `.issuances-grid.MuiDataGrid-root`. The courier app is untouched.
- Floors went 926 -> 920 after the same review: a 17px classic scrollbar leaves 925px inside the grid border at 1440, 926 would have scrolled by 1px there. Customer 94, destination 154 (the widest seeded address at 14px plus the two insets, exact), city 90.
- The kebab caption decision (phase 2A triage #4) is now `menuCaptionKey(status)`, exported and walked over every status in `issuancesTable.spec.ts`.
- `image 35.png` in the design folder is a later white-header iteration of the board; it was not adopted earlier (see the couriers page) and is not adopted here.
- Phase 2A re-checked after the change on `2012871` (partially delivered: checkbox disabled, every kebab item disabled with the caption, locked detail) and `2025563` (self pickup: only "העברה לאיסוף עצמי" disabled, detail editable with the courier link, handover and delete).

## Plan Change Log

## Review Triage Log

Pass 1, 2026-10-11, edge-case-hunter + verification-gap on `build-manager-board-phase-3.diff`.

| # | Finding | Verdict | Evidence / action |
|---|---------|---------|-------------------|
| 1 | `_badges.scss` resize reaches four courier screens nobody looked at | fixed | sheet back to HEAD, sizes under `.issuances-grid.MuiDataGrid-root` |
| 2 | kebab caption decision untested | fixed | `menuCaptionKey()` exported, walked over every status in `issuancesTable.spec.ts` (client 94 tests) |
| 3 | plan said 914 while the code had 926 | fixed | plan tasks ticked with the shipped numbers |
| 4 | 1px slack at 1440; a 17px scrollbar overflows | fixed | floors 920 (customer 94, destination 154, city 90); 1440 re-measured: 927 inside the border, no scroll |
| 5 | `.board-filters__clear` padding loses to `MuiButton-text` | fixed | `&__clear.MuiButton-root` |
| 6 | row hover tint sticks after a tap on touch devices | fixed | `bp.touch` resets `:not(.Mui-selected):hover` |
| 7 | footer `min-height: 48px` inert under the 52px toolbar | fixed | declaration removed, the footer stays the toolbar's 52 |
| 8 | 14px on the widget search drops it to 37px | fixed | `min-height: 40px` on the input root |
| 9 | a 12+ digit `sap_number` is cut at the 132 floor | deferred | same as before the change (148 at 16px); the seed has 7 digits and SAP numbers are fixed width. A cap belongs to payload validation, out of scope |
| 10 | caption text changed for closed statuses since phase 2A | refuted | that is phase 2A triage #4, the wording was corrected on purpose ("לא ניתן לבצע עליה פעולות" when every item is refused) |
