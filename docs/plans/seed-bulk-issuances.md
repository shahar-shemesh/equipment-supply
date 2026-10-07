---
title: 'Bulk seed issuances and pagination verification'
type: 'chore'
created: '2026-10-07'
status: 'done' # draft | approved | in-progress | in-review | done | blocked
base: 'bfb74d963e8f4db7ae0820529b36c392a93d1119'
context: ['AGENTS.md', 'server/src/seed/seed.data.ts', 'server/src/seed/seed.service.ts', 'server/src/e2e/audit.e2e.spec.ts']
---

## Intent

**Problem:** The seed inserts 30 handcrafted issuances, so the manager board's offset paging (`GET /api/issuances?page=&page_size=`) has never been exercised at a realistic size and nothing proves that page, total, filters and sort stay correct past the first two pages.

**Approach:** Keep the 30 handcrafted rows exactly as they are and add a deterministic generator for 2000 varied issuances on top, inserted by the same seed service; then prove the existing pagination with an e2e spec that seeds the full set and walks the pages through the API. The pagination code is not touched unless a test exposes a real bug.

## Boundaries & Constraints

**Always:**
- Same seed run gives the same rows: the generator uses a small seeded PRNG in `seed.data.ts`, no `Math.random`.
- `buildIssuances()` keeps returning the same 30 rows (pairs, figma names, `n === 7`, `n === 22` specials); the e2e seed test asserting `issuances: 30` for a plain `run()` must keep passing.
- Every bulk row is a legal issuance: `sap_number` digits only and unique across both sets, the status / task / attempt relation built by the existing loop (assigned = pending task; delivered / partially_delivered / not_delivered = done task + attempt whose item answers match the outcome; self_pickup and unassigned = no task; deleted = `status: deleted`, `deleted_at`, `delete_reason`, no task, mirroring `issuances.service.ts` `remove`).
- `source` stays `'sample'`. `npm run seed` still refuses outside LOCAL + `ALLOW_DESTRUCTIVE_SEED`.
- Server code style: single quotes, 2 spaces, lowercase "why" comments, `/*──...──*/` between top level functions.

**Never:**
- Change `issuances.service.ts` `list`, the client paging, the sort map, the page size or the response shape unless an acceptance test below fails for a real reason, and then amend this plan first.
- No cursor paging, no infinite scroll, no client side paging, no new dependencies.
- No chunked raw INSERT path that duplicates the task / attempt rules: both row sets go through the one loop.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| default seed | `npm run seed`, `SEED_BULK` unset | 30 + 2000 issuances, log line with the counts, one `system.seed` audit row with `issuances: 2030` | refused as today without the LOCAL flags |
| handcrafted only | `SEED_BULK=0` or `run()` with no options | exactly the 30 rows of today | - |
| custom size | `SEED_BULK=500` | 530 issuances | blank = 2000; anything that is not a whole number is refused before the app boots |
| first page | `?page=1&page_size=15` on 2030 seeded rows | 15 rows, `total` = rows with `deleted_at IS NULL`, `page: 1`, `page_size: 15` | - |
| middle and last page | `?page=2`, last page, `page_size=100` | pages are disjoint; the last page holds `total % 100` rows (or 100); page past the end returns `rows: []` with the same `total` | - |
| page size cap | `page_size=500`, `page=0`, `page=abc` | 100 rows, page 1, page 1 | no 400, the service clamps |
| full walk, default order | all pages at `page_size=100` | union of ids has exactly `total` members, no duplicates | - |
| full walk, sorted | `sort=city&order=asc`, `sort=courier&order=desc`, `sort=number&order=desc` | the concatenated id list equals a direct SQL query with the same ORDER BY and `id` tie-break | `sort=password` stays 400 |
| filter + page | `status=assigned&page=2`, `city=<x>&priority=urgent`, `customer=<partial>`, `courier_id=<id>`, `search=<partial street>` | `total` equals the SQL count for the same predicate, every returned row satisfies it, pages are disjoint | - |
| filter past its end | a filter with 2 pages and `page=50` | `rows: []`, filtered `total` | - |
| deleted rows | 3% of bulk rows are deleted | never in any page, excluded from `total` | - |

