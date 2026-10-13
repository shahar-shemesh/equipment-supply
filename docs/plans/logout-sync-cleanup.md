---
title: 'Logout and token expiry: sync first, keep what the server never acknowledged'
type: 'feature'
created: '2026-10-13'
status: 'done'
base: '0d78b4e'
context: ['AGENTS.md', 'client/src/courier/offline/sync.ts', 'client/src/courier/offline/store.ts', 'client/src/courier/CourierLayout.tsx']
---

## Intent

**Problem:** Logout only clears localStorage and never tries to send the queue first, so a courier who signs out and never
signs in again on that tablet leaves reports behind for good. The previous courier's snapshot, details and acknowledged
reports (signatures, recipient id numbers) stay in IndexedDB for whoever uses the tablet next. Nothing on the client
notices the 12 hour expiry: the screens stay "logged in" with a dead token until some request answers 401, and that
path hard reloads the page in the middle of a sync pass.

**Approach:** Manual logout runs one bounded sync pass when it can (online, fresh token), then removes only what the
server already holds and keeps every unacknowledged report and draft under its scope. A client side expiry watcher ends
the session at `exp` without sending anything. Every courier start sweeps the other scopes' server copies, so a
different courier never inherits cache, while the pending reports and the meta row that names their owner stay. The
server is untouched: `operation_id` replay already makes resends safe.

## Boundaries & Constraints

**Always:** `stopSync()` before any delete (generation bump drops in flight results). Only `sync.state === synced` reports
are deleted; `queued`, `syncing`, `auth`, `invalid`, `forbidden`, `conflict` rows and drafts stay. `meta` is deleted only
when the scope holds no report and no draft. Requests go out only under a fresh token whose `sub` matches the row, as
`processDue` already checks. `clearSession` removes `es_token` and `es_user` on every path, including a failed flush.
Every string through `t()` with a key in `shared/i18n/he.ts`.

**Never:** extend or refresh the token, retry with an expired token, `deleteDatabase`, `clear()` a store, change the
conflict rules or the lock order, add a dependency, prune rejected reports (docs/offline-sync.md says they stay).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Logout, nothing pending | pending 0, attention 0 | snapshot + synced reports + meta deleted, session cleared, login page | storage error ignored, session still cleared |
| Logout, pending, online, fresh token | 2 queued, server 201 | "sending before logout" dialog, both synced, cleanup, login page says "2 reports sent" | - |
| Logout, partial | 2 queued, first 201, second 500 | first synced and deleted, second kept queued, confirm dialog "sync incomplete, 1 kept" | logout on confirm keeps the row |
| Logout offline | `navigator.onLine` false | no request, confirm dialog, rows kept, meta kept | - |
| Logout, token expired | `tokenIsFresh` false | no request, confirm dialog, rows kept | - |
| Flush timeout | transport never answers | after 30 s the confirm dialog shows what is left; the `syncing` row stays, next start requeues it | no throw |
| Token expiry while logged in | timer at `exp`, or focus after `exp` | session cleared, worker stopped, login page shows "session expired" + pending notice | no request with the old token |
| 401 on the interceptor | manager or lookup request | session cleared with reason expired, hard navigation as today | - |
| Other courier signs in | scope A has tasks, synced + queued reports, draft | A's tasks, details and synced report deleted; queued report, draft and meta kept; login notice still names A | - |
| Same courier back | A's rows parked in `auth` or `queued` | `startSync` requeues and sends them, same operation ids, server replays duplicates | - |
| Logout during a pass | request in flight | result dropped, row stays `syncing`, cleanup leaves it, next start resends the same id | - |

## Code Map

