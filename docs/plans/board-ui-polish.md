---
title: 'Manager board UI polish'
type: 'chore'
created: '2026-10-07'
status: 'done' # the user's brief (intent, boundaries, acceptance) is the approval
base: 'a047535'
context: ['AGENTS.md', 'client/src/manager/components/IssuancesTable.tsx', 'client/src/manager/components/BoardFilters.tsx', 'client/src/styles/_manager.scss']
---

## Intent

**Problem:** On the desktop manager board the Data Grid needs 962px but gets 929px at 1440 (the two column layout), so it scrolls sideways and "מספר הנפקה" / "עדיפות" truncate. Rows are 71px tall (narrow columns wrap), header and cell padding differ (10 vs 16px), badge cells are start aligned, the checkbox overflows its cell, the date input shows the browser's `mm/dd/yyyy`, and the status quick actions are faded badges (55% opacity).

**Approach:** Size the columns with flex / minWidth / maxWidth from measured content widths, align header and cell padding, center the badge columns, and restyle the toolbar and quick actions in the existing SCSS. Presentation only: models, handlers, queries and the filter state stay as they are.

## Boundaries & Constraints

**Always:** `filters.date` stays `YYYY-MM-DD` and goes to the server unchanged. The three grid models keep their references. Under 900px (cards) and the tablet / phone filter grid stay as they are. Client style rules from `AGENTS.md` (double quotes, `t()` keys in `shared/i18n/he.ts`, `bp` mixins, two-class MUI selectors).

**Never:** new dependencies (no MUI X date pickers), changes to pagination / sorting / filtering / selection / self pickup / API / the 1440 breakpoint of the board, raw `@media` numbers, the product copy of existing strings.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|----------|--------------|----------|----------------|
| Default date | `filters.date` = today ISO | field shows `DD/MM/YYYY` | n/a |
| Pick a date | native picker returns `2026-10-12` | `set("date", "2026-10-12")`, field shows `12/10/2026` | n/a |
| Cleared date | `filters.date` = "" (clear filters or picker Clear) | Hebrew placeholder, never `mm/dd/yyyy` | n/a |
| Grid 929px (1440) | 9 columns | no horizontal scroll, no truncated header | n/a |
| Grid 1422px (1920) | 9 columns | free text columns take the surplus, badge columns stay capped | n/a |

## Code Map

- `client/src/manager/components/IssuancesTable.tsx` -- column defs, grid props (desktop branch only)
- `client/src/manager/components/BoardFilters.tsx` -- toolbar markup, quick actions, date field
- `client/src/styles/_manager.scss` -- `.board-filters`, `.status-quick`, `.issuances-grid` skin
- `client/src/styles/_badges.scss` -- badge colors (shared with the courier screens)
- `shared/i18n/he.ts` -- the two new strings for the date field
- `client/src/utils/format.ts` -- `formatDate` already prints `DD/MM/YYYY`

## Tasks & Acceptance

**Execution:**
- [x] `IssuancesTable.tsx` -- flex / min / max per column (header text + sort button + padding fits), `align` + `headerAlign` center on priority, status, actions, wrap on city and courier, small checkbox, header and row height props -- fixes truncation and the 71px rows
- [x] `_manager.scss` grid skin -- one horizontal padding for header and cells, check and actions cells without padding, rest as the existing skin -- header and cell content line up
- [x] `BoardFilters.tsx` -- `DateFilterField`: read-only text field showing `formatDate`, calendar adornment, hidden native `type="date"` opened with `showPicker()` -- no `mm/dd/yyyy`
- [x] `_manager.scss` toolbar -- flex row with capped field widths, same gaps, search capped, margin to the grid -- one toolbar
- [x] `_badges.scss` + `_manager.scss` `.status-quick` -- `--badge-bg` variable; off = white pill with a neutral border and the status color text, on = tint with a ring -- readable, distinguishable
- [x] `shared/i18n/he.ts` -- `filter_date_placeholder`, `filter_date_open`

**Acceptance Criteria:**
- Given 1440px, when the board loads, then the grid has no horizontal scroll and no header truncates.
- Given 1280 and 1920px, then the same, and no column is stretched past its cap.
- Given a click on a header / a page arrow / a quick action / a filter / a row checkbox / the kebab, then the request and the state change are the same as before (network log compared).
- Given the date field, when a date is picked or cleared, then the `date` query parameter is `YYYY-MM-DD` or absent.
- Given 800px and 375px, then the cards layout, its select all / sort bar and the filter grid keep their metrics. The status buttons and the date field are shared components and look the same at every width.

## Verification

**Commands:**
- `npm run build` in `client/` -- expected: tsc and vite build pass
- `npm test` in `client/` -- expected: 87 tests pass (79 + 8 date field specs)

**Manual checks:**
- Live board at 1280, 1440, 1920 and 800: measure scrollWidth vs clientWidth and header truncation, screenshot, drive sort / page / quick actions through the pane, read the network requests.

## Implementation Notes