## Code Map

- `server/src/seed/seed.data.ts` -- `users`, `couriers`, `buildIssuances()` (30 rows). Add `buildBulkIssuances(count)` here with its own pools (names, cities, streets, products) and the PRNG.
- `server/src/seed/seed.service.ts` -- `run()`: truncate, couriers, users, the issuance loop (task + attempt per status), the audit row. `run(opts)` gains the bulk rows; the loop moves into one `dataSource.transaction` so 2000 rows commit in seconds, not one fsync per statement.
- `server/src/seed/seed.ts` -- CLI entry; reads `SEED_BULK` next to the dotenv load and passes `{ bulk }`.
- `server/.env.example` -- document `SEED_BULK`.
- `server/src/issuances/issuances.service.ts` `list` (lines 71-124) -- the paging under test; read only.
- `server/src/issuances/issuances.service.ts` `remove` (lines 276-294) -- the deleted row shape to mirror.
- `server/src/e2e/audit.e2e.spec.ts` lines 1-60 and 414-430 -- the boot pattern (`setup-env`, `ensureTestDatabase`, `Test.createTestingModule`) and the `ALLOW_DESTRUCTIVE_SEED` trick for calling `SeedService.run()` in a spec.
- `README.md` `## Status` line 28, `## Tests` lines 152-154, `## Sample data` line 160 -- counts and the seed description.

## Tasks & Acceptance

**Execution:**
- [ ] `server/src/seed/seed.data.ts` -- add `buildBulkIssuances(count: number)`: mulberry32 style PRNG with a fixed seed; pools of about 40 first names, 30 surnames, 25 Israeli cities, 40 streets, 15 products; a customer pool of about 150 (name + consistent 9 digit id + phone with mixed 05x / 0x prefixes) so the same customer repeats at the same address and the boards group them; status weights roughly unassigned 25%, assigned 15%, delivered 42%, partially_delivered 5%, not_delivered 5%, self_pickup 5%, deleted 3%; priority urgent about 15%; `delivery_date` spread over -60..+30 days with about 5% null, past dates for closed statuses; `number_prefix` from ס'/ד'/כ' with some null; `notes` on about 10%; 1-4 items with sequential `line_no` and quantity 1-3; `sap_number` = `String(2000000 + n * 13 + r)` with `r` in 0..12 so blocks never overlap the handcrafted range 1234567..1234944; courier (any of the 5) only on statuses that need a task -- the field is what the service loop already reads.
- [ ] `server/src/seed/seed.service.ts` -- `run(opts: { bulk?: number } = {})`; rows = handcrafted then `buildBulkIssuances(opts.bulk || 0)`; wrap couriers, users and the loop in `this.dataSource.transaction(async (em) => ...)` using `em.save(Entity, data)`; drop the now unused repository injections; the audit row stays `recordDetached` after the transaction with the real count; the final log line names handcrafted and bulk counts.
- [ ] `server/src/seed/seed.ts` -- `const bulk = Number.isFinite(+process.env.SEED_BULK) && process.env.SEED_BULK !== '' ? +process.env.SEED_BULK : 2000;` (or equivalent) and `run({ bulk })`, with a why comment.
- [ ] `server/.env.example` -- `# SEED_BULK=2000` line under the seed flag: generated issuances on top of the 30 handcrafted ones, 0 for the handcrafted set only.
- [ ] `server/src/seed/seed.data.spec.ts` -- unit spec, no database: count, determinism, `sap_number` uniqueness across both sets and digits only, every `IssuanceStatus` present, both priorities, at least 15 distinct cities, dates past / future / null, courier only where a task is due, deleted rows carry `deleted_at` + `delete_reason`, items `line_no` 1..k.
- [ ] `server/src/e2e/pagination.e2e.spec.ts` -- boots like the other e2e specs, seeds once in `beforeAll` with `run({ bulk: 2000 })`, logs in as the seeded manager, then covers every row of the matrix above through supertest, comparing against direct `ds.query` results for totals and sorted id lists.
- [ ] `README.md` -- `## Status`: "a seed with 30 handcrafted issuances plus 2000 generated ones"; `## Sample data`: mention `SEED_BULK`; `## Tests`: suites, unit, e2e and total counts updated to the real numbers after `npm test`.

