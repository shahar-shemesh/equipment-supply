---
title: 'Authentication and role based authorization foundation (mock now, Cognito later)'
type: 'feature'
created: '2026-10-14'
status: 'done'
base: 'e31a100'
context: ['AGENTS.md', 'server/src/auth/auth.guard.ts', 'server/src/auth/auth.service.ts', 'client/src/utils/auth.tsx', 'client/src/pages/LoginPage.tsx', 'client/src/routers/AppRouter.tsx']
---

## Intent

**Problem:** The only login is a dev username/password against the seeded `users` table with one role per user. The real identity provider (Entra ID through AWS Cognito) is not available yet, and the product wants a manager to hold the courier role too and to open the courier screens without a second login.

**Approach:** Keep the existing pieces that already fit (JWT guard, `@Roles`, `users` table, `RequireRole`, the courier logout flow) and put an auth provider boundary around them: `AUTH_MODE=mock` issues a signed JWT for one of two predefined identities resolved on the server, `AUTH_MODE=cognito` is a documented, failing-closed boundary. The guard becomes global (deny by default, `@Public()` opt out), roles become an array derived from `users.role` (`manager` gives both roles), and the client gets a provider abstraction plus a two button dev login.

## Boundaries & Constraints

**Always:**
- Roles come from the server: the client sends only an identity key (`manager` | `courier`), the server maps it to a `users` row and derives roles with `rolesOf(user.role)` in `shared/auth.ts` (`manager` gives `[manager, courier]`, `courier` gives `[courier]`).
- `req.user` is the shared `IAuthUser` (`id, username, name, email, roles, courier_id`). Services read `user.id`, never `user.sub`.
- `assertSafeConfig` throws before anything listens when `AUTH_MODE=mock` outside LOCAL without `ALLOW_MOCK_AUTH=true`, when `AUTH_MODE=cognito` lacks `COGNITO_REGION`, `COGNITO_USER_POOL_ID` or `COGNITO_CLIENT_ID`, and on an unknown mode. `AUTH_MODE` and the Cognito variables are read only in `env.ts`.
- Resource level checks stay where they are: `courierIdOf(user)` (delivery and conflicts services) still answers 403 for an account with no courier row, the 404 for another courier's task stays, `lockIssuance` order stays.
- Every UI string through `t()` with the key in `shared/i18n/he.ts`. File style per `AGENTS.md` (client double quotes, server single quotes, lowercase `//why` comments, the `/*──...──*/` separators).
- Logout keeps the deliberate offline rules of `docs/offline-sync.md`: `clearSyncedData(scope)` removes synced data and keeps unsynced reports and drafts as evidence; a full IndexedDB wipe is never done.

**Never:**
- No real AWS or Entra calls, no new dependency (`jose`, `aws-jwt-verify`, amplify) in this plan; the Cognito provider rejects every token with a clear message and the doc says what to add.
- No fake production tokens: the mock JWT is issued only by the mock provider under the mock mode checks.
- No change to `issuance.rules.ts`, the offline conflict rules, the sync worker, or any business rule.
- No client side guess of the mode from an env var: the client asks `GET /api/auth/mode`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mock login manager | `POST /api/auth/mock/login {identity:'manager'}`, mode mock | 201 `{ token, user }`, `user.roles = ['manager','courier']`, `courier_id` = the seeded courier row linked to that user | |
| Mock login courier | `{identity:'courier'}` | `roles = ['courier']`, `courier_id` set | |
| Unknown identity | `{identity:'admin'}` or no body | 400 `identity must be manager or courier` | `auth.validation.ts` |
| Identity without a users row | database not seeded | 503 `mock identity manager has no users row, run the seed` | logged |
| Mock login in cognito mode | `AUTH_MODE=cognito` | 404 | handler throws `NotFoundException` |
| Mode query | `GET /api/auth/mode`, no token | 200 `{ mode: 'mock' }` | public route |
| No token | any guarded route | 401 `missing token` | global guard |
| Bad or expired token | garbage, or expired mock JWT | 401 `token expired or invalid` | provider `verify` rejects |
| Role mismatch | courier token on `GET /api/couriers` | 403 `wrong role for this route` | |
| Manager on courier route | manager token on `GET /api/delivery/tasks` | 200 (role allowed); 403 `this account is not linked to a courier` when the user has no courier row | existing `courierIdOf` |
| Cognito mode token | `AUTH_MODE=cognito` with the three vars, any Bearer | 401 `cognito token verification is not wired yet` | provider boundary |
| Mock outside LOCAL | `ENVIRONMENT=prod AUTH_MODE=mock` | startup throws naming `ALLOW_MOCK_AUTH` | `assertSafeConfig` |
| Client: no user | open `/manager/issuances` | redirect `/login` | |
| Client: courier on manager route | roles `[courier]` on `/manager` | redirect `/courier` | |
| Client: manager on courier route | roles `[manager,courier]` on `/courier` | renders, header link back to `/manager/issuances` | |
| Switch identity | logged in as manager, sign out, sign in as courier | token, user and session keys replaced; the courier start sweeps the manager's synced scope (`clearForeignScopes`), unsynced reports stay | |