- `client/src/utils/service.ts` -- token keys, the 401 interceptor; gets `clearSession` / `takeSessionEnd`
- `client/src/utils/auth.tsx` -- `AuthProvider`; `logout(end?)` goes through `clearSession`, the expiry watcher lives here
- `client/src/courier/offline/identity.ts` -- `decodeJwt`, `tokenIsFresh`; gets `watchTokenExpiry`
- `client/src/courier/offline/store.ts` -- data layer; gets `clearSyncedData(scope)` and `clearForeignScopes(current)`
- `client/src/courier/offline/sync.ts` -- worker; `startSync` sweeps foreign scopes, new `flushForLogout()`
- `client/src/courier/CourierLayout.tsx` -- the logout button and confirm dialog
- `client/src/courier/components/SyncStatusBar.tsx` -- the "sign in again" chip, same leave path
- `client/src/pages/LoginPage.tsx` -- shows the session end note
- `shared/i18n/he.ts` -- new keys under "offline courier: login and updates"
- `server/src/e2e/offline-sync.e2e.spec.ts` -- expired token e2e
- `docs/offline-sync.md` -- the two paragraphs that say the database keeps everything

## Tasks & Acceptance

**Execution:**
- [ ] `client/src/utils/service.ts` -- `SessionEnd = { reason: "expired" | "logout"; sent?: number; kept?: number }`, `clearSession(end?)` (removes both keys, writes the note to `sessionStorage` `es_session_end`), `takeSessionEnd()` (read and remove); the interceptor calls `clearSession({ reason: "expired" })` -- one place clears the session
- [ ] `client/src/courier/offline/identity.ts` -- `watchTokenExpiry(onExpired, now?)`: fires at `exp` (timer, capped at 2^31-1 ms) and on `focus` / `visibilitychange` when the stored token is no longer fresh, at most once; returns a dispose function; a token without `exp` never fires -- tablets sleep, timers drift
- [ ] `client/src/utils/auth.tsx` -- `logout(end?)` calls `clearSession(end)`; an effect on `user` runs `watchTokenExpiry(() => logout({ reason: "expired" }))` -- the courier layout unmounts through `RequireRole` and stops the worker as it does for a logout in another tab
- [ ] `client/src/courier/offline/store.ts` -- `clearSyncedData(scope)`: one `writeTx` over tasks, task_details, reports, drafts, meta; deletes the scope's tasks and details, its `synced` reports, and meta when no report and no draft remain; resolves `{ reports: n, drafts: n }` kept. `clearForeignScopes(current)`: `clearSyncedData` for every meta scope except `current`
- [ ] `client/src/courier/offline/sync.ts` -- `startSync` calls `clearForeignScopes(s)` after the `syncing` recovery; `flushForLogout(timeoutMs = 30_000)`: no scope → `{ sent: 0, pending: 0, attention: 0 }`; else `retryAll`, race `kickSync("retry")` against the timeout, re-read the reports, count `sent` (rows pending before, `synced` now), `pending` (queued / syncing / auth) and `attention` (`needsAttention`); never throws
- [ ] `client/src/courier/CourierLayout.tsx` -- `signOut`: nothing pending → `leave`; pending and `navigator.onLine` and `tokenIsFresh` → syncing dialog (cancel allowed, a late result is ignored), then `leave` when nothing is left, else the confirm dialog with `logout_sync_incomplete` above the count; otherwise the confirm dialog as today. `leave(sent)`: `stopSync()`, `await clearSyncedData(scope).catch(() => {})`, `logout({ reason: "logout", sent, kept })`, navigate
- [ ] `client/src/courier/components/SyncStatusBar.tsx` -- `reauth` uses the same stop → clear → logout order
- [ ] `client/src/pages/LoginPage.tsx` -- `takeSessionEnd()` once on mount; `session_expired` alert for expired, `logout_synced_count` / `_one` when `sent > 0` and `kept === 0`; the existing pending-work notice covers the kept case
- [ ] `shared/i18n/he.ts` -- `logout_syncing`, `logout_sync_incomplete`, `logout_synced_count`, `logout_synced_one`, `session_expired`
- [ ] `client/src/courier/offline/store.spec.ts` -- `clearSyncedData` keeps each non synced state and the draft, deletes tasks / details / synced, deletes meta only when empty; `clearForeignScopes` leaves the current scope alone
- [ ] `client/src/courier/offline/sync.spec.ts` -- flush: all sent, partial (500), network failure, expired token sends nothing, timeout with a held request then the next start resends the same operation id, `clearForeignScopes` on start keeps the other account's queued row and its login notice
- [ ] `client/src/courier/offline/identity.spec.ts` -- `watchTokenExpiry` with fake timers: fires at exp, fires on focus after exp, never for a fresh token or one without exp, dispose cancels
- [ ] `client/src/utils/service.spec.ts` -- `clearSession` / `takeSessionEnd` round trip and that the note is consumed once
- [ ] `server/src/e2e/offline-sync.e2e.spec.ts` -- a token signed with `expiresIn: -60` through the app's `JwtService` → 401, no attempt and no operation row; the same `operation_id` under a fresh token → 201 once, then `replayed: true`, one attempt row
- [ ] `docs/offline-sync.md`, `README.md` -- the logout and token paragraphs, the test counts

