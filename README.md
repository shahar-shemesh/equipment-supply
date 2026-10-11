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
- [docs/README.he.md](docs/README.he.md): the original Hebrew specification and the running notes written during development.
- [docs/plans/](docs/plans/): implementation plans written by the `/build` skill.

## Status

What runs today:

- Manager board on MUI X Data Grid Premium (server paging and sorting, the cards under 900px), with search, status quick actions, a city multi select next to the other filters, bulk assign and mark urgent, the issuance detail dialog (priority, delivery date, self pickup and its handover at the warehouse with the courier's report form, delete with a reason), courier management (add, edit, delete), reports placeholder.
- Courier board with tabs and search, grouped cards for the same address, the delivery report (per item delivered / not delivered with a reason; recipient and signature only when at least one item was delivered), lookup by issuance number.
- Courier work without a network: the task list is downloaded to the device, drafts and signed reports live in IndexedDB, a sync worker sends queued reports with an operation id the server treats as idempotent, a service worker serves the built app offline. See [Offline courier work](docs/offline-sync.md).
- NestJS API with role based access, server side validation of the delivery report, status transition rules, row locking for concurrent requests, idempotent delivery reports, an append-only audit log of every state change readable through `GET /api/audit` (see [Domain model and server rules](docs/domain.md#rules-enforced-on-the-server)).
- PostgreSQL schema with five migrations, a seed with 30 handcrafted issuances plus 2000 generated ones, 261 tests (167 server, 94 client).
- Responsive layout for phone, tablet and desktop.

What does not exist: the SAP interface, history and analytics screens, PDF / SMS / email confirmations, the courier Excel import, production authentication, synchronization while the app is closed (no Background Sync), raster and iOS home screen icons, any way for a manager to apply, merge or reassign a rejected report (the manager can read it and mark it reviewed, see [Unresolved reports](docs/offline-sync.md#unresolved-reports)). Details under [Sample data and what is missing](#sample-data-and-what-is-missing).

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
  components/      Logo, StatusBadge
  courier/         CourierLayout, pages (DeliveryBoard, TaskDetailPage, ReportDetailPage), components (TaskCard, ItemReportCard, SignaturePad, FindIssuanceDialog, SyncStatusBar, PendingReportsDialog, SyncChip)
  courier/offline/ the local data layer: db (IndexedDB layout), store (reads, drafts, reports, overlay, the evidence axis), sync (the worker: reports, evidence uploads, review status), useCourierData (hooks), identity, storage, uuid, sw (service worker registration), the vitest specs
  manager/         ManagerLayout, pages (IssuancesBoard, CouriersPage, ConflictsPage, ReportsPage), components (IssuancesTable, IssuanceCard, BoardFilters, SideWidgets, AssignCourierDialog, IssuanceDetailDialog, SelfPickupReportDialog, CourierDialog, ConflictDetailDialog)
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
  audit/           the audit log: the one writer (audit.service, rows on the caller's transaction), the diff of an edit, the query validation and GET /api/audit
  issuances/       manager side: board queries, assign, update, delete, transition rules
  couriers/        courier management: list with open task count, add, edit, soft delete, form validation
  delivery/        courier side: my tasks, delivery report, payload validation, operation.ts (operation id, payload hash, client time); conflicts.service / conflicts.controller: rejected reports kept as evidence and the manager review
  entities/        TypeORM entities
  migrations/      hand written migrations (OfflineSync, ConflictEvidence, NoRecipientWithoutDelivery, AuditLog, SelfPickupHandover)
  seed/            sample data
  e2e/             database backed tests
  data-source.ts   the DataSource the TypeORM CLI uses for migrations
  env.ts           the LOCAL / production switches
shared/            @core.ts, @utils.ts, i18n/
design/            Figma exports (git ignored)
docs/              offline-sync.md, domain.md, api.md (reference docs), README.he.md (original spec + Hebrew notes), plans/ (implementation plans)
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
| `AUTH_STRATEGY=dev-local` | works | refused at startup unless `ALLOW_DEV_AUTH=true` (a test box with no identity provider yet, logged loudly) |
| `GET /api/auth/dev-accounts` | returns the seeded accounts | always empty |
| `npm run seed` | needs `ALLOW_DESTRUCTIVE_SEED=true` | refused |
| TypeORM `synchronize` | needs `DB_SYNCHRONIZE=true` | off |
| Schema changes | `synchronize` applies them on start; `npm run migration:run` is then a no-op (the migration has `IF NOT EXISTS` guards) | `npm run migration:run` or `migration:run:prod` before the new build starts, see [Schema upgrade](docs/domain.md#schema-upgrade) |

`server/.env.example` documents every variable.

## Authentication

Only development authentication exists: username and password against the seeded `users` table, a JWT in localStorage, a guard that checks the role per route. It lives in `server/src/auth` and is marked as such in the code and on the login page.

The production identity source is not decided (the information architecture diagram asks: email and password, or national identification?). No 2FA, national identity flow or SSO was built on a guess. When the decision comes, the parts that change are token issuing in `auth.service.ts` and `LoginPage.tsx`; the guard, the roles and the screens stay.

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

Server: 167 tests in 17 suites (jest; 79 unit, 88 e2e). The unit specs next to the code cover the payload validation, the transition table, the courier form validation, the issuance lookup, `delivery/operation.ts`, the audit diff, the audit query validation, the audit row scrub, the seed rows and the `SEED_BULK` reader without a database. `src/e2e/` boots the real application with supertest against `equipment_supply_test` (created on first run): the delivery report and its rules, the offline sync route with operation ids, the evidence of rejected reports and its manager review, courier management, the audit log (every recorded action, what writes nothing, the manager's read), the self pickup handover (the move, the manager's report and its refusals, the courier side untouched, the courier sort), and the board paging walked page by page on the 2030 seeded issuances against SQL (totals, sorts, filters, the deleted rows, the tasks and attempts the seed writes, the unassigned-per-city summary).

Client: 94 tests in 11 files (vitest on jsdom with `fake-indexeddb`, see `client/src/test/setup.ts`), no browser. They cover the offline data layer (`db`, `store`, `refresh`, `sync`), the service worker update hold (`sw`), two components (`FindNumberDialog`, `QrCamera`), the board's filter query (`boardFilters`), the adapters between the data grid's models and the board's state and which statuses the bulk selection takes and which caption the row menu shows (`issuancesTable`), the name / load sort behind the side panel and the assign dialog (`sortToggle`) and the Hebrew wording of a server refusal (`service`).

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