## Code Map

- `shared/@core.ts` -- `UserRole`, `IUser` (replaced by `IAuthUser`), add `AuthMode`, `MockIdentity`.
- `shared/auth.ts` (new) -- `rolesOf`, `primaryRole`, `hasRole`; both packages import it.
- `server/src/env.ts` -- `authMode()`, `mockAuthAllowed()` (replaces `devAuthAllowed`), `cognitoConfig()`, `assertSafeConfig`.
- `server/src/auth/auth.provider.ts` (new) -- `AUTH_PROVIDER` token, `AuthProvider { mode; verify(token): Promise<IAuthUser> }`.
- `server/src/auth/mock/mock-identities.ts` (new) -- the two identities `{ key, username, name, email, role }` (`manager` maps to users `manager`, `courier` maps to users `courier1`).
- `server/src/auth/mock/mock-auth.provider.ts` (new) -- `login(identity)`, `issueFor(user)` (shared with the e2e helper), `verify(token)` through `JwtService`; writes the `auth_login` audit row as today.
- `server/src/auth/cognito/cognito-auth.provider.ts` (new) -- holds `cognitoConfig()`, `verify` rejects, logs the boundary once at startup.
- `server/src/auth/auth.guard.ts` -- global guard: `@Public()`, `@Roles()` with `some`, `CurrentUser` typed `IAuthUser`.
- `server/src/auth/auth.module.ts` -- `APP_GUARD`, `AUTH_PROVIDER` factory by `authMode()`; `auth.service.ts` and `auth.constants.ts` are deleted.
- `server/src/auth/auth.controller.ts` -- `GET mode` (public), `POST mock/login` (public, mock mode only), `GET me`.
- `server/src/auth/auth.validation.ts` (new) -- `validateMockLogin(body)`.
- `server/src/entities/user.entity.ts`, `server/src/migrations/1791400000000-AuthMockIdentities.ts` -- drop `password_hash`, add nullable `email`.
- `server/src/seed/seed.data.ts`, `seed.service.ts` -- emails on the users, no bcrypt, a courier row for the mock manager (same name as the `manager` user, `employee_id` `E-1000`) linked to the `manager` user so the manager's courier view has tasks to show.
- `server/src/{issuances,delivery,audit,couriers,xml-export}/*.controller.ts` -- drop `@UseGuards(AuthGuard)`, keep `@Roles`.
- `server/src/delivery/delivery.service.ts`, `conflicts.service.ts`, `issuances/issuances.service.ts`, `audit/audit.service.ts` -- `user.sub` becomes `user.id`, `actor.role` becomes `primaryRole(actor.roles)`.
- `server/src/e2e/auth-helper.ts` (new) -- `tokenFor(app, username)`; every e2e spec uses it instead of `POST /auth/login` and stops writing `password_hash`.
- `client/src/auth/provider.ts` (new) -- `ClientAuthProvider`, `mockAuthProvider`, `cognitoAuthProvider` (throws), `authProviderFor(mode)`.
- `client/src/utils/auth.tsx` -- `mode` from `GET /auth/mode`, `signIn(input)`, `logout`, `homeOf` by roles.
- `client/src/routers/guards.tsx` (new, extracted from `AppRouter.tsx`) -- `RequireRole` by `roles.includes`, `HomeRedirect`.
- `client/src/pages/LoginPage.tsx`, `client/src/styles/_login.scss` -- two buttons in mock mode, boundary message in cognito mode, the existing alerts stay.
- `client/src/manager/ManagerLayout.tsx`, `client/src/courier/CourierLayout.tsx` -- cross links for a two role user; manager sign out also runs `clearSyncedData` when it has a scope.
- `client/src/courier/offline/identity.ts`, `store.ts`, `DeliveryBoard.tsx`, `test/fixtures.ts` -- `IUser` becomes `IAuthUser`, `display_name` becomes `name` (the IndexedDB `meta.display_name` field keeps its name).
- `docs/auth.md` (new), `README.md`, `docs/api.md`, `server/.env.example`, `server/.env` (local, git ignored) -- configuration and the Cognito / Entra steps.