**Acceptance Criteria:**
- Given two queued reports and a reachable server, when the courier taps logout, then both are acknowledged before the session ends and the login page says two reports were sent.
- Given a queued report and no network, when the courier confirms logout, then the row is still `queued` under its scope after the page reloads and the login page names the account.
- Given a token past `exp`, when the tab regains focus, then the session is gone, no request carried the old token, and the login page says the session expired.
- Given scope A with a `synced` and a `queued` report, when scope B's worker starts, then A's `synced` report and tasks are gone, A's `queued` report and meta remain, and B sends nothing of A.

## Verification

**Commands:**
- `cd client && npx tsc --noEmit` -- expected: no output
- `cd client && npm test 2>&1 | tail -40` -- expected: all files pass, count up from 96
- `cd server && npx tsc --noEmit -p tsconfig.json` -- expected: no output
- `cd server && docker compose up -d && npm test 2>&1 | tail -40` -- expected: all suites pass, count up from 176

**Manual checks:** none required; the built app is not needed for these paths.

## Design Notes

Why no cleanup in `AuthProvider`: it has no scope and the manager has no database. The courier layout owns the
stop → clear → logout order; the expiry and the 401 path skip the cleanup on purpose and the next courier start sweeps
instead, which also covers a closed browser. Drafts are kept: they are unsent work, scoped, and nothing re-downloads them.

## Implementation Notes

**2026-10-13, implemented.** Every execution task done as written; the server code is untouched (only its e2e spec grew).

Verified: `cd client && npx tsc --noEmit` clean; `cd client && npm test` 110 passed in 12 files (was 96 in 11); `cd server && npx tsc --noEmit -p tsconfig.json` clean; `cd server && npm test` 177 passed in 18 suites (was 176; 80 unit, 97 e2e). README counts updated to 287 (177 server, 110 client). No `npm install` was needed.