- Implemented directly, not through a no-context subagent: the work is a visual loop in the browser pane. The reviews stayed independent.
- Column floors add up to 920px (check 50, number 148, customer 100, destination 130, city 96, courier 100, priority 104, status 142, kebab 50). Measured on a fresh load: 1280 / 1440 / 1920 no horizontal scroll and no truncated header; 800 / 375 are the cards, unchanged.
- The grid measures its root width once, when it mounts, and its resize observer never updates it in this app (`getRootDimensions().root` stayed at the loading-state size; `apiRef.resize` does not exist in 8.29.3). The rows add the 15px page scrollbar after that, so the columns hung 15px over the edge. Fix is CSS: `html:has(.board) { scrollbar-gutter: stable }` at 900px and up (`bp.above-compact`), so the width is the same before and after the rows. A live window resize still does not re-flex the columns (also true before this change); a reload does.
- The empty filler cell at the end of each row inherited the cell padding (32px before, 24px in the first pass) and made the grid scroll by that much. `.MuiDataGrid-cellEmpty` has no padding now.
- The tablet padding override sat before the base rule at equal specificity and never applied; the inset is now one `--grid-inset` variable with the tablet value after it.
- `DateFilterField` shows `formatDate` (DD/MM/YYYY), the native `type="date"` input sits inside the field's input root (invisible, 1px, `pointer-events: none`) and only opens its popup through `showPicker()`; the picker's own Clear gives the empty value and the Hebrew placeholder shows. Four specs in `boardFilters.spec.ts` (client tests 79 -> 83, README counts updated).
- Status quick actions: `--badge-bg` custom property in `_badges.scss` (same colors as before for every other badge); off = white pill, 1px neutral ring, status color text; on = tint + 1.5px ring in the text color; pills 32px, same 12px side padding so the row is still 611px.
- New mixin `bp.above-compact` (min-width 900) in `_breakpoints.scss`, the other side of `compact`.

## Plan Change Log

- The first plan said "no changes to the 1440 breakpoint of the board"; kept. The scrollbar fix was not in the plan, added after the stale grid width was found (see notes).
- Acceptance for 800 / 375px reworded after the edge-case review: "its toolbar is unchanged" was false (the status buttons grow from ~24 to 32px and the date field is replaced at every width, on purpose). What stays unchanged is the cards layout and the filter grid; the search max-width (360px) and the toolbar gaps below 900px were put back to their old values.
- Added after the same review: Backspace / Delete clear the date (the native input did), the grid's checkboxes get the 44px touch target, the status buttons get a forced-colors outline, centred headers do not clip the sort glyph.

## Review Triage Log

**Pass 1, verification-gap reviewer** (checked against the code; it ran its own mutations in scratch copies):
- Toolbar wiring of the date field asserted by no test (`set("date", …)` could point at another key, specs stay green) -- fixed: `BoardFilters` is rendered in `boardFilters.spec.ts` and a pick / a clear must call `onChange({ ...filters, date })` with every other filter untouched. Mutation `set("customer", next)` now fails it.
- Picker opening only covered on the happy path (fallback, receiving element, Space / ArrowDown unpinned) -- fixed: the `showPicker` mock sits on the native input instance, Enter / Space / ArrowDown open it and Tab / a do not, and two cases (no `showPicker`, `showPicker` throws) must leave the focus on the native input. Mutations "no focus fallback" and "only Enter" now fail.
- Other: `IssuanceDetailDialog.tsx:147` still has a plain `type="date"` for the row menu's "change delivery date" -- deferred, outside the brief (the brief names the board's delivery date filter); it keeps the browser's own date order.
- Other: `client/index.html` shows a whitespace-only reformat in the working tree -- refuted as ours: its mtime (17:15) is after my last build and after the review diff was written, I never edited it. Left alone, it must stay out of this change's commit.

**Pass 1, edge-case hunter** (each claim checked live in the pane or against the code):
- A click on the shrunk label asks for the picker twice (the label hands its click on to the input; two `showPicker()` calls measured, one from a click on the input) -- fixed: `pointer-events: none` on the date field's label, one call from any click on the field now.
- Backspace / Delete / digits ignored on the read-only field (the native input allowed all three) -- Backspace and Delete fixed (clear the date, no change event when it is empty, spec added); typing digits deferred: it needs an editable masked field, and the picker opens from Enter / Space / ArrowDown and is keyboard operable. A masked input or MUI X date pickers (a dependency) would be the follow-up.
- Priority sort glyph clipped at the 104px floor (10 of 18px visible, measured) -- fixed: centred headers' title container has `overflow: visible`, the glyph hangs into the header inset (18 of 18 visible at 1280 / 1440, title centred within 1px, also while sorted). The same finding as a falsified claim ("floors fit header text + sort button") is closed by it.
- MUI's `:hover` rule ties with the zero width icon container at four classes -- refuted: the loaded stylesheets have no `:hover` rule on `.MuiDataGrid-iconButtonContainer` at all (only the resize separator and our own opacity rule hover on the header), and the sorted rule has three classes against our four; a sorted centred header measured centred.
- Grid checkbox below the 44px touch target on a touch device at 900px or wider (no `bp.touch` rule for the grid) -- fixed: 12px padding on the grid's checkboxes in the existing `bp.touch` block. It was 42px (medium) before this task, 38px after the size change, 44px on touch now.
- Opacity cue removed, forced-colors strips the shadow and tint (deletion, medium) -- fixed: `@media (forced-colors: active)` outline on the active status button.
- Claim "800 / 375 toolbar unchanged" falsified (buttons 32px, search max 320 at 800, gap 12 16, date field) -- search max-width and gap put back below 900px; the status buttons and date field stay restyled at every width by design, acceptance reworded (see change log).