**Acceptance Criteria:**
- Given a fresh database, when `npm run seed` runs with `SEED_BULK` unset, then the log reports 2030 issuances and the seed's own work (first to last log line) finishes in under 20 seconds; the ts-node compile before it is not counted.
- Given the seeded test database, when the pagination spec walks every page of `/api/issuances` at `page_size=100` with each of the three sorts, then every walk yields exactly `total` distinct ids in the same order as the matching SQL query.
- Given a `status=assigned` filter on 2030 rows, when page 2 is requested, then `total` equals `SELECT COUNT(*)` for that predicate, every row is assigned and no id from page 1 repeats.
- Given a plain `run()` with no options, when the audit seed test in `audit.e2e.spec.ts` runs, then it still sees `issuances: 30`.
- Given the server running on the seeded dev database, when the board is opened in the browser, then page 1 shows 15 rows and "1-15 מתוך <live total>" (the deleted rows are not counted), the last page shows the remainder, a filter change returns to page 1, and the list request stays well under one second.

## Verification

**Commands:**
- `cd server && npx tsc --noEmit -p tsconfig.json` -- expected: no errors.
- `cd server && npm run test:unit 2>&1 | tail -40` -- expected: all pass, the new seed.data spec included.
- `cd server && npm run test:e2e 2>&1 | tail -40` -- expected: all pass including `pagination.e2e.spec.ts` and the unchanged audit seed test (PostgreSQL up on 5433).
- `cd server && time npm run seed 2>&1 | tail -5` -- expected: "seeded ... 2030 issuances" in under 20 s.

**Manual checks:**
- Start the server, log in as `manager`, hit `/api/issuances?page=1`, `page=134`, `page=135`, `page=136`, `sort=courier&order=desc&page=7`, `status=unassigned&city=...` with curl and note the response times.
- Open the board in the browser: paging arrows, the range label, a filter change from page 20, a sort change from page 20.

## Design Notes

The two row sets go through the one loop in `seed.service.ts` on purpose: the task / attempt rules per status exist once. The transaction is what makes 2000 rows affordable with per-row `save`; a chunked raw insert path would be faster still but would duplicate those rules.

The generator draws the customer first and keeps their address, so repeats look like the same office receiving several issuances, which is what the courier board groups.

## Implementation Notes

2026-10-07, implemented as planned, no pagination code touched.

Files: `server/src/seed/seed.data.ts` (PRNG, pools, `buildBulkIssuances`), `server/src/seed/seed.service.ts` (one transaction, `em.save`, repository injections dropped, `run(opts)`), `server/src/seed/seed.ts` (`SEED_BULK`), `server/.env.example`, `server/src/seed/seed.data.spec.ts` (8 unit tests), `server/src/e2e/pagination.e2e.spec.ts` (15 e2e tests), `README.md` (Status, Tests, Sample data). `seed.module.ts` still imports `TypeOrmModule.forFeature(entities)`; harmless, left alone.

Decisions:
- PRNG seed is `20261007`. `deleted_at` draws its hour from the PRNG too, so two calls on the same day build equal `Date`s and the determinism test can `toEqual` them. A smaller count is a prefix of a larger one because the 150 customers are drawn before the rows.
- A `partially_delivered` row always has 2-4 items: the seed loop delivers line 1 and refuses the rest, with one line "partial" would be a full delivery.
- `revision` is not bumped on the generated deleted rows (`softDelete` does); the plan's field list did not ask for it and nothing reads it on a deleted row.
- The e2e spec compares id lists, not rows, against SQL that repeats the service's ORDER BY (including the courier subselect) with the `i.id ASC` tie break. Same database, same collation, so Hebrew sort order is not an assumption.
- `status=deleted` through the filter returns `total: 0` (the `deleted_at IS NULL` guard wins); asserted as intended behaviour.