## Tasks & Acceptance

**Execution, part A (shared + server):**
- [x] `shared/@core.ts`, `shared/auth.ts` -- contract first -- both packages compile against it.
- [x] `server/src/env.ts` + `env.spec.ts` -- the mode readers and `assertSafeConfig` cases -- startup is the first lock.
- [x] `server/src/auth/*` -- provider boundary, mock provider, cognito boundary, global guard, controller, validation; `auth.guard.spec.ts`, `auth.validation.spec.ts`, `mock-identities.spec.ts` (every identity names a seeded username), roles spec under `server/src/auth/roles.spec.ts`.
- [x] entity, migration, seed, `seed.spec.ts` if counts change -- `npm uninstall bcryptjs` in `server/` (restore the one line `moduleFileExtensions` array in `package.json` afterwards).
- [x] controllers and services -- global guard, `user.id`.
- [x] `server/src/e2e/auth-helper.ts`, every existing e2e spec, new `auth.e2e.spec.ts` covering the matrix rows that need the app.
- [x] `server/.env.example`, `server/.env`, `main.ts` log line, `e2e/setup-env.ts` (`AUTH_MODE=mock`).

**Execution, part B (client + docs):**
- [x] `client/src/auth/provider.ts` + `provider.spec.ts`.
- [x] `client/src/utils/auth.tsx` + `auth.spec.ts` (sign in both identities, logout clears keys, switch identity replaces them, cognito mode rejects).
- [x] `client/src/routers/guards.tsx` + `guards.spec.ts` (MemoryRouter: no user, wrong role, two role user on both areas).
- [x] `LoginPage.tsx`, `_login.scss`, `ManagerLayout.tsx`, `CourierLayout.tsx` (+ `CourierLayout.spec.ts` if the user fixture shape changes), i18n keys.
- [x] `IUser` to `IAuthUser` sweep, `fixtures.ts`.
- [x] `docs/auth.md`, `README.md` (Authentication, env table, tree line, `## Tests`, `## Status`, open decisions 7 and 11 pointing at the doc, new 17: what a manager sees in the courier screens), `docs/api.md`.