Decisions taken while implementing:
- `clearSyncedData` also resets the snapshot fields of a meta row it keeps (`refreshed_at: null`, `ready: false`, `last_error: null`, `sync_lease: null`; the names and `persistent` stay). The rows the meta described are gone, and without the reset the same courier's next login would show an empty board that claims to be ready until the refresh lands (offline: for good). Deletion of the row when nothing is left is as planned.
- After the cleanup the store emits `tasks` and `reports` for the scope; the hooks re-read on any kind of their scope and the worker ignores events of other scopes, so two emits are enough.
- `SyncStatusBar.reauth` ends the session with `reason: "expired"`: the chip is there because the server refused the token, so the login page says "תוקף ההתחברות פג" next to the pending notice. The order is the logout button's: stop, clear, logout, navigate.
- `flushForLogout` returns the worker's last status counts when its storage read or write throws (never throws, as required). `PENDING_STATES` in `sync.ts` now feeds both `refreshCounts` and the flush.
- `CourierLayout` bumps the flush run counter in the effect cleanup as well as on cancel: a flush result that lands after a scope change or unmount (an account switch made in another tab) must neither clear the new account's session nor sweep the wrong scope.
- `LoginPage` consumes the note in an effect that sets state only when a note exists, so a double effect run (StrictMode, currently commented out in `main.tsx`) cannot lose it.
- `ManagerLayout` keeps calling `logout()` without an argument; `clearSession()` without a note removes a stale one.
- The e2e signs the expired token with `app.get(JwtService).sign(payload, { expiresIn: -60 })`; `JwtModule` is exported by `AuthModule`, so no test module changes.
- `identity.spec.ts` pins `document.visibilityState` with `Object.defineProperty` (jsdom's value depends on `pretendToBeVisual`) and drives the "slept through exp" case through the injectable `now` while the fake timer never fires.

Files touched: `client/src/utils/service.ts`, `client/src/utils/auth.tsx`, `client/src/courier/offline/identity.ts`, `client/src/courier/offline/store.ts`, `client/src/courier/offline/sync.ts`, `client/src/courier/CourierLayout.tsx`, `client/src/courier/components/SyncStatusBar.tsx`, `client/src/pages/LoginPage.tsx`, `shared/i18n/he.ts`, `client/src/courier/offline/identity.spec.ts` (new), `client/src/courier/offline/store.spec.ts`, `client/src/courier/offline/sync.spec.ts`, `client/src/utils/service.spec.ts`, `server/src/e2e/offline-sync.e2e.spec.ts`, `docs/offline-sync.md`, `README.md`.

Surprises: none. Behaviour change worth a reviewer's eye: with the watcher, an expired token now ends the session on the client (the old doc said the screens stay readable with a dead token); the local data itself is kept and comes back after a login of the same account, the doc paragraph was rewritten for that.

## Plan Change Log

**2026-10-13, after review.** The order in `leave` / `reauth` is now stop → session cleared → cleanup (the plan said stop → cleanup → logout): a refresh started by the flush's own success could land after the delete and rewrite the snapshot, so `clearSyncedData` waits for a refresh in flight and the session is gone before the delete, which refuses any new refresh up front. `clearSyncedData` emits nothing. `signOut` reads `countReports(scope)` from the database instead of the worker's status, runs the pass for rejected reports too (their evidence), and marks the dialog "incomplete" only when reports are still to send. The note carries `sent` only; the login page shows the sent count whenever it is above zero. `watchTokenExpiry` arms its timer again when a check finds the token still fresh. Added specs: `CourierLayout.spec.ts`, `utils/auth.spec.ts`, one flush-during-a-pass case in `sync.spec.ts`. README open decision 15 records the offline-at-expiry trade-off.

## Review Triage Log

**2026-10-13, edge case hunter (6) and verification gap (5 gaps + 4 other).**

- Fixed: refresh from `afterSynced` landing after the cleanup (edge 1) → wait for the in-flight refresh, session cleared before the delete, no emits.
- Fixed: syncing dialog surviving an account switch in another tab (edge 2) → the effect cleanup closes both dialogs.
- Fixed: the expiry timer not re-armed when a check finds the token fresh (edge 4) → `arm()` on every fresh check.
- Fixed: no "N sent" feedback when only rejected reports remain (edge 6 claim, gap other 2) → the alert no longer depends on what stayed; `kept` dropped from the note.
- Fixed: `signOut` deciding on stale worker counts (gap other 1, also found on my own read) → `countReports` from the database; `CourierLayout.spec.ts` pins it with a status that always says zero.
- Fixed (gaps 1, 2, 3): the logout flow, the flush during a running pass and the provider wiring now have specs.
- Deferred: a second tab of the same account holding the lock makes the flush return at once (edge 3, gap other 3); no data is lost, documented as a known limit in docs/offline-sync.md.
- Deferred (gaps 4, 5): a render test of the login page alerts and of the 401 interceptor note; thin readers of tested helpers, as the reviewer said.
- Refuted as a defect, recorded as a product question (edge 5, gap other 4): ending the session at `exp` while offline is what the task asked for; the trade-off is README open decision 15.
