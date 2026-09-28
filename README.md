# Digital equipment issuance system

A web system for issuing and delivering equipment, built for the Israeli Ministry of Defense. It replaces a paper process: SAP creates an issuance document, a warehouse manager assigns it to a courier, the courier delivers it from a tablet, collects the recipient's signature, and the outcome goes back to the manager and (later) to SAP.

Two user interfaces share one backend:

- **Warehouse manager**, desktop first: the issuances board, assignment, priorities, self pickup, deletion.
- **Courier**, tablet first: the delivery board, the delivery report with a per item result, the signature.

The UI is Hebrew and right to left. The Figma exports the screens follow live under `design/` (not committed, see [Design references](#design-references)). The original Hebrew specification and the running notes written during development are in [docs/README.he.md](docs/README.he.md).

## Status

What runs today:

- Manager board with search, filters, paging, bulk assign and mark urgent, the issuance detail dialog (priority, delivery date, self pickup, delete with a reason), couriers list, reports placeholder.
- Courier board with tabs and search, grouped cards for the same address, the delivery report (per item delivered / not delivered with a reason, recipient, signature), lookup by issuance number.
- NestJS API with role based access, server side validation of the delivery report, status transition rules, row locking for concurrent requests.
- PostgreSQL schema, a seed with 30 sample issuances, 34 tests.
- Responsive layout for phone, tablet and desktop.

What does not exist: the SAP interface, QR camera scanning, history and analytics screens, PDF / SMS / email confirmations, courier management beyond a list, database migrations, production authentication. Details under [Sample data and what is missing](#sample-data-and-what-is-missing).

## Stack

| Part | Technology |
| --- | --- |
| `client/` | React 18, TypeScript, Vite, MUI 5 with an RTL emotion cache, SCSS, react-router 6, react-i18next |
| `server/` | NestJS 10, TypeORM 0.3, PostgreSQL 16, JWT (`@nestjs/jwt`), Jest + supertest |
| `shared/` | Enums and interfaces (`@core.ts`), helpers (`@utils.ts`), the Hebrew dictionary (`i18n/he.ts`). Imported by both sides |
| root | `docker-compose.yml` for PostgreSQL |

## Repository layout

```
client/src
  components/      Logo, StatusBadge
  courier/         CourierLayout, pages (DeliveryBoard, TaskDetailPage), components (TaskCard, ItemReportCard, SignaturePad, FindIssuanceDialog)
  manager/         ManagerLayout, pages (IssuancesBoard, CouriersPage, ReportsPage), components (IssuancesTable, IssuanceCard, BoardFilters, SideWidgets, AssignCourierDialog, IssuanceDetailDialog)
  pages/           LoginPage
  routers/         AppRouter (two route trees: /manager and /courier)
  styles/          _breakpoints, _basic, _layouts, _layout-manager, _layout-courier, _manager, _courier, _badges, _login
  theme/           RtlTheme (MUI theme + rtl cache + full screen dialogs on phones)
  utils/           service (axios), auth (context), format, useBreakpoint
  assets/          mod.svg (the logo)
server/src
  auth/            dev-local login, jwt guard, roles
  issuances/       manager side: board queries, assign, update, delete, transition rules
  couriers/        couriers with their open task count
  delivery/        courier side: my tasks, delivery report, payload validation
  entities/        TypeORM entities
  seed/            sample data
  e2e/             database backed tests
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

Open http://localhost:5173. Vite proxies `/api` to the NestJS server on port 3000. PostgreSQL is exposed on host port 5433 (5432 was taken on the machine this was built on; change it in `docker-compose.yml` and `server/.env` together).

`npm run seed` truncates every table and inserts the sample set again, run it whenever you want a clean start. The schema is built from the entity classes with TypeORM `synchronize`; that is fine for a laptop and has to become migrations before there is a shared environment.

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

`server/.env.example` documents every variable.

## Authentication

Only development authentication exists: username and password against the seeded `users` table, a JWT in localStorage, a guard that checks the role per route. It lives in `server/src/auth` and is marked as such in the code and on the login page.

The production identity source is not decided (the information architecture diagram asks: email and password, or national identification?). No 2FA, national identity flow or SSO was built on a guess. When the decision comes, the parts that change are token issuing in `auth.service.ts` and `LoginPage.tsx`; the guard, the roles and the screens stay.

## Domain model

The spec and the designs use "issuance" (הנפקה) for several different things, so the schema separates them:

- **Issuance** (`issuances`): the SAP document. Who the customer is, where it goes, the priority. Exists whether or not anyone was sent to deliver it. Its status mirrors the latest delivery outcome.
- **Issuance item** (`issuance_items`): one product line of the document, with catalog number, station number and serial. The courier answers delivered / not delivered per line, which is where partial delivery comes from.
- **Delivery task** (`delivery_tasks`): "go deliver issuance X", one issuance handed to one courier for a date. This is what the courier's board lists. Reassigning cancels the old task and creates a new one, so the history of who had it stays.
- **Courier** (`couriers`): whoever drives the equipment. Separate from `users`: a courier exists before anyone gives them a login (the sample data has two external companies without one).
- **Delivery attempt** (`delivery_attempts` + `delivery_attempt_items`): what the courier reported at the door: who received, the signature, a result and reason per item. Today one attempt closes a task; the table is ready for several attempts per task if "try again tomorrow" becomes a rule.

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

## API

All routes are under `/api` and need `Authorization: Bearer <token>` except login.

| Route | Role | What |
| --- | --- | --- |
| `POST /auth/login`, `GET /auth/me`, `GET /auth/dev-accounts` | | development login |
| `GET /issuances`, `GET /issuances/:id`, `GET /issuances/summary` | manager | board, detail, the cities widget |
| `PATCH /issuances/:id` | manager | priority, delivery date, notes, self pickup |
| `POST /issuances/assign`, `POST /issuances/mark-urgent` | manager | bulk actions |
| `DELETE /issuances/:id` | manager | soft delete with a reason |
| `GET /couriers` | manager | couriers with their open task count |
| `GET /delivery/tasks`, `GET /delivery/tasks/:id` | courier | my tasks (`?tab=all|pending|done&search=`) |
| `POST /delivery/tasks/:id/attempts` | courier | the delivery report |
| `GET /delivery/lookup?number=` | courier | find my task by the printed number |

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
cd server && npm test
```

`npm run test:unit` covers the payload validation and the transition table without a database. `npm run test:e2e` boots the real application against `equipment_supply_test` (created automatically in the Docker container) and checks malformed item answers, concurrent duplicate submissions, reassignment of completed and partially delivered issuances, a batch with a closed issuance, and a report racing a reassignment five times in a row.

## Sample data and what is missing

- Every issuance, courier and customer comes from `server/src/seed/seed.data.ts`. There is no SAP: the interface is not defined and none was invented. The `source` column on an issuance (`sample` today) is the only touch point.
- QR scanning: the dialog shows the camera frame from the design and works through manual number entry. Which camera library, and what the QR encodes, are open.
- Couriers management is a list only. Create, edit and Excel import (spec 2.7.2) have no design.
- Reports and the KPI dashboard: placeholder page. The diagram has a question mark on the KPI definition.
- History, analytics, PDF, SMS and email were not built. They have no screen in the design.
- The manager's "find issuance" button only focuses the search; its behavior on that side was not defined.
- Grouping issuances by address exists on the courier board only, not on the manager table.
- The drag handle on courier cards is visual; route reordering is not implemented.

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

## Design references

`design/` holds the PNG exports of the Figma file (courier screens, manager screens, components, references, spec pages) and the information architecture diagram. It is git ignored because of its size; ask for the folder or the Figma file. Where the exports and the original spec disagree, the exports were followed; where an export shows a design still moving (the designer notes in the manager folder), the modal version was implemented.

## Code style

Client: 2 spaces, double quotes, function components with inline destructured props, `t("key")` for every UI text with keys in `shared/i18n/he.ts`. Server: 2 spaces, single quotes, direct `process.env`, plain `any` payloads instead of DTO classes. Comments explain why, in lowercase English. Top level functions in a TypeScript file are separated by a `/*──...──*/` line. SCSS: 4 spaces, nesting, breakpoints only through the `bp` mixins.