**Acceptance Criteria:**
- Given `AUTH_MODE=mock` and LOCAL, when the manager button is pressed, then the app lands on `/manager/issuances` and the header shows a link to the courier screens; following it renders the courier board without a login.
- Given the courier identity, when `/manager/issuances` is opened by URL, then the app redirects to `/courier` and the header has no manager link.
- Given a manager token, when `GET /api/couriers` and `GET /api/delivery/tasks` are called, then both answer 200; given a courier token the first answers 403.
- Given no `Authorization` header, when any route except `GET /api/auth/mode` and `POST /api/auth/mock/login` is called, then 401.
- Given `ENVIRONMENT` unset and `AUTH_MODE=mock`, when `assertSafeConfig` runs, then it throws and names `ALLOW_MOCK_AUTH`; given `AUTH_MODE=cognito` without `COGNITO_USER_POOL_ID` it throws naming the variable.
- Given a signed in manager who signs out, when the courier identity signs in, then `localStorage` holds the courier's token and user only and the courier start sweeps the manager's synced scope.

## Verification

**Commands:**
- `cd server && npx tsc --noEmit -p tsconfig.json` -- expected: no output.
- `cd server && npm run test:unit 2>&1 | tail -40` -- expected: all suites pass, new specs listed.
- `cd server && npm run test:e2e 2>&1 | tail -40` -- expected: all suites pass (docker db up, port 5433).
- `cd client && npx tsc --noEmit && npm test 2>&1 | tail -40` -- expected: all files pass.
- `cd server && npm run build` -- expected: `dist/server/src/main.js` exists.

**Manual checks:**
- `npm run seed` then both buttons on `/login`; the manager's courier link; `GET /api/auth/mode` without a token.

## Design Notes

Mock JWT payload: `{ sub, username, name, email, roles, courier_id }`, 12h, same `JwtModule` and `jwtSecret()`. `identity.ts` keeps reading `sub`, `courier_id`, `exp`, `username`. The `AuthProvider` factory:

```ts
{ provide: AUTH_PROVIDER, inject: [MockAuthProvider, CognitoAuthProvider], useFactory: (mock, cognito) => (authMode() === AuthMode.cognito ? cognito : mock) }
```

`AuthController` registers `mock/login` always but the handler answers 404 (`NotFoundException`) outside mock mode, so the route table does not depend on env at decoration time.

## Implementation Notes

### Part A (shared + server), 2026-10-14

Done as planned: `shared/@core.ts` (`IUser` replaced by `IAuthUser`, `AuthMode` and `MockIdentity` enums), `shared/auth.ts` (`rolesOf`, `primaryRole`, `hasRole`), `server/src/env.ts` (`authMode`, `mockAuthAllowed`, `cognitoConfig`, `assertSafeConfig`), `server/src/auth/` (provider boundary, mock and cognito providers, global guard with `@Public()`, controller, validation, five specs), the users entity and migration `1791400000000-AuthMockIdentities`, the seed, the controllers and services, the e2e helper and every e2e spec, `.env`, `.env.example`, `main.ts`, `e2e/setup-env.ts`. `bcryptjs` and `@types/bcryptjs` uninstalled, the one line `moduleFileExtensions` array restored.

Decisions:
- The `auth_login` audit row is written in `MockAuthProvider.issueFor`, not in `login`: the e2e helper signs through `issueFor` and the audit spec counts logins per fixture (two logins, `total` 4, the `page=2&size=3` walk), so the counts read the same whichever path issued the token. A token issued is a login on record either way.
- `auth_login_failed` is no longer written: the mock login has no credential to get wrong, an unknown identity is a 400 and a missing users row a 503 (logged). The enum value stays for the rows already in `audit_log`. The audit e2e test of the failed login now asserts that neither refusal leaves a row.
- Service and controller `user` parameters are typed `IAuthUser` (they were `any`), so a leftover `user.sub` is a compile error, not a runtime null.
- The actor type of `AuditEntry` and `OutboxEntry` is `{ id, username, roles }`; the row and the xml payload keep one role column, filled with `primaryRole(roles)` (a manager's actions read as a manager's). The stored xml payload shape (`actor.role`) is unchanged.
- The seed gives the `manager` user a courier row (`דנה לוי`, `E-1000`), appended last so the first three courier indexes keep their rows (the partial / not delivered handcrafted rows still belong to `courier1`). The handcrafted set now spreads its tasks over the four couriers with a login (`loginCouriers` in `seed.data.ts`), the bulk set already picked from the whole array. Users carry `<username>@equipment.local` as email.
- `CognitoAuthProvider` reads `cognitoConfig()` in `onModuleInit` and only when `authMode()` is cognito: both providers are instantiated in both modes (the factory picks one), so the cognito variables must not be required in mock mode. The boundary is logged once there, as a warn.
- `assertSafeConfig` still requires the JWT secret rule in cognito mode: `JwtModule` is registered in both modes (the mock provider signs with it). Dropping it in cognito mode is a later change.
- The feature modules no longer import `AuthModule` (nothing in them injected anything from it once the guard is global); `AuthModule` exports `MockAuthProvider` for the e2e helper and `AUTH_PROVIDER` for anyone who needs the active provider.
- The 404 of `POST /api/auth/mock/login` outside mock mode is covered in `auth.e2e.spec` by flipping `process.env.AUTH_MODE` around the call: `authMode()` is read per request in the controller, the guard's provider is picked once at boot.

