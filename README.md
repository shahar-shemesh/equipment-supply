# Digital equipment issuance system

A web system for issuing and delivering equipment, built for the Israeli Ministry of Defense. It replaces a paper process: SAP creates an issuance document, a warehouse manager assigns it to a courier, the courier delivers it from a tablet, collects the recipient's signature, and the outcome goes back to the manager and (later) to SAP.

Two user interfaces share one backend:

- **Warehouse manager**, desktop first: the issuances board, assignment, priorities, self pickup, deletion.
- **Courier**, tablet first: the delivery board, the delivery report with a per item result, the signature.

The UI is Hebrew and right to left. The Figma exports the screens follow live under `design/` (not committed, see [Design references](#design-references)). The original Hebrew specification and the running notes written during development are in [docs/README.he.md](docs/README.he.md).

## Documentation

- [docs/offline-sync.md](docs/offline-sync.md): how the courier works without a network, the local database, the sync worker, rejected reports kept as evidence, what invalidates a report, and how to test the built app over HTTPS.
- [docs/domain.md](docs/domain.md): the domain model, the rules the server enforces (transitions, validation, concurrency, idempotent reports) and the schema upgrade procedure.
- [docs/api.md](docs/api.md): every route and the contract changes made for the offline work.
- [docs/auth.md](docs/auth.md): the auth modes and their variables, the two mock identities, the global guard, the client pieces, and the steps to connect Cognito and Entra ID later.
- [docs/README.he.md](docs/README.he.md): the original Hebrew specification and the running notes written during development.
- [docs/plans/](docs/plans/): implementation plans written by the `/build` skill.

## Status

What runs today:

- Manager board on MUI X Data Grid Premium (server paging and sorting, the cards under 900px), with search, status quick actions, a city multi select next to the other filters, bulk assign and mark urgent, the issuance detail dialog (priority, delivery date, self pickup and its handover at the warehouse with the courier's report form, one line off the issuance, delete with a reason), courier management (add, edit, delete), reports placeholder.
- Courier board with tabs and search, grouped cards for the same address, the delivery report (per item delivered / not delivered with a reason; recipient and signature only when at least one item was delivered), lookup by issuance number.
- Courier work without a network: the task list is downloaded to the device, drafts and signed reports live in IndexedDB, a sync worker sends queued reports with an operation id the server treats as idempotent, a service worker serves the built app offline. See [Offline courier work](docs/offline-sync.md).
- NestJS API behind a global auth guard (a mock login for development, a Cognito boundary that refuses every token until it is wired, see [Authentication](#authentication)), role based access, server side validation of the delivery report, status transition rules, row locking for concurrent requests, idempotent delivery reports, an append-only audit log of every state change readable through `GET /api/audit` (see [Domain model and server rules](docs/domain.md#rules-enforced-on-the-server)), and an XML export of every issuance status change to an S3 bucket through a transactional outbox and a polling worker, with the queue and its failed rows at `GET /api/xml-export` (see [XML export](docs/xml-export.md); the document itself is provisional, open decision 16).
- PostgreSQL schema with eight migrations, a seed with 30 handcrafted issuances plus 2000 generated ones, 438 tests (296 server, 142 client).
- Responsive layout for phone, tablet and desktop.

What does not exist: the SAP interface, history and analytics screens, PDF / SMS / email confirmations, the courier Excel import, production authentication (the Cognito boundary exists and refuses every token; what to add is in [docs/auth.md](docs/auth.md)), synchronization while the app is closed (no Background Sync), raster and iOS home screen icons, any way for a manager to apply, merge or reassign a rejected report (the manager can read it and mark it reviewed, see [Unresolved reports](docs/offline-sync.md#unresolved-reports)). Details under [Sample data and what is missing](#sample-data-and-what-is-missing).

## Stack

| Part | Technology |
| --- | --- |
| `client/` | React 18, TypeScript, Vite, MUI 5 with an RTL emotion cache, MUI X Data Grid Premium 8 for the manager board (it draws its watermark unless `VITE_MUI_X_LICENSE_KEY` holds a key, see `client/.env.example`), SCSS, react-router 6, react-i18next, `idb` for IndexedDB, `vite-plugin-pwa` (workbox) for the service worker, vitest + jsdom + fake-indexeddb for the tests |
| `server/` | NestJS 10, TypeORM 0.3 (hand written migrations), PostgreSQL 16, JWT (`@nestjs/jwt`), `helmet` for the security response headers, Jest + supertest |
| `shared/` | Enums and interfaces (`@core.ts`), helpers (`@utils.ts`), the Hebrew dictionary (`i18n/he.ts`). Imported by both sides |
| root | `docker-compose.yml` for PostgreSQL |

## Repository layout

```
client/src
  auth/            provider (the client side of the auth boundary: the mock sign in, the cognito stub, the factory by mode)
  components/      Logo, StatusBadge
  courier/         CourierLayout, pages (DeliveryBoard, TaskDetailPage, ReportDetailPage), components (TaskCard, ItemReportCard, SignaturePad, FindIssuanceDialog, SyncStatusBar, PendingReportsDialog, SyncChip)
  courier/offline/ the local data layer: db (IndexedDB layout), store (reads, drafts, reports, overlay, the evidence axis), sync (the worker: reports, evidence uploads, review status), useCourierData (hooks), identity, storage, uuid, sw (service worker registration), the vitest specs
  manager/         ManagerLayout, pages (IssuancesBoard, CouriersPage, ConflictsPage, ReportsPage), components (IssuancesTable, IssuanceCard, BoardFilters, SideWidgets, AssignCourierDialog, IssuanceDetailDialog, SelfPickupReportDialog, CourierDialog, ConflictDetailDialog)
  pages/           LoginPage
  routers/         AppRouter (two route trees: /manager and /courier), guards (RequireRole by the session's roles, HomeRedirect)
  styles/          _breakpoints, _basic, _layouts, _layout-manager, _layout-courier, _manager, _courier, _badges, _login
  theme/           RtlTheme (MUI theme + rtl cache + full screen dialogs on phones)
  utils/           service (axios), auth (context: the mode from the server, signIn, logout, homeOf), format, useBreakpoint
  assets/          mod.svg (the logo)
  test/            vitest setup (fake-indexeddb), fixtures, the virtual:pwa-register stub
client/public      icon.svg (the PWA icon)
client/vitest.config.ts   the test runner config, separate from vite.config.ts so the PWA plugin stays out of the tests
server/src
  auth/            the global guard (@Public, @Roles any-of), the provider boundary: mock/ (two identities, a signed jwt) and cognito/ (holds the pool config, refuses every token until wired)
  audit/           the audit log: the one writer (audit.service, rows on the caller's transaction), the diff of an edit, the query validation and GET /api/audit
  issuances/       manager side: board queries, assign, update, delete, transition rules
  couriers/        courier management: list with open task count, add, edit, soft delete, form validation
  delivery/        courier side: my tasks, delivery report, payload validation, operation.ts (operation id, payload hash, client time); conflicts.service / conflicts.controller: rejected reports kept as evidence and the manager review
  entities/        TypeORM entities
  migrations/      hand written migrations (OfflineSync, ConflictEvidence, NoRecipientWithoutDelivery, AuditLog, SelfPickupHandover, RemoveIssuanceItem, XmlOutbox, AuthMockIdentities)
  seed/            sample data
  e2e/             database backed tests
  data-source.ts   the DataSource the TypeORM CLI uses for migrations
  env.ts           the LOCAL / production switches
shared/            @core.ts, @utils.ts, auth.ts (rolesOf, primaryRole, hasRole), i18n/
design/            Figma exports (git ignored)
docs/              offline-sync.md, domain.md, api.md, auth.md (reference docs), README.he.md (original spec + Hebrew notes), plans/ (implementation plans)
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

Open http://localhost:5173. Vite proxies `/api` to the NestJS server on port 3000. PostgreSQL is exposed on host port 5433 (5432 was taken on the machine this was built on; change it in `docker-compose.yml` and `server/.env` together). The dev server has no service worker (it is registered from the production build only); the local data layer and the sync worker run there like anywhere else, offline reload does not. To see the whole thing, including offline reload, use the build, see [HTTPS and testing the build](docs/offline-sync.md#https-and-testing-the-build).

`npm run seed` truncates every table and inserts the sample set again, run it whenever you want a clean start. On a LOCAL machine the schema is built from the entity classes with TypeORM `synchronize` (`DB_SYNCHRONIZE=true`); everywhere else it moves with migrations, see [Schema upgrade](docs/domain.md#schema-upgrade).

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
| `AUTH_MODE=mock` (also unset) | works: the two identity buttons on the login page | refused at startup unless `ALLOW_MOCK_AUTH=true` (a test box with no identity provider yet, logged loudly) |
| `ALLOW_MOCK_AUTH` | not needed | `true` lets the mock login run, except on production (`NODE_ENV=production` or `ENVIRONMENT=PRODUCTION`), where the server refuses to start in mock mode whatever it says. `AUTH_MODE=cognito` needs `COGNITO_REGION`, `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` in both columns and refuses every token until the verification is written, see [docs/auth.md](docs/auth.md#modes) |
| `npm run seed` | needs `ALLOW_DESTRUCTIVE_SEED=true` | refused |
| TypeORM `synchronize` | needs `DB_SYNCHRONIZE=true` | off |
| Schema changes | `synchronize` applies them on start; `npm run migration:run` is then a no-op (the migration has `IF NOT EXISTS` guards) | `npm run migration:run` or `migration:run:prod` before the new build starts, see [Schema upgrade](docs/domain.md#schema-upgrade) |

`server/.env.example` documents every variable.

The XML export has its own switches, independent of `ENVIRONMENT`: `XML_EXPORT_ENABLED=true` starts the worker that uploads the outbox rows to S3 and then needs `AWS_REGION` and `XML_EXPORT_BUCKET` (the server refuses to start without them, naming the variable); the rows are written whether or not the worker is on. `XML_EXPORT_STORAGE=local` writes the same documents under a directory (`XML_EXPORT_LOCAL_DIR`, default `server/exports/xml`, git ignored) with no AWS variable at all, for development and testing. The full list, the IAM policy, the local directory and the setup with MinIO are in [XML export](docs/xml-export.md#configuration).

## Authentication

`AUTH_MODE=mock` (the default; LOCAL and test boxes only) is the login that exists: the login page shows two buttons, manager and courier, each an identity key the server maps to a seeded `users` row (`manager` is דנה לוי with the roles `manager` and `courier` and a courier row of her own, `courier` is יוסי אברהם with `courier`). The answer is a 12 hour JWT and the `IAuthUser` (`id, username, name, email, roles, courier_id`). The roles are derived on the server (`rolesOf` in `shared/auth.ts`): a manager holds the courier role too and opens the courier screens from a header link without a second login. `AUTH_MODE=cognito` is the boundary for the real identity provider (Entra ID through AWS Cognito): it holds the pool configuration and refuses every token until the verification is written.

Every route is behind a global guard: denied without a token, opened by `@Public()` (`GET /api/auth/mode`, `POST /api/auth/mock/login`), narrowed by `@Roles()` (any of the listed roles); the resource checks (an account without a courier row, another courier's task) stay in the services. The client ends the session at `exp` on its own; a courier's logout sends the queued reports first and leaves only what the server never acknowledged on the device, a manager's sign out removes the account's synced courier data as well, see [Offline courier work](docs/offline-sync.md). The modes and their variables, the identities, the guard, the client pieces and the steps to connect Cognito and Entra ID are in [docs/auth.md](docs/auth.md).

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

## Tests

```bash
cd server && npm test            # unit and e2e; docker compose up -d first
cd server && npm run test:unit   # no database needed
cd client && npm test
```

Server: 296 tests in 34 suites (jest; 169 unit, 127 e2e). The unit specs next to the code cover the auth mode, the production lock and the Cognito config readers with `assertSafeConfig`, the global guard, the mock provider against stubs and against the real signer (the request time lock, the claims it signs, the issuer, algorithm, secret and expiry it refuses), the mock login validation, the two mock identities against the seed, the role derivation, the Cognito boundary, the payload validation, the transition table, the courier form validation, the issuance lookup, `delivery/operation.ts`, the audit diff, the audit query validation, the audit row scrub, the seed rows, the `SEED_BULK` and XML export config readers, the XML serializer, the provisional document builder, the S3 storage against a fake client (and the options the real client is built with), the local filesystem storage on temporary directories (the linked write, the taken key in each shape, five puts at once, the orphans, the traversal, the error categories), the outbox writer with its backoff curve and the export worker against stubs (its timer, a tick that never rejects, the lease fence, the 412 branches), all without a database. `src/e2e/` boots the real application with supertest against `equipment_supply_test` (created on first run): the auth routes (the mode, the mock login of both identities and its refusals, a route without a token, a token with another secret, issuer, algorithm or a past expiry, the role check, a manager on the courier routes with and without a courier row, the courier row resolved per request, a second application booted in cognito mode), the migrations on a database of their own (the last one against a users table of the previous version with its rows, the parity with the entities, down and up again), the delivery report and its rules, the offline sync route with operation ids (an expired token included), the evidence of rejected reports and its manager review, courier management, the audit log (every recorded action, what writes nothing, the manager's read), the self pickup handover (the move, the manager's report and its refusals, the courier side untouched, the courier sort), one line off an issuance (what stays, what is refused, the stale and the replayed tablet report, also around a second removal), and the board paging walked page by page on the 2030 seeded issuances against SQL (totals, sorts, filters, the deleted rows, the tasks and attempts the seed writes, the unassigned-per-city summary), and the XML export (every status writing route and its outbox row, a rolled back request, then the worker ticked by hand against an in-memory bucket: a chain of three documents, the retries and the attempts limit, a corrupt payload, a lost response, an expired lease, a key collision, two claims at once, the manager's endpoints), and the same application booted with `XML_EXPORT_STORAGE=local` and no AWS variable, the worker ticked against a temporary directory (the file under the row's key with the builder's bytes and its sidecar, the second pass, a foreign file under the key).

Client: 141 tests in 18 files (vitest on jsdom with `fake-indexeddb`, see `client/src/test/setup.ts`), no browser. They cover the offline data layer (`db`, `store`, `refresh`, `sync`, the token expiry watcher in `identity`), the courier logout against the real data layer and the manager's link there (`CourierLayout`), the manager shell's courier link and its sign out sweep (`ManagerLayout`), the login page's branch on the mode (`LoginPage`), the session in the provider: the mode from the server, the sign in of both identities and the switch between them, the Cognito refusal, the end at `exp` (`auth`), the client side of the auth boundary (`provider`), the route guards against a memory router (`guards`), the service worker update hold (`sw`), two components (`FindNumberDialog`, `QrCamera`), the board's filter query (`boardFilters`), the adapters between the data grid's models and the board's state and which statuses the bulk selection takes and which caption the row menu shows (`issuancesTable`), the name / load sort behind the side panel and the assign dialog (`sortToggle`), the Hebrew wording of a server refusal and the note a session leaves for the login page (`service`).

What each test checks is written in the spec files; their names are the description. Not covered by automation: the built app in a real browser (offline reload through the service worker, Web Locks across real tabs, `navigator.storage.persist`) and most React components. The manual check is in [docs/offline-sync.md](docs/offline-sync.md#https-and-testing-the-build).

## Sample data and what is missing

- Every issuance, courier and customer comes from `server/src/seed/seed.data.ts`: 30 handcrafted issuances (the names and addresses of the Figma screens) plus 2000 generated ones from a seeded PRNG, the same rows on every run (the dates are relative to the seed day). `SEED_BULK` in `server/.env` sets the generated count, `SEED_BULK=0` seeds the 30 only; a value that is not a whole number is refused. There is no SAP: the interface is not defined and none was invented. The `source` column on an issuance (`sample` today) is the only touch point.
- QR scanning uses qr-scanner in both boards. The QR must contain the SAP issuance number as digits only (leading zeros are kept), not a URL or JSON. The courier searches the device first; the manager opens the exact matching issuance. Camera access needs HTTPS or localhost and browser permission. Manual entry remains available. The scanner worker is bundled and precached with the built PWA; no external decoder service is used.
- Couriers: add, edit and delete follow the `ניהול שליחים` screens. The Excel import (spec 2.7.2) has no design. Delete is a soft `active=false` (the delivery tasks point at the row) and is refused while the courier has open deliveries.
- Reports and the KPI dashboard: placeholder page. The diagram has a question mark on the KPI definition.
- History, analytics, PDF, SMS and email were not built. They have no screen in the design.
- The manager's "find issuance" button opens camera scanning and manual number entry, independently of the board filters.
- Grouping issuances by address exists on the courier board only, not on the manager table.
- The drag handle on courier cards is visual; route reordering is not implemented.
- Offline work covers the courier side only. Reports the sync rejected have no manager screen; the courier shows them from the device (see [Unresolved reports](docs/offline-sync.md#unresolved-reports)). Nothing syncs while the app is closed. The PWA has an SVG icon only.

## Open decisions

Recorded here instead of being buried in the code. The architecture is not locked on any of them.

1. **Partially delivered issuance.** What happens to the lines already delivered: a new task with the remaining lines only, the courier sees all lines with the delivered ones marked, or back to SAP for a new document? Until answered the issuance is frozen: assign, delete and self pickup return 409. The board reads the same table: the row cannot be selected, its menu items are disabled with the reason, and a 409 that still gets through is worded in Hebrew.
2. A not delivered issuance goes back to the board and the manager decides whether to reassign. No automatic retry.
3. Self pickup ends the courier side. What SAP should hear about it is unknown.
4. The letter before the issuance number in the design (ס', ד', כ') is stored in its own column and not interpreted. Nobody explained it.
5. The signature is stored as a PNG in the database. The spec asks for restricted file storage with the issuance id and a timestamp.
6. One courier per issuance. The spec's "assign to several couriers" was not designed.
7. **Production identity provider.** Entra ID through AWS Cognito is the direction; the server has the boundary and refuses every token, the client has no Hosted UI flow. What to add, and what is undecided with it (a verified user without a `users` row, an `external_id`, the token claims the offline scope needs), is in [docs/auth.md](docs/auth.md#connecting-cognito-later).
8. The style guide page in Figma says the primary color is `#0A6E8A`; every actual screen uses `#0A52BD`. The screens win until the designers say otherwise.
9. The manager navigation sits in a drawer on landscape tablets too (under 1200px). There is room for it inline; it is a taste call.
10. The courier's id number is checked for 9 digits only, not for the check digit: the sample ids on the design screens fail it. Two couriers cannot share an id number.
11. Deleting a courier does not touch their login account (`users`); a deleted courier who signs in sees an empty board. What should happen to the account waits for the identity provider decision (account provisioning is on the [What is not done](docs/auth.md#what-is-not-done) list of docs/auth.md).
12. The `ניהול שליחים` screens show a white header with `היסטוריה` and `הגדרות` in the navigation and dark navy buttons. The gradient header, the `דוחות` link and the blue buttons of the earlier screens were kept until the designers say the new header is the direction.
13. How a report the sync rejected reaches the manager. Today it stays on the courier's device and the courier shows it; a manager view of rejected reports, or an upload of the preserved report for review, was not designed.
14. **Removing one line from an issuance.** `DELETE /api/issuances/:id/items/:itemId` is allowed from the statuses of the edit row (unassigned, assigned, not delivered, self pickup) and refuses the last line (409 `last_item`; the manager deletes the issuance instead). Both are assumptions: whether a line may leave an issuance whose courier is already on the road (today it may, the task stays and a report signed against the old lines is refused as `revision_changed`), and whether an issuance emptied of lines should be deleted by itself, were not designed. What SAP should hear about a removed line is unknown, like the rest of that interface.

15. **The session ends at `exp` on the client, also offline.** Since 2026-10-13 the courier screens end the session when the 12 hour token expires, and the login page needs the server: a courier without network past the twelfth hour cannot open the board or sign a delivery until the network returns. Before, the screens stayed readable with a dead token and a report could still be signed and queued; the change was asked for as "never leave the application authenticated after expiry", without saying whether an offline courier is the exception. The alternative is to end the session on the next `online` event when the device is offline at `exp`. The queued reports are safe either way.

16. **The XML export contract.** Every issuance status change leaves as one XML document in an S3 bucket ([XML export](docs/xml-export.md)), but nobody on the SAP side has seen the document: its namespace, element names and `schemaVersion="0.1-provisional"` are the system's own draft, and it carries no customer field on purpose. Open with it: what SAP should hear about a change that leaves the status `assigned` (a reassign to another courier, a moved date: today nothing, the status did not move), whether the self pickup and the removed line of decisions 3 and 14 belong in the same feed, whether completed rows and objects need a retention rule, and who reads the failed rows when no manager is looking (today `GET /api/xml-export`, no alert).

17. **What a manager sees in the courier screens.** A manager holds the courier role and opens `/courier` from the header without a second login; the board there shows the tasks of the courier row linked to the manager's account (the seed links one, `E-1000`), and an account with no courier row opens the courier screens all the same (the roles decide) and finds a notice in place of the board, the delivery routes answering 403 (the courier row is resolved per request, never from the token). Not built: every courier's tasks as a read only overview, or nothing without a link (and no cross link then). See [docs/auth.md](docs/auth.md#client).

## Design references

`design/` holds the PNG exports of the Figma file (courier screens, manager screens, components, references, spec pages) and the information architecture diagram. It is git ignored because of its size; ask for the folder or the Figma file. Where the exports and the original spec disagree, the exports were followed; where an export shows a design still moving (the designer notes in the manager folder), the modal version was implemented.

## Code style

Client: 2 spaces, double quotes, function components with inline destructured props, `t("key")` for every UI text with keys in `shared/i18n/he.ts`. Server: 2 spaces, single quotes, direct `process.env`, plain `any` payloads instead of DTO classes. Comments explain why, in lowercase English. Top level functions in a TypeScript file are separated by a `/*──...──*/` line. SCSS: 4 spaces, nesting, breakpoints only through the `bp` mixins.