Measured:
- `npm run seed`, SEED_BULK unset: 2030 issuances, 1359 tasks, 1056 attempts. The seed itself (first log line to last) is 11 s; the process is 21 s wall clock because ts-node compiles the app first (~10 s). The 20 s acceptance figure is met by the seed, not by the ts-node boot; `package.json` was left untouched so `transpileOnly` was not an option here.
- Seeded set: 63 deleted, `total` 1967, 132 pages of 15 (the last with 2 rows). API timings through curl against the running server: page 1 in 23 ms, page 131-133 in 180-250 ms, `sort=courier&order=desc&page=7` 215 ms, `page_size=100` page 1 62 ms, page 20 of the city sort 197 ms. Deep offsets cost more than page 1 because the courier subselect is in the SELECT list and runs for the skipped rows too; still well under a second, so nothing was changed.
- Browser, dev server on 5173: page 1 "1-15 מתוך 1967 הנפקות" (urgent first), page 2 "16-30", page 20 "286-300"; a sort change from page 20 returns to "1-15 מתוך 1967"; a customer filter from page 20 returns to "1-15 מתוך 43" and its last page shows "31-43 מתוך 43". Both resets are the existing `setPage(1)` calls in `IssuancesBoard.tsx`.
- Tests: unit 74 (was 66), e2e 69 (was 54), the audit seed test still sees `issuances: 30`. The pagination spec takes about 45 s, of which the seed is most.

Surprises: the e2e specs are 4 spaces while the rest of the server is 2, matched per file. The board pager keeps the page in React state only, so the browser check walked the arrows; a bookmarkable page is not in scope.

## Plan Change Log

- 2026-10-07, after the edge-case review: `SEED_BULK` parsing moved from `seed.ts` into `seedBulkCount()` in `server/src/env.ts` (the env reader AGENTS.md names), with a strict rule: blank = 2000, digits only = that count, anything else (`-5`, `2.5`, `1e3`, `' '`) is refused before the app boots. The matrix row said "non numeric falls back to 2000"; a silent fallback could seed a different set than the one asked for. `server/src/env.spec.ts` added (2 unit tests). The seed time and range label acceptance lines were reworded to what is actually measurable.

## Review Triage Log

Edge-case review, 2026-10-07:
- `SEED_BULK=' '` seeds 30 rows silently: real, fixed (trim + refuse in `seedBulkCount`).
- `SEED_BULK` negative / fractional / `1e8` passes `Number.isFinite`: real, fixed by the digits-only rule; no upper cap added, a developer who asks for a huge set gets it.
- pagination `beforeAll` can hit jest's 60 s default on a slow machine: real, fixed with an explicit 180 s hook timeout.
- the walk loops until the timeout when the offset is ignored: real, fixed with a page bound inside the loop.
- `dateAt` across a DST switch can put a closed row on the spec's "today": refuted as negligible. Generator and spec read the same clock; the date part can differ only in the one hour around UTC midnight on the two switch days a year, and `buildIssuances()` has used the same arithmetic since day one without a flake.
- "under 20 seconds" claim vs 21 s wall clock: real as a wording problem, the acceptance line now names the seed's own work (11 s); the ts-node compile is outside this change.
- `SEED_BULK` expression untested: real, covered by `env.spec.ts`.
- "1-15 מתוך 2000+" literal in the acceptance: wording fixed to the live total.

Verification-gap review, 2026-10-07:
- the tasks, attempts and item answers the seed loop writes are read back by nothing: real, fixed with a second test under 'the seeded set' that counts `issuance_items`, `delivery_tasks` (and the pending ones), `delivery_attempts`, `delivery_attempt_items` against the two builders and checks one generated partial delivery's answers line by line.
- `SEED_BULK` parsing untested: already fixed by the edge-case triage (`env.spec.ts`).
- handcrafted row 22 (`self_pickup`) keeps the courier of its `n % 3 === 1` branch, so the loop gives it a done task and an attempt with outcome `self_pickup`, which is not an `AttemptOutcome`: real and pre-existing, deferred. The plan freezes `buildIssuances()`; the fix is `courier = null` in the `n === 22` branch and one task and one attempt fewer. The new count test derives its expectations from the data, so it pins the row either way.
- "the same rows on every run" overstated, the dates move with the seed day: real, both wordings amended (README and the PRNG comment).
- the 'city + priority' comment claimed a multi page filter that the data does not give: real, comment corrected; the assertions were right.