Surprises:
- A route that does not exist is a 404 before a 401: a global guard is bound to handlers, so `GET /api/nothing` without a token is not a guard refusal. Asserted as such.
- `pagination.e2e.spec.ts` and `package.json` have CRLF line endings, the rest of the tree LF; the sweeps had to be line ending aware.
- Mixed shapes in the seed `users` array (`courier` on some rows only) are fine for TypeScript, as before.

Files touched (part A): `shared/@core.ts`, `shared/auth.ts` (new); `server/package.json`, `server/package-lock.json`, `server/.env`, `server/.env.example`; `server/src/env.ts`, `env.spec.ts`, `main.ts`; `server/src/auth/auth.provider.ts`, `auth.guard.ts`, `auth.guard.spec.ts`, `auth.module.ts`, `auth.controller.ts`, `auth.validation.ts`, `auth.validation.spec.ts`, `roles.spec.ts`, `mock/mock-identities.ts`, `mock/mock-identities.spec.ts`, `mock/mock-auth.provider.ts`, `cognito/cognito-auth.provider.ts`, `cognito/cognito-auth.provider.spec.ts` (`auth.service.ts` and `auth.constants.ts` deleted); `server/src/entities/user.entity.ts`, `server/src/migrations/1791400000000-AuthMockIdentities.ts`; `server/src/seed/seed.data.ts`, `seed.service.ts`; the six controllers and five feature modules; `delivery.service.ts`, `conflicts.service.ts`, `issuances.service.ts`, `couriers.service.ts`; `audit/audit.service.ts` + spec, `xml-export/xml-outbox.service.ts` + spec; `server/src/e2e/auth-helper.ts`, `auth.e2e.spec.ts` (new), `setup-env.ts` and the ten existing e2e specs.

Verified (from `server/`): `npx tsc --noEmit -p tsconfig.json` clean; `npm run test:unit` 155 tests in 21 suites (was 134 in 16); `npm run test:e2e` 123 tests in 11 suites (was 114 in 10); `npm run build` writes `dist/server/src/main.js`. Server total 278 tests in 32 suites: part B updates `## Tests` and `## Status` in `README.md` with these counts.

Left for part B: the client no longer compiles (`IUser` is gone): `client/src/utils/auth.tsx`, `client/src/courier/offline/identity.ts`, `store.ts`, `client/src/test/fixtures.ts`, plus the `display_name` readers (`DeliveryBoard.tsx`, `ManagerLayout.tsx`, `CourierLayout.spec.ts`). `GET /api/auth/dev-accounts` and `POST /api/auth/login` no longer exist, `LoginPage.tsx` still calls them. `docs/auth.md` is referenced from `.env.example` and the cognito provider's log line and does not exist yet. README lines 60, 114, 115 and `docs/api.md` line 9 still describe `dev-local`.

### Part B (client + docs), 2026-10-14

