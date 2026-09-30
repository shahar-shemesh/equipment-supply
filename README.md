# Digital equipment issuance system

A web system for issuing and delivering equipment, built for the Israeli Ministry of Defense. It replaces a paper process: SAP creates an issuance document, a warehouse manager assigns it to a courier, the courier delivers it from a tablet, collects the recipient's signature, and the outcome goes back to the manager and (later) to SAP.

Two user interfaces share one backend:

- **Warehouse manager**, desktop first: the issuances board, assignment, priorities, self pickup, deletion.
- **Courier**, tablet first: the delivery board, the delivery report with a per item result, the signature.

The UI is Hebrew and right to left. The Figma exports the screens follow live under `design/` (not committed, see [Design references](#design-references)). The original Hebrew specification and the running notes written during development are in [docs/README.he.md](docs/README.he.md).

## Status

What runs today:

- Manager board with search, filters, paging, bulk assign and mark urgent, the issuance detail dialog (priority, delivery date, self pickup, delete with a reason), courier management (add, edit, delete), reports placeholder.
- Courier board with tabs and search, grouped cards for the same address, the delivery report (per item delivered / not delivered with a reason, recipient, signature), lookup by issuance number.
- Courier work without a network: the task list is downloaded to the device, drafts and signed reports live in IndexedDB, a sync worker sends queued reports with an operation id the server treats as idempotent, a service worker serves the built app offline. See [Offline courier work](#offline-courier-work).
- NestJS API with role based access, server side validation of the delivery report, status transition rules, row locking for concurrent requests, idempotent delivery reports.
- PostgreSQL schema with one migration, a seed with 30 sample issuances, 118 tests (69 server, 49 client).
- Responsive layout for phone, tablet and desktop.

What does not exist: the SAP interface, QR camera scanning, history and analytics screens, PDF / SMS / email confirmations, the courier Excel import, production authentication, synchronization while the app is closed (no Background Sync), raster and iOS home screen icons, any way for a manager to apply, merge or reassign a rejected report (the manager can read it and mark it reviewed, see [Unresolved reports](#unresolved-reports)). Details under [Sample data and what is missing](#sample-data-and-what-is-missing).

## Stack

| Part | Technology |
| --- | --- |
| `client/` | React 18, TypeScript, Vite, MUI 5 with an RTL emotion cache, SCSS, react-router 6, react-i18next, `idb` for IndexedDB, `vite-plugin-pwa` (workbox) for the service worker, vitest + jsdom + fake-indexeddb for the tests |
| `server/` | NestJS 10, TypeORM 0.3 (one hand written migration), PostgreSQL 16, JWT (`@nestjs/jwt`), Jest + supertest |
| `shared/` | Enums and interfaces (`@core.ts`), helpers (`@utils.ts`), the Hebrew dictionary (`i18n/he.ts`). Imported by both sides |
| root | `docker-compose.yml` for PostgreSQL |

## Repository layout

```
client/src
  components/      Logo, StatusBadge
  courier/         CourierLayout, pages (DeliveryBoard, TaskDetailPage, ReportDetailPage), components (TaskCard, ItemReportCard, SignaturePad, FindIssuanceDialog, SyncStatusBar, PendingReportsDialog, SyncChip)
  courier/offline/ the local data layer: db (IndexedDB layout), store (reads, drafts, reports, overlay, the evidence axis), sync (the worker: reports, evidence uploads, review status), useCourierData (hooks), identity, storage, uuid, sw (service worker registration), the vitest specs
  manager/         ManagerLayout, pages (IssuancesBoard, CouriersPage, ConflictsPage, ReportsPage), components (IssuancesTable, IssuanceCard, BoardFilters, SideWidgets, AssignCourierDialog, IssuanceDetailDialog, CourierDialog, ConflictDetailDialog)
  pages/           LoginPage
  routers/         AppRouter (two route trees: /manager and /courier)
  styles/          _breakpoints, _basic, _layouts, _layout-manager, _layout-courier, _manager, _courier, _badges, _login
  theme/           RtlTheme (MUI theme + rtl cache + full screen dialogs on phones)
  utils/           service (axios), auth (context), format, useBreakpoint
  assets/          mod.svg (the logo)
  test/            vitest setup (fake-indexeddb), fixtures, the virtual:pwa-register stub
client/public      icon.svg (the PWA icon)
client/vitest.config.ts   the test runner config, separate from vite.config.ts so the PWA plugin stays out of the tests
server/src
  auth/            dev-local login, jwt guard, roles
  issuances/       manager side: board queries, assign, update, delete, transition rules
  couriers/        courier management: list with open task count, add, edit, soft delete, form validation
  delivery/        courier side: my tasks, delivery report, payload validation, operation.ts (operation id, payload hash, client time); conflicts.service / conflicts.controller: rejected reports kept as evidence and the manager review
  entities/        TypeORM entities
  migrations/      hand written migrations (OfflineSync, ConflictEvidence)
  seed/            sample data
  e2e/             database backed tests
  data-source.ts   the DataSource the TypeORM CLI uses for migrations
  env.ts           the LOCAL / production switches
shared/            @core.ts, @utils.ts, i18n/
design/            Figma exports (git ignored)
docs/              README.he.md (original spec + Hebrew notes)
```

## Running locally

Requirements: Node 20, Docker Desktop.

```bash
docker compose up -d
```

```bash
cd server && npm install && cp .env.example .env && npm run seed && npm run start:dev
```

```bash
cd client && npm install && npm run dev
```

Open http://localhost:5173. Vite proxies `/api` to the NestJS server on port 3000. PostgreSQL is exposed on host port 5433 (5432 was taken on the machine this was built on; change it in `docker-compose.yml` and `server/.env` together). The dev server has no service worker (it is registered from the production build only); the local data layer and the sync worker run there like anywhere else, offline reload does not. To see the whole thing, including offline reload, use the build, see [HTTPS and testing the build](#https-and-testing-the-build).

`npm run seed` truncates every table and inserts the sample set again, run it whenever you want a clean start. On a LOCAL machine the schema is built from the entity classes with TypeORM `synchronize` (`DB_SYNCHRONIZE=true`); everywhere else it moves with migrations, see [Schema upgrade](#schema-upgrade).

Development accounts, all with the password `1234`:

| Username | Role | Sees |
| --- | --- | --- |
| `manager`, `manager2` | warehouse manager | issuances board, couriers, reports |
| `courier1`, `courier2`, `courier3` | courier | delivery board and the delivery report |

The login page lists them as long as the server runs with `ENVIRONMENT=LOCAL`.

`.claude/launch.json` has `server` and `client` entries for the desktop app's preview.

## Environment switches

`server/src/env.ts` is the one place that decides whether this is a developer's machine. `ENVIRONMENT=LOCAL` is an explicit opt in; anything else, or `NODE_ENV=production`, turns every developer convenience off:

| Switch | LOCAL | Anything else |
| --- | --- | --- |
| `JWT_SECRET` | the dev default is accepted | required and must differ from the default, otherwise the server refuses to start |
| `AUTH_STRATEGY=dev-local` | works | refused at startup unless `ALLOW_DEV_AUTH=true` (a test box with no identity provider yet, logged loudly) |
| `GET /api/auth/dev-accounts` | returns the seeded accounts | always empty |
| `npm run seed` | needs `ALLOW_DESTRUCTIVE_SEED=true` | refused |
| TypeORM `synchronize` | needs `DB_SYNCHRONIZE=true` | off |
| Schema changes | `synchronize` applies them on start; `npm run migration:run` is then a no-op (the migration has `IF NOT EXISTS` guards) | `npm run migration:run` or `migration:run:prod` before the new build starts, see [Schema upgrade](#schema-upgrade) |

`server/.env.example` documents every variable.

## Schema upgrade

Migrations arrived with the offline work and stay minimal: one hand written class per schema change under `server/src/migrations/`, a `DataSource` for the TypeORM CLI in `server/src/data-source.ts` (same `.env` and connection options as the app, `synchronize` always off there), and four scripts in `server/package.json`:

| Script | What |
| --- | --- |
| `npm run migration:run` | applies the pending migrations from the TypeScript sources (ts-node) |
| `npm run migration:run:prod` | the same from `dist/` (`npm run build` first), for a box without devDependencies |
| `npm run migration:revert` | reverts the last applied migration |
| `npm run migration:show` | lists the migrations and marks the applied ones |

Run `migration:run` (or `migration:run:prod`) before starting a new server build everywhere except a LOCAL machine with `DB_SYNCHRONIZE=true`, where `synchronize` adds the same objects on start and the migration becomes a no-op. The application never runs migrations by itself (no `migrationsRun`): a schema change is a deliberate step, not a side effect of a restart. TypeORM keeps the applied list in a `migrations` table it creates on the first run.

Two migrations so far, both guarded by `IF NOT EXISTS` and reversed in `down`, both adding objects only (nothing is wiped, the tables of the previous version are assumed to exist), both with column types and constraint names that match what `synchronize` generates from the entities, so a LOCAL database that ran either path shows no diff to the other:

- `OfflineSync1790600000000`: `issuances.revision`, `delivery_attempts.client_reported_at` and the `delivery_operations` table with its unique index.
- `ConflictEvidence1790800000000`: the `delivery_conflicts` table with its unique index on (`user_id`, `operation_id`) and the foreign key to `delivery_tasks`. The constraint names come from TypeORM's own naming strategy inside the migration.

## Authentication

Only development authentication exists: username and password against the seeded `users` table, a JWT in localStorage, a guard that checks the role per route. It lives in `server/src/auth` and is marked as such in the code and on the login page.

The production identity source is not decided (the information architecture diagram asks: email and password, or national identification?). No 2FA, national identity flow or SSO was built on a guess. When the decision comes, the parts that change are token issuing in `auth.service.ts` and `LoginPage.tsx`; the guard, the roles and the screens stay.

## Domain model

The spec and the designs use "issuance" (הנפקה) for several different things, so the schema separates them:

- **Issuance** (`issuances`): the SAP document. Who the customer is, where it goes, the priority. Exists whether or not anyone was sent to deliver it. Its status mirrors the latest delivery outcome. Its `revision` is the concurrency token of an offline delivery report, see [What invalidates a report](#what-invalidates-a-report).
- **Issuance item** (`issuance_items`): one product line of the document, with catalog number, station number and serial. The courier answers delivered / not delivered per line, which is where partial delivery comes from.
- **Delivery task** (`delivery_tasks`): "go deliver issuance X", one issuance handed to one courier for a date. This is what the courier's board lists. Reassigning cancels the old task and creates a new one, so the history of who had it stays.
- **Courier** (`couriers`): whoever drives the equipment. Separate from `users`: a courier exists before anyone gives them a login (the sample data has two external companies without one).
- **Delivery attempt** (`delivery_attempts` + `delivery_attempt_items`): what the courier reported at the door: who received, the signature, a result and reason per item. Today one attempt closes a task; the table is ready for several attempts per task if "try again tomorrow" becomes a rule. `reported_at` is the server receipt time; `client_reported_at` is the device clock when the courier tapped send, kept separately because it is untrusted and can be hours earlier after an outage.
- **Delivery operation** (`delivery_operations`): the receipt of a report sent with an operation id: the account, the task, the attempt it created, a hash of the validated payload and the exact result body. The same id from the same account is answered with the stored result instead of a second attempt. Only successful reports get a row, and the row goes in the same transaction as the attempt.
- **Delivery conflict** (`delivery_conflicts`): a report the attempts route refused with a 409, handed over by the tablet as evidence: the account and courier (from the token), the original task and issuance, the revision the report was written against, the answers, the recipient, the signature, the device time, a hash of the content, the rejection code and the authoritative state the server saw when it recorded it (`observed`). Review fields (`review_status`, `reviewed_by`, `reviewed_at`, `review_note`, `review_version`) are the manager's acknowledgment and sit apart from the submitted content, which never changes. Nothing here is a delivery: no attempt, no task close, no issuance status, no revision bump. Unique per (account, operation id).

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

**Delivery report validation** (`server/src/delivery/attempt.validation.ts`): exactly one answer per item, no unknown or duplicate item ids, `delivered` must be a real boolean, a reason from the closed list plus details up to 100 characters only on a line that was not delivered, another recipient needs name, numeric id and phone, the signature must be a real PNG (magic bytes checked) up to 1 MB. The outcome is derived from the validated answers, never taken from the body. The JSON body is capped at 2 MB.

**Concurrency.** Every change to an issuance or its tasks locks the issuance row first (`SELECT ... FOR UPDATE`), always in the same order: issuance, then task. Two reports on the same task, or a report racing a reassignment, run one after the other and the second gets a 409. Closing a task is a conditional update on `status = pending` inside the same transaction, so nothing closes twice even without the lock. Related status changes are written together or not at all.

**Idempotent delivery reports.** A report that carries an `operation_id` (every report the tablet sends, see below) is looked up under the same locks before anything else: a stored operation of the same account with the same task and the same payload hash returns the stored result with `replayed: true`, even when the task closed meanwhile (that is the "commit succeeded, response lost" case). The same id with a different task or content is a 409 `operation_reused`. The lookup is scoped by the account (`user.sub`), so another account using the same id never sees the first account's result or signature. The receipt row is written in the same transaction as the attempt and the status changes; a rejected report leaves no row. A unique index on `(user_id, operation_id)` backs this up: a second identical request that gets past the lock hits the index, and the service answers it with the row the first request committed. Requests without an operation id behave exactly as before.

## Offline courier work

Login needs the server. From then on the courier screens run from local data, with or without a network: the board with its tabs, counters, search and grouping, the task screen with prev / next, the manual lookup, the report form and the send button. The manager side has no offline mode.

**What is downloaded.** The complete task list, `GET /delivery/tasks?tab=all` with no search, which already carries the issuance and its items for every task, so a pending task the courier never opened has everything the report form needs. The list is replaced whole in one transaction after a shape check: the rows must be an array of tasks with numeric ids and `counts.all` must equal the number of rows, the cheap proof that the response is complete and unfiltered. A failed or malformed refresh keeps the previous snapshot, records the error and shows "הרענון נכשל" on the board. The report details of a done task (the item answers and the signature; the list rows have neither) are on the device only when the task was opened online on this device (`GET /delivery/tasks/:id` is cached then) or reported from this device; otherwise the task screen shows "פרטי הדיווח לא הורדו למכשיר" instead of the report block.

A refresh runs when the courier screens open, on the רענון button in the status strip, after a sync pass that delivered at least one report, and, throttled, when the app comes back to the foreground or the network returns (at most once a minute; the board also refreshes on mount when the snapshot is older than five minutes). The strip says "מכין נתונים לעבודה ללא רשת..." until the first snapshot is stored and "מוכן לעבודה ללא רשת, עודכן ב-HH:MM" after that.

**The local database.** IndexedDB `es-courier`, version 1, through the `idb` library (`client/src/courier/offline/db.ts`):

| Store | Key | Holds |
| --- | --- | --- |
| `meta` | `scope` | readiness, the last refresh time, the last error, the persistent storage answer, the cross tab lease |
| `tasks` | `[scope, task_id]` | the rows of the last list download plus their position |
| `task_details` | `[scope, task_id]` | the detail body of done tasks that were opened online |
| `drafts` | `[scope, task_id]` | the form of a report still being filled: answers, recipient, signature PNG and strokes |
| `reports` | `[scope, operation_id]` | signed reports waiting for the server or rejected by it, with their sync state and the server's acknowledgment |

`scope` is `<users.id>:<couriers.id>`; every key starts with it, every function of the data layer takes it and throws on a null one, so nothing is ever stored under an undefined account. Two accounts on one device never see each other's rows. The one cross scope read is the list of other accounts with queued work, used for the notices. Logout clears localStorage only, the database keeps everything. A future schema version adds stores and indexes in place and never deletes a store, because a queued report may be sitting in it.

**Four kinds of data.** They never mix: the server snapshot (`tasks`, `task_details`, replaced on every refresh), the draft (`drafts`, the courier's unsent work), the immutable report (`reports`, frozen the moment the courier taps send; only its sync state and acknowledgment change afterwards), and the display, computed on read: a pending snapshot task with a report in queued / syncing / synced / auth is shown as done with the local attempt (answers, recipient, signature), its issuance status is the report's outcome and the board counts it under הושלם; a task whose report was rejected stays as the snapshot says and gets an attention chip; a done snapshot task keeps the chip for every state, so the chip survives a refresh. The tab counters are computed over the whole overlaid set, not the search results, as on the server.

**Drafts.** Every change of the report form is written to the device 600 ms after the last keystroke, and immediately when the page is hidden, unloaded or left. The indicator says "טיוטה נשמרה במכשיר" only after the transaction committed. Completed signature strokes are part of the draft and the pad redraws them on the next open (a single tap is a dot, drawn, stored and submitted the same way). A draft write is refused once a report for that task exists in an active state, so a late timer cannot bring a draft back after send. "ניקוי הטיוטה" clears both the draft and the form.

**Sending a report.** The same path online and offline: validate, generate an operation id (`crypto.randomUUID`, or a v4 from `getRandomValues` on plain http), write the report and delete the draft in one transaction, and only then update the screen and wake the worker. A task with an active report refuses a second one ("לדוח של הנפקה זו יש שליחה שממתינה לשרת"). A failed local write shows the storage reason (quota, storage unavailable, or a plain failed save) and no saved state. Two different endings: "הדוח נשלח" only when the server's acknowledgment arrives within four seconds, otherwise "הדוח נשמר במכשיר וישלח לשרת כשיהיה חיבור" (also straight away when the device is offline or waiting for a login). A report the server rejects inside those four seconds keeps the form on screen with its answers and an alert that says what the server said.

**Sync states** (`ReportSyncState` in `shared/@core.ts`), a separate axis from the business status, which is the report's outcome:

| State | Meaning | Retry |
| --- | --- | --- |
| `queued` | saved on the device, waiting for the network or for its backoff to pass | automatic, and "נסה שוב" resets the backoff |
| `syncing` | a request is in flight | |
| `synced` | the server acknowledged it, the acknowledgment is stored next to the report | |
| `auth` | the server said 401, or the stored token is missing, expired or belongs to another account | after a login of the same account |
| `invalid` | 400, the server rejected the payload; the message is kept | no, review is manual |
| `forbidden` | 403 or 404, the task is not this courier's any more | no |
| `conflict` | 409, the task changed under the report; the code says how (see [Unresolved reports](#unresolved-reports)) | no |

Only `queued` and `auth` can be retried by hand. Network failures, timeouts, 408 / 425 / 429, 5xx and a 2xx whose body does not look like a result go back to `queued` with a backoff (30 s doubling to 15 min, plus up to 30% jitter); a reconnect, the app opening and a login clear the backoff of network failures, statuses the server actually answered keep theirs.

**The sync worker** (`client/src/courier/offline/sync.ts`) runs while the courier screens are open, one per account, and only in the foreground. There is no Background Sync and nothing is promised while the app or the browser is closed: reports go out the next time the app is open with a network and a valid login. It runs a pass on start, after every send, on manual retry, when the network comes back, when the tab becomes visible or focused, when another tab asks for one, and every 60 s while something is queued or the last request failed (`navigator.onLine` is treated as a hint, a real request is the proof). Requests time out after 20 s. Reports go out in enqueue order, one at a time; a report that did not reach `synced` stops the later reports of the same task in that pass and the other tasks continue. One tab sends at a time: the pass takes a Web Lock (or a lease in `meta` where Web Locks do not exist), never for the worker's lifetime, and a tab that could not get it asks the holder to run a pass over a `BroadcastChannel`, which also tells the other tabs to re-read after every local write. A result that arrives after logout or after a switch to another account is dropped. After the reports of a pass the worker uploads the evidence of rejected reports and reads the review status of the ones the server already has, see [Unresolved reports](#unresolved-reports).

**Persistent storage.** `navigator.storage.persist()` is asked once per session and the answer is shown at the bottom of the pending reports dialog. It is a request, not a guarantee: "clear site data", a manual "clear browsing data" or an eviction the browser decides on anyway still delete everything, including queued reports.

**Authentication and the 12 hour token.** The JWT lasts 12 hours; the local data does not expire with it. With an expired token the board, the tasks, the drafts and the saved reports stay readable and a report can still be signed and queued. Sending needs a valid token of the same account: a 401, or a token that is missing, expired or belongs to someone else, parks every queued report in `auth` without sending anything, the strip shows "נדרשת התחברות מחדש" and tapping it stops the worker, clears localStorage and opens the login page. A new login of the same account picks the queue up on its own. Another account signing in on the same device sees "במכשיר יש N דוחות של X שטרם נשלחו לשרת" on the login page and in the strip, and its worker never sends them: the token's `sub` is compared with the report's user id before every request, and a background refresh or detail fetch of a scope is refused under another account's token, so a tab left open on the first account cannot overwrite that account's snapshot. A tab follows a login or logout made in another tab (the `storage` event) and restarts its worker for the new account. Logging out with queued or rejected reports asks for confirmation first and says the reports stay on the device.

**Status strip.** Under the courier header: the connection (מחובר / אין חיבור לרשת / השרת לא זמין כרגע), the dataset (ready and the refresh time, or preparing, or never downloaded), the רענון button, the reauth action when needed, the queue ("דוח אחד ממתין לסנכרון", "מסנכרן...", "כל הדוחות התקבלו בשרת", or "דוחות שנשמרו במכשיר" to open the list), the attention count, the "גרסה חדשה" button when a new build is waiting, and two notices: another account's queued work, and "עבודה ללא רשת לא זמינה בכתובת הזו" on a page that is not a secure context. Cards on the board carry a small chip next to the status badge for a task with a local report (נשמר במכשיר, התקבל בשרת, or the rejection).

### Unresolved reports

A report the server rejected (`invalid`, `forbidden`, `conflict`) stays on the device indefinitely: nothing prunes it, there is no dismiss action, and a refresh never touches it, even when its task left the list. It is listed under דורשים טיפול in the pending reports dialog and readable in full at `/courier/reports/:operationId`: customer, address, every item answer with its reason, the recipient, the signature, the sync state and the server's message, plus "ההנפקה כבר לא מופיעה בלוח שלך" when the task is gone.

A `conflict` (a 409 from the attempts route) is also handed over to the server as evidence, without ever being applied. Three things are kept apart, on the tablet and in the wording:

1. A delivery report that was accepted and applied: `ReportSyncState.synced`, a row in `delivery_operations`, an attempt, a closed task.
2. A rejected report preserved on the server for manager review: `ReportSyncState.conflict` with `EvidenceUploadState.received` or `reviewed`, a row in `delivery_conflicts`, no attempt, no change to the task or the issuance.
3. A rejected report still stored only on the device: `ReportSyncState.conflict` with `EvidenceUploadState.none`, `pending`, `uploading` or `failed`. Until the upload lands it depends on the device's storage like any other local row.

The evidence upload runs in the sync worker's pass, right after the delivery reports, through `POST /delivery/tasks/:id/conflicts` with the same body the attempts route refused (`operation_id`, `issuance_revision`, `client_reported_at` included). It reuses the queue's rules: the current token must belong to the report's account, a network failure or a 5xx backs off (30 s doubling to 15 min) and is cleared by a reconnect, a 401 pauses without touching the row, one failed upload never holds a delivery report back, one tab sends at a time. 400, 403, 404 and 409 answers mark the upload `failed` and keep the row for attention; "שליחה חוזרת לבדיקה" sends it again by hand. The rejected delivery report itself is never resent as a way of uploading evidence. Conflicts recorded before this version (rows without an `evidence` field) are uploaded like any other; the IndexedDB layout did not change for it (still version 1, the field is optional). "התקבל בשרת לבדיקת המנהל" appears only after the receipt (`kind: "conflict_recorded"`, with `conflict_id` and `received_at`) was written to the local row. On every later pass the worker asks `GET /delivery/conflicts?operation_ids=` for its received rows and moves the ones a manager reviewed to "נבדק על ידי המנהל ב-...", which also takes them out of the attention count (they stay listed under נבדקו על ידי המנהר, and on the device). The Hebrew lines, in order: "הראיות שמורות רק במכשיר הזה", "ממתין לשליחה לבדיקת המנהל", "נשלח לבדיקת המנהל...", "התקבל בשרת לבדיקת המנהל ב-...", "נבדק על ידי המנהל ב-.... דוח המסירה לא הוחל על המשלוח.", "שליחת הראיות לבדיקה נכשלה: ...".

On the server the upload is validated like a delivery report (a real PNG up to 1 MB, the 2 MB body, recipient rules, one boolean answer per line with a reason only on a refused line) except that the answers are not matched to the issuance's current lines: they are what was signed, and the lines may have changed since. It is then decided under the same locks as the attempts route (issuance, then task). A stored success for that operation wins and is returned as `{ kind: "delivered", ...IAttemptResult, replayed: true }`: a device that lost a 201 never files a false conflict. A stored conflict replays its receipt. A report that could still be applied (task pending, issuance assigned, revision current) is refused with 409 `not_a_conflict` and nothing is recorded. Anything else is recorded once with the state observed at that moment (`observed`: task status, issuance status and revision, the open task and its courier if any, the attempt that closed the task if any); the same id with other content is 409 `operation_reused`; a unique index on (`user_id`, `operation_id`) and the same rollback safe re-read as `delivery_operations` cover two concurrent uploads. Unauthenticated, wrong role, another courier's task or a malformed body never produce a row (401, 403, 404, 400). Signatures are never in list responses or log lines.

Managers read the evidence under דוחות לבדיקה (`/manager/conflicts`, `GET /conflicts` paged, pending or reviewed): issuance, courier, reason, device time, server time, review. Opening a row (`GET /conflicts/:id`) loads the signature and the answers next to two states: the one recorded at rejection and the one right now (issuance status and revision, every task of the issuance with its courier, the attempt that really closed the rejected report's task, without its signature). "סימון כנבדק" (`POST /conflicts/:id/review`) needs a note and the `review_version` the screen loaded; it stores the reviewer and the time and nothing else. A row another manager already reviewed answers 409 `review_conflict` with that review instead of taking a second note, a stale version is refused the same way, and the same manager repeating the same note gets the same answer. The review changes neither the task, the attempt, the issuance nor the submitted evidence, and is labelled as a review, never as an approval: there is no force apply, merge, reassignment or reopening here. The courier sees only their own rows' status (`GET /delivery/conflicts`), never the note, and never another courier's evidence. Rows in `delivery_conflicts` are never deleted by the application.

The conflict codes and what the tablet says:

| `code` | When | Hebrew |
| --- | --- | --- |
| `task_closed` | the task was already reported, from another device or through a second operation id | ההנפקה כבר דווחה ממכשיר אחר |
| `task_cancelled` | the task was cancelled meanwhile: reassigned, self pickup, deleted | ההנפקה הועברה למשנע אחר, לאיסוף עצמי או נמחקה |
| `issuance_not_assigned` | the issuance is not in the `assigned` status any more | ההנפקה כבר לא בסטטוס שמאפשר דיווח |
| `revision_changed` | the issuance revision moved since the snapshot | פרטי ההנפקה השתנו מאז ההורדה למכשיר |
| `operation_reused` | the same operation id was already used with different content | מזהה הדיווח כבר בשימוש עם תוכן אחר |

Reassignment to the same courier (the manager moves the date by assigning again) creates a new task and cancels the old one, so a report queued against the old task is a `task_cancelled` conflict on purpose: a queued report is never retargeted to a newly assigned task, the courier signed for that task and the manager decides what the new one means.

Synced reports are kept for 30 days after the acknowledgment so the task screen can show the signature offline, then pruned on the next refresh, or earlier when their task leaves the list.

### What invalidates a report

`issuances.revision` (integer, default 1) is the concurrency token. It is bumped, inside the existing locked transactions, by assign, self pickup, delete and a delivery report. Priority, delivery date and notes edits and mark urgent do not bump it: those are harmless for a report, and a report written before such an edit is still applied. The tablet stores the revision with the snapshot and sends it back with the report; a different number is a 409 `revision_changed` and nothing is written.

Today every bump also cancels or closes the task, so the task check fires first (`task_cancelled` / `task_closed`) and the revision check cannot be reached through a real flow. It is a forward guard for bump sources that leave the task alone, such as item or customer changes from SAP once that interface exists; the e2e test sends a fabricated stale number to cover it. Client timestamps play no part in conflict resolution: `client_reported_at` is stored for the record, `reported_at` stays the server receipt time.

## API

All routes are under `/api` and need `Authorization: Bearer <token>` except login.

| Route | Role | What |
| --- | --- | --- |
| `POST /auth/login`, `GET /auth/me`, `GET /auth/dev-accounts` | | development login; the user object carries `id` next to the JWT's `sub` |
| `GET /issuances`, `GET /issuances/:id`, `GET /issuances/summary` | manager | board (`?sort=number|customer|destination|city|courier|priority|status&order=asc|desc`, filters, paging), detail, the cities widget |
| `PATCH /issuances/:id` | manager | priority, delivery date, notes, self pickup |
| `POST /issuances/assign`, `POST /issuances/mark-urgent` | manager | bulk actions |
| `DELETE /issuances/:id` | manager | soft delete with a reason |
| `GET /couriers` | manager | couriers with their open task count |
| `POST /couriers`, `PATCH /couriers/:id` | manager | add / edit (name, id number, phone); a deleted courier with the same id number comes back on add |
| `DELETE /couriers/:id`, `POST /couriers/remove` | manager | soft delete (`active=false`), 409 with the names when one of them has open deliveries |
| `GET /delivery/tasks`, `GET /delivery/tasks/:id` | courier | my tasks (`?tab=all|pending|done&search=`) |
| `POST /delivery/tasks/:id/attempts` | courier | the delivery report (`IAttemptPayload`), optionally with `operation_id` (then `issuance_revision` is required), `client_reported_at`; answers `IAttemptResult` |
| `POST /delivery/tasks/:id/conflicts` | courier | a report the attempts route refused with a 409, kept as evidence; same body with a required `operation_id`; answers `IConflictReceipt`, or the delivery result when that operation had been applied |
| `GET /delivery/conflicts?operation_ids=` | courier | the review status of the caller's own evidence (`IConflictStatus[]`) |
| `GET /conflicts`, `GET /conflicts/:id` | manager | rejected reports (`?status=pending|reviewed|all&page=&page_size=`, no signatures in the list), one report with its signature next to the current state |
| `POST /conflicts/:id/review` | manager | `{ note, version }`: mark reviewed; 409 `review_conflict` with the existing review when another manager got there first |
| `GET /delivery/lookup?number=` | courier | find my task by the printed number |

### API contract changes

Made for the offline work, in `shared/@core.ts`:

- `POST /delivery/tasks/:id/attempts` accepts three optional fields. `operation_id`: 8 to 64 characters of letters, digits, `_` or `-`, else 400; with it the request is idempotent as described under [Rules enforced on the server](#rules-enforced-on-the-server), and `issuance_revision` becomes required: an offline operation may not skip the concurrency token by leaving it out (400), only the legacy request without any operation id may, and that one is decided by the task state alone. `issuance_revision`: an integer, else 400; it must match the current `issuances.revision`, else 409 `revision_changed`. `client_reported_at`: a strict ISO 8601 string, stored on the attempt as `client_reported_at`; anything else is stored as null, never a 400.
- `POST /delivery/tasks/:id/conflicts`, `GET /delivery/conflicts`, `GET /conflicts`, `GET /conflicts/:id` and `POST /conflicts/:id/review` are new, see [Unresolved reports](#unresolved-reports). The shared types are `IConflictReceipt`, `IConflictStatus`, `IDeliveryConflict`, `IConflictObserved`, `ConflictReviewStatus` and, client side only, `EvidenceUploadState`. `ReportConflictCode` gained `not_a_conflict`, returned only by the conflicts route.
- The success body is `IAttemptResult`: `{ attempt_id, outcome, task_id, reported_at, operation_id? }`, a superset of the old `{ attempt_id, outcome }`, still 201. A replay of a stored operation returns the stored body plus `replayed: true`.
- Every 409 of that route is `{ statusCode: 409, message, code }` with `code` from `ReportConflictCode` (`task_closed`, `task_cancelled`, `issuance_not_assigned`, `revision_changed`, `operation_reused`). The default Nest `error` field is gone from these bodies; `message` and `statusCode` stay. The legacy request without an operation id still answers 409 with the message `task already closed`, now with `code: task_closed`.
- `POST /auth/login` returns `user: { id, sub, username, display_name, role, courier_id }` and `GET /auth/me` returns `{ id, ...jwt payload }`: `id` is `users.id`, the same value as `sub`, so the client never keys its local storage on an undefined id. The client also fills `id` from `sub` for a session stored before this change.
- `IIssuance.revision`, `IDeliveryAttempt.client_reported_at` and the client only `IDeliveryTask.local_report` were added to the shared types.

Nothing else in the API changed.

## Responsive layout

Breakpoints are the same numbers in SCSS (`client/src/styles/_breakpoints.scss`) and TypeScript (`client/src/utils/useBreakpoint.ts`) and match the MUI theme:

| Width | Name | What changes |
| --- | --- | --- |
| up to 599 | phone | manager nav in a drawer, the issuances table becomes cards, widgets collapsed below the list, every dialog full screen, courier cards in three rows, the send button sticks above the bottom bar |
| 600 to 899 | compact (portrait tablet) | still cards on the manager board, nine columns do not fit at 768 |
| 600 to 1199 | tablet | widgets in two columns under the table, one row courier cards, filters in three columns |
| 1200 and up | desktop | inline navigation, full table |
| 1440 and up | wide | the two column board of the design, table and widgets side by side |

On touch devices (`hover: none`) every button, field, text link and menu item gets a 44px minimum, and the fixed bars respect the iPhone safe area.

Two CSS notes worth knowing before adding styles: a single class rule on a MUI component loses the specificity tie to MUI's own emotion styles (they are injected after our sheet), so target MUI components with two classes, like `.issuance-card__menu.MuiIconButton-root`. And `overflow-x` sits on `html` only; on `body` it would turn body into the scroll container and kill every `position: sticky`.

## HTTPS and testing the build

Service workers, `crypto.randomUUID`, Web Locks and `navigator.storage.persist` exist only in a secure context: https, or `localhost`. A tablet opening `http://<lan-ip>:5173` (the reason for `server.host: true` in `vite.config.ts`) gets none of them: the status strip says "עבודה ללא רשת לא זמינה בכתובת הזו", offline reload does not work, and the fallbacks take over for the rest (a v4 uuid from `getRandomValues`, the lease in `meta` instead of a Web Lock, no persistence request). The data layer and the sync worker still work there, so reports queue and send; what is missing is the app shell offline.

To test on a tablet, give the dev server or the preview a certificate. With [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install
mkcert localhost 192.168.1.20     # the machine's lan address, files land in the current directory
```

Point `CLIENT_TLS_KEY` and `CLIENT_TLS_CERT` at the two files (PowerShell: `$env:CLIENT_TLS_KEY="...\localhost+1-key.pem"`, `$env:CLIENT_TLS_CERT="...\localhost+1.pem"`) and run `npm run dev` or `npm run preview`; `vite.config.ts` turns https on for both when both files exist, and leaves it off otherwise. The tablet needs the mkcert root installed to trust it.

The service worker is registered from the production build only, so the offline shell is tested against the build:

```bash
cd client && npm run build && npm run preview
```

`npm run preview` serves `dist/` on http://localhost:4173 and forwards `/api` to the NestJS server on port 3000 (the preview proxy is the same object as the dev proxy; `API_PROXY_TARGET=http://localhost:3002` points both at another instance, for example one started with `DB_NAME=equipment_supply_test PORT=3002` so a browser check never touches the development data). Then: log in as a courier, wait for "מוכן לעבודה ללא רשת" in the strip, open DevTools, Network, Offline, and reload `/courier` and a direct `/courier/tasks/:id`; both come from the service worker and the local database. `/api` is excluded from the HTML navigation fallback and no API response is ever cached by the worker; the courier's data lives in the account scoped database only.

Service worker updates are prompt based: a new build is downloaded and waits until the courier taps the "גרסה חדשה" button in the strip; the app never reloads on its own, a signature half drawn must not vanish. The manifest (`name`, `short_name`, `lang: he`, `dir: rtl`, `start_url: /courier`, `display: standalone`) has one SVG icon, `client/public/icon.svg` (the emblem in white on the primary blue, square because Chrome's install banner refuses other shapes). No raster icons and no iOS home screen icon were produced; iOS ignores manifest icons.

## Tests

```bash
cd server && npm test
cd client && npm test
```

Server: 8 suites, 78 tests. `npm run test:unit` covers the payload validation, the transition table, the courier form validation and `delivery/operation.ts` (operation id and revision validation, strict client time parsing, the payload hash and the unique violation match) without a database. `npm run test:e2e` boots the real application against `equipment_supply_test` (created automatically in the Docker container). The older specs check malformed item answers, concurrent duplicate submissions, reassignment of completed and partially delivered issuances, a batch with a closed issuance, a report racing a reassignment five times in a row, and courier management. `offline-sync.e2e.spec.ts` (16 tests) covers the report route with operation ids: the attempt, the receipt row, the device time and the revision bump; junk client time stored as null and a bad revision or id as 400; a replay after the task closed and after the manager reassigned and deleted the issuance; two concurrent identical requests; a reused id with different content; a second operation id on a closed task; a stale revision; assign bumping the revision while priority, date, notes and mark urgent do not; a report after reassignment (to another courier and to the same one), self pickup and delete; another courier using the same operation id; the legacy request without an id; and `id` next to `sub` on login and me. `conflicts.e2e.spec.ts` (9 tests) covers the evidence of rejected reports: a stale report refused then kept exactly once with the observed state while the delivery stays untouched, the lost response replay and a restart; two concurrent uploads keeping one row and a reused id with other content refused; an applied operation answered with its delivery result and never stored as a conflict; a report that could still be applied refused as not_a_conflict; malformed bodies, another courier, a manager and no token producing no row while answers for lines that no longer exist are kept; task_closed with the closing attempt, self pickup and a fabricated stale revision recorded with their codes; the courier reading only their own status; the manager list without signatures, the detail with the signature and both states, the review with a required note and a version, the repeated identical review, the courier seeing the status but not the note; two managers reviewing at once with one 409 carrying the other review, a stale version refused, and the courier locked out of the manager routes.

Client: 4 files, 55 tests, vitest on jsdom with `fake-indexeddb` (`client/src/test/setup.ts`), no browser. `db.spec.ts` (5): the stores, the shared connection reopening after close, the per scope delete range, transaction commit / abort, the storage error keys. `refresh.spec.ts` (9): the default source refusing another account's token, atomic replace, invalid shapes and a rows / counts mismatch keeping the old snapshot, pruning of vanished tasks' details and synced reports while queued, rejected reports and drafts stay, deduped concurrent calls, `refreshIfStale`, and a response that still shows a task pending while its report is queued. `store.spec.ts` (21): scope partitioning, `readTask` for pending and done tasks with and without details, the local lookup, the board overlay (counts, tabs, search, order parity with the server), a report surviving a close and reopen of the database, the three outcomes, drafts blocked after send, `submitReport` atomicity including a failing write and two concurrent submits, the retry helpers. `sync.spec.ts` (20): the transport body (operation id, revision, client time, the stored signature), a report enqueued mid pass, network backoff cleared by `online` and by a fresh start while a 5xx keeps its schedule, 401 parking the queue and a same account login resuming the same operation ids, an expired or foreign token, 409 / 400 / 403 / 404 classification, a conflict surviving a stop, a same account start and a refresh that lost its task, an unreadable 2xx, a late result after `stopSync`, `afterSynced` once per pass, the Web Locks branch with the cross tab kick, and the evidence of rejected reports: uploaded in the same pass as the 409 with the receipt kept and the review read on a later pass, a conflict stored before the evidence field existed uploaded on the next start, a lost upload response retried with the same operation id, a 401 pausing the upload until the same account signs in again, another account's token sending nothing and a refused upload not blocking the next delivery report, and a receipt of kind delivered turning the report into a synced one.

Not covered by automation: the built app in a real browser (offline reload through the service worker, Web Locks across real tabs, `navigator.storage.persist`), the React components. The manual check is described under [HTTPS and testing the build](#https-and-testing-the-build).

## Sample data and what is missing

- Every issuance, courier and customer comes from `server/src/seed/seed.data.ts`. There is no SAP: the interface is not defined and none was invented. The `source` column on an issuance (`sample` today) is the only touch point.
- QR scanning: the dialog shows the camera frame from the design and works through manual number entry. Which camera library, and what the QR encodes, are open.
- Couriers: add, edit and delete follow the `ניהול שליחים` screens. The Excel import (spec 2.7.2) has no design. Delete is a soft `active=false` (the delivery tasks point at the row) and is refused while the courier has open deliveries.
- Reports and the KPI dashboard: placeholder page. The diagram has a question mark on the KPI definition.
- History, analytics, PDF, SMS and email were not built. They have no screen in the design.
- The manager's "find issuance" button only focuses the search; its behavior on that side was not defined.
- Grouping issuances by address exists on the courier board only, not on the manager table.
- The drag handle on courier cards is visual; route reordering is not implemented.
- Offline work covers the courier side only. Reports the sync rejected have no manager screen; the courier shows them from the device (see [Unresolved reports](#unresolved-reports)). Nothing syncs while the app is closed. The PWA has an SVG icon only.

## Open decisions

Recorded here instead of being buried in the code. The architecture is not locked on any of them.

1. **Partially delivered issuance.** What happens to the lines already delivered: a new task with the remaining lines only, the courier sees all lines with the delivered ones marked, or back to SAP for a new document? Until answered the issuance is frozen: assign, delete and self pickup return 409. The UI still shows the buttons and surfaces the English message as a toast.
2. A not delivered issuance goes back to the board and the manager decides whether to reassign. No automatic retry.
3. Self pickup ends the courier side. What SAP should hear about it is unknown.
4. The letter before the issuance number in the design (ס', ד', כ') is stored in its own column and not interpreted. Nobody explained it.
5. The signature is stored as a PNG in the database. The spec asks for restricted file storage with the issuance id and a timestamp.
6. One courier per issuance. The spec's "assign to several couriers" was not designed.
7. Production identity provider (see [Authentication](#authentication)).
8. The style guide page in Figma says the primary color is `#0A6E8A`; every actual screen uses `#0A52BD`. The screens win until the designers say otherwise.
9. The manager navigation sits in a drawer on landscape tablets too (under 1200px). There is room for it inline; it is a taste call.
10. The courier's id number is checked for 9 digits only, not for the check digit: the sample ids on the design screens fail it. Two couriers cannot share an id number.
11. Deleting a courier does not touch their login account (`users`); a deleted courier who signs in sees an empty board. What should happen to the account waits for the identity provider decision.
12. The `ניהול שליחים` screens show a white header with `היסטוריה` and `הגדרות` in the navigation and dark navy buttons. The gradient header, the `דוחות` link and the blue buttons of the earlier screens were kept until the designers say the new header is the direction.
13. How a report the sync rejected reaches the manager. Today it stays on the courier's device and the courier shows it; a manager view of rejected reports, or an upload of the preserved report for review, was not designed.

## Design references

`design/` holds the PNG exports of the Figma file (courier screens, manager screens, components, references, spec pages) and the information architecture diagram. It is git ignored because of its size; ask for the folder or the Figma file. Where the exports and the original spec disagree, the exports were followed; where an export shows a design still moving (the designer notes in the manager folder), the modal version was implemented.

## Code style

Client: 2 spaces, double quotes, function components with inline destructured props, `t("key")` for every UI text with keys in `shared/i18n/he.ts`. Server: 2 spaces, single quotes, direct `process.env`, plain `any` payloads instead of DTO classes. Comments explain why, in lowercase English. Top level functions in a TypeScript file are separated by a `/*──...──*/` line. SCSS: 4 spaces, nesting, breakpoints only through the `bp` mixins.