Done as planned: `client/src/auth/provider.ts` (`ClientAuthProvider`, `mockAuthProvider`, `cognitoAuthProvider`, `authProviderFor`), `client/src/utils/auth.tsx` (mode from `GET /auth/mode`, `signIn`, `logout`, `homeOf` by roles), `client/src/routers/guards.tsx` extracted from `AppRouter.tsx`, `LoginPage.tsx` with the two buttons, `_login.scss`, the cross links in `ManagerLayout.tsx` and `CourierLayout.tsx` (+ `_layout-courier.scss` for the link next to the logout), the manager sign out running `clearSyncedData`, the `IUser` to `IAuthUser` sweep (`identity.ts`, `store.ts`, `fixtures.ts`, `DeliveryBoard.tsx`, `CourierLayout.spec.ts`), the i18n keys, `docs/auth.md`, `README.md`, `docs/api.md`, `docs/domain.md`.

Decisions:
- The context exposes the mode failure as `modeError: boolean` next to `mode: AuthMode | null`. The mode is asked once at mount and asked again on the `online` event when the first request failed, so a login page opened offline recovers without a reload; the login page shows a loading line while `mode` is null and `modeError` false, and "the server is unreachable" when `modeError` is true.
- A stored `es_user` without a `roles` array (the pre-change shape) reads as no session and is dropped with its token at mount (`clearSession()` without a note); the `storage` event path only reads and never drops, so another tab's write is left alone. `normalizeUser` is gone: the server answers `id` itself.
- `signIn` throws when the mode is not known yet; the login page never calls it then (no button is rendered without a mode), so this is a programming error and not a user message.
- A failed mock sign in shows `errorMessage(err)` (the server's message or the generic Hebrew line); `login_failed` ("wrong username or password") was removed with the five other username / password keys. `role_manager` / `role_courier` stay in `he.ts`: they were not on the removal list and are generic labels.
- The manager's sign out runs no sync pass before `clearSyncedData`: the courier worker stopped with its layout when the manager left `/courier`, and whatever is queued goes out on the account's next courier start. Order mirrors `CourierLayout.leave`: `logout()`, then the cleanup, then navigate. No `ManagerLayout` sign out test: the existing pattern (`CourierLayout.spec`) builds a full fake-indexeddb harness per test and the manager layout also needs `useBreakpoint` and the drawer; not cheap, left out as the plan allowed.
- The courier header got an `app-header__actions` wrapper (link + logout) so both sit together on the end side; the existing `.app-header__logout` rules are untouched.
- `docs/domain.md` was updated beyond the grep list: its audit paragraph and table still said `auth.login_failed` is written for a wrong password, which part A ended. `docs/api.md` line 40 (the old `POST /auth/login` contract note) was rewritten too.

Surprises:
- `guards.spec.ts`: re-rendering a `MemoryRouter` into the same root with a new `initialEntries` keeps the first history (React reconciles the same component, the router reads `initialEntries` once). The first two tests passed by coincidence (every path had the same answer); each `open(path)` now gets a fresh root.
- `shared/i18n/he.ts`, `docs/api.md` and `docs/domain.md` have CRLF endings (like `pagination.e2e.spec.ts` in part A); the edits were made line ending aware. `README.md` and the client sources are LF.
- vitest passed on the broken tree before part B (esbuild strips types), only `tsc` showed the `IUser` breakage; the baseline was 119 tests in 14 files.

Files touched (part B): `client/src/auth/provider.ts`, `provider.spec.ts` (new); `client/src/utils/auth.tsx`, `auth.spec.ts`; `client/src/routers/guards.tsx`, `guards.spec.ts` (new), `AppRouter.tsx`; `client/src/pages/LoginPage.tsx`; `client/src/styles/_login.scss`, `_layout-courier.scss`; `client/src/manager/ManagerLayout.tsx`; `client/src/courier/CourierLayout.tsx`, `CourierLayout.spec.ts`; `client/src/courier/offline/identity.ts`, `store.ts`; `client/src/courier/pages/DeliveryBoard.tsx`; `client/src/test/fixtures.ts`; `shared/i18n/he.ts`; `docs/auth.md` (new), `README.md`, `docs/api.md`, `docs/domain.md`.

Verified (from `client/`): `npx tsc --noEmit` clean; `npm test` 129 tests in 16 files (was 119 in 14: `provider` 3, `guards` 3, `auth` 3 kept + 4 new); `npm run build` writes `dist/` with the service worker (8 precache entries). README `## Status` and `## Tests` now say 407 tests (278 server, 129 client), eight migrations. The manual checks of the plan (both buttons on `/login`, the cross links, `GET /api/auth/mode` without a token) were not run in a browser here.

### Author's verification after the review fixes (2026-10-14)

Server: tsc clean, `npm run test:unit` 165 in 22 suites, `npm run test:e2e` 123 in 11 suites. Client: tsc clean, `npm test` 141 in 18 files. Browser (dev client 5173 + api 3000 after `npm run seed`): `GET /api/auth/mode` public, 401 without a token, 400 on `{identity:'admin', roles:[...]}`, the two buttons, the manager on the board with the courier link, the courier screens with the link back, sign out, the courier identity redirected from `/manager/issuances` to `/courier` with no manager link, 403 on `/api/couriers` with the courier token.

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-14): edge case hunter + verification gap, on the combined diff of parts A and B

Verification gap:
1. The `AUTH_PROVIDER` factory choice was never exercised (the e2e talked to the class, not the binding). **Fixed**: `auth.e2e.spec.ts` boots a second application with `AUTH_MODE=cognito`, asserts the token resolves to `CognitoAuthProvider` and that a mock signed token is 401 with the boundary message there.
2. The seeded manager's courier link was pinned by name only. **Fixed**: `mock-identities.spec.ts` asserts the courier row exists in the seed data; `seed.service.ts` throws on a user entry whose courier name matches no row; `audit.e2e.spec.ts` asserts the seeded manager's `courier_id` and a 200 on `/api/delivery/tasks`.
3. `ManagerLayout` sign out and the cross links had no test. **Fixed**: `ManagerLayout.spec.ts` (link, sweep order, no scope) and a manager case in `CourierLayout.spec.ts`.
4. The login page's branch on the mode was untested. **Fixed**: `LoginPage.spec.ts` (loading, unreachable, mock buttons and their identities, a refusal, cognito, signed in).
5. The cross tab `storage` listener was rewired without a test. **Fixed**: one case in `auth.spec.ts`.
6. The migration runs in no test. **Deferred**: no migration harness exists for the seven earlier migrations either; a harness is its own task (already on the handoff's deferred list).
Other: the comment "the server no longer accepts that token's shape" overstated what `verify` did. **Fixed** by making it true: `verify` refuses a token without a `roles` array. The silent skip of the courier link in the seed: **fixed** (throws).

Edge case hunter:
1. A roles list with neither known role would loop between the two homes. **Fixed**: `isSession` in `auth.tsx` requires a known role (stored session and sign in answer); `issueFor` refuses a `users.role` outside the enum with 403.
2. A provider answer without a token or roles. **Fixed**: same `isSession` check, "sign in answer is not a session".
3. A manager without a courier row following the courier link. **Fixed**: the link needs a scope; `RequireRole` sends a manager without `courier_id` back to the board.
4. The mode request failing while online stayed on "unreachable" until a reload. **Fixed**: a 15 second retry next to the `online` listener.
5. `rolesOf` of an unknown role issuing a token with `[]`. **Fixed** (same as 1, server side).
6. A non HTTP exception from `verify` would be a 500. **Fixed**: the guard turns it into 401 `token could not be verified`.
7. `@Roles()` with an empty list would open a route. **Fixed**: the decorator throws on an empty list.
8. README test counts stale. **Fixed** with the final counts after the full runs.
Added by the author during the review: the request time lock in `MockAuthProvider.login` (`mockAuthAllowed()`, 404 like the old dev login's second lock) with `mock-auth.provider.spec.ts`.
