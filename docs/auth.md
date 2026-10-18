# Authentication

Who may call the API and open the screens, and how that is decided today and later. The production identity provider is Entra ID through AWS Cognito; neither exists in this code yet. What exists is a boundary with two implementations: a mock login for development and test boxes, and a Cognito provider that holds the configuration and refuses every token until the verification is written. Nothing below claims the Cognito path works.

## Modes

`AUTH_MODE` picks the provider at startup (`server/src/env.ts` is the only reader of it and of the Cognito variables; `server/src/auth/auth.module.ts` wires the provider under the `AUTH_PROVIDER` token):

| Variable | Values | Meaning |
| --- | --- | --- |
| `AUTH_MODE` | `mock` (also unset), `cognito` | which provider verifies tokens and signs people in. Anything else refuses to start |
| `ALLOW_MOCK_AUTH` | `true` | lets `mock` run outside `ENVIRONMENT=LOCAL` (a test box with no identity provider yet). Logged loudly at startup |
| `COGNITO_REGION` | e.g. `il-central-1` | required in `cognito` mode |
| `COGNITO_USER_POOL_ID` | e.g. `il-central-1_XXXXXXXXX` | required in `cognito` mode |
| `COGNITO_CLIENT_ID` | the app client of the pool | required in `cognito` mode |
| `JWT_SECRET` | any string outside LOCAL | signs the mock token. Required and different from the dev default outside LOCAL, in both modes today (the JWT module is registered in both) |

`assertSafeConfig` (`env.ts`, called from `main.ts` before anything listens) refuses to start when:

- `AUTH_MODE` is neither `mock`, `cognito` nor unset;
- `AUTH_MODE=mock` outside LOCAL without `ALLOW_MOCK_AUTH=true` (the error names the variable);
- `AUTH_MODE=cognito` and one of `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` is missing (the error names the one that is);
- `JWT_SECRET` is missing or still the dev default outside LOCAL.

`server/.env.example` carries every variable with a comment. The e2e suite runs with `AUTH_MODE=mock` (`server/src/e2e/setup-env.ts`).

## Mock identities

`POST /api/auth/mock/login { identity }` takes one of two keys, `manager` or `courier` (`MockIdentity` in `shared/@core.ts`). The server resolves the key to a seeded `users` row (`server/src/auth/mock/mock-identities.ts`, pinned to `server/src/seed/seed.data.ts` by `mock-identities.spec.ts`) and derives everything else from the row; the client sends the key and nothing else:

| Key | `users.username` | Name | Roles | Courier row |
| --- | --- | --- | --- | --- |
| `manager` | `manager` | דנה לוי | `manager`, `courier` | yes: the seed creates a courier row with the same name (`E-1000`) and links it to the user, so the manager's courier view has tasks to show |
| `courier` | `courier1` | יוסי אברהם | `courier` | yes |

Roles come from `rolesOf(users.role)` in `shared/auth.ts`: a `manager` row gives `[manager, courier]`, a `courier` row gives `[courier]`. The list is derived when the token is issued and again when it is verified; the client reads the list it was given. `primaryRole(roles)` is the one role the audit log and the XML payload keep in their single role column (the higher one wins).

The answer is `{ token, user }` with `user` an `IAuthUser` (`id, username, name, email, roles, courier_id`). The token is a 12 hour JWT signed with `JWT_SECRET`, claims `{ sub, username, name, email, roles, courier_id, exp }`; `GET /api/auth/me` answers the same `IAuthUser` for a valid token. A `users` row that is missing answers 503 (`run the seed`), an unknown key 400, a row whose `role` is outside the enum 403 (no token with an empty role list), and outside mock mode, or when `mockAuthAllowed()` is false at request time (the second lock behind the startup check), the route answers 404 as if it did not exist. `verify` refuses a token without a `roles` array (one signed before the roles existed, still inside its 12 hours) as a whole, so an old session is a 401 on every route and the client signs in again. Every token issued, by the login or by the e2e helper (`server/src/e2e/auth-helper.ts`), writes one `auth.login` audit row; `auth.login_failed` is no longer written (there is no credential to get wrong), the enum value stays for the rows already stored.

## The guard

`AuthGuard` (`server/src/auth/auth.guard.ts`) is registered as `APP_GUARD`: every route is denied by default. The opt outs and the role check:

- `@Public()` on a handler or a controller: no token needed. Today: `GET /api/auth/mode` and `POST /api/auth/mock/login`. Every unguarded route is spelled out where it is declared.
- `@Roles(...)` on a controller or a handler: one of the listed roles is enough (any-of). A manager therefore passes a courier route. No `@Roles` means any signed in user; `@Roles()` with an empty list throws when the class loads, because a handler's list replaces the class's and an empty one would open the route.
- The guard hands the bearer token to the active provider's `verify(token)` and puts the answered `IAuthUser` on `req.user` (`@CurrentUser()`); it never looks inside the token itself. A missing header is 401 `missing token`, a token the provider rejects 401 (`token expired or invalid` from the mock provider, `cognito token verification is not wired yet` from the Cognito one), a role mismatch 403 `wrong role for this route`. A provider that fails with something other than an HTTP exception (a JWKS fetch that failed, once Cognito is wired) is 401 `token could not be verified`, never a 500.
- Resource checks stay in the services: `courierIdOf(user)` in `delivery.service.ts` and `conflicts.service.ts` answers 403 `this account is not linked to a courier` for an account without a courier row, another courier's task is a 404, the issuance lock order (`lockIssuance`, then the task) is unchanged. A route that does not exist is a 404 before the guard runs (guards are bound to handlers).

## Client

- `client/src/auth/provider.ts` is the client side of the boundary: `ClientAuthProvider { mode, signIn(input) }`. `mockAuthProvider.signIn({ identity })` posts `{ identity }` to `/auth/mock/login`; `cognitoAuthProvider.signIn` rejects with a pointer to this document; `authProviderFor(mode)` picks one.
- `client/src/utils/auth.tsx` (`AuthProvider`, `useAuth`) asks `GET /api/auth/mode` once at mount (again on the `online` event and every 15 seconds while the request keeps failing) and exposes `{ user, mode, modeError, signIn, logout }`. `signIn` stores the token and the `IAuthUser` in `localStorage` (`es_token`, `es_user`) as the server answered them, after checking the answer is a session (a string token and a `roles` list with `manager` or `courier` in it; anything else is an error and nothing is stored); `logout` clears both through `clearSession` with the note for the login page. The 12 hour expiry watcher and the cross tab `storage` listener are unchanged. A session stored before the roles existed (an `es_user` without a `roles` array) reads as no session and is dropped with its token at mount, so the person signs in again.
- `client/src/pages/LoginPage.tsx` shows what the mode allows: in `mock` a warning banner and two buttons (manager, courier); in `cognito` an info alert and no button; a loading line until the mode is known and an error alert when the server cannot be reached. The offline, session end and pending work alerts are the same as before.
- `client/src/routers/guards.tsx`: `RequireRole` sends a visitor without a session to `/login` and a session without the route's role to its home (`homeOf`: `/manager/issuances` when the roles include `manager`, else `/courier`); `HomeRedirect` is the catch all. A manager passes both trees, except a manager without a courier row (`courier_id` null): the courier screens work by that row, so a typed `/courier` goes back to the board and the manager header shows no courier link.
- Cross links for a two role account: the manager header and drawer carry "מסך המשנע" (`/courier`) when the roles include `courier` and the account has a courier row; the courier header carries "מסך הניהול" (`/manager/issuances`) next to the logout when the roles include `manager`. No second login on either side.
- Logout and user switching. The courier logout flow is the one in [Offline courier work](offline-sync.md) (a sync pass first, then the worker stops, the session ends, `clearSyncedData(scope)` removes the snapshot, the cached details and the acknowledged reports; the unsent and the rejected reports and the drafts stay as evidence under their scope). The manager's sign out runs `clearSyncedData(scope)` too when the account has a courier scope (the manager opened the courier screens under it), without a sync pass: the courier worker stopped with its layout, and whatever is queued goes out on the account's next courier start. Signing in as the other identity afterwards replaces the token and the user in `localStorage`; the first courier start of the new account sweeps the other account's synced data (`clearForeignScopes`) and never sends the other account's reports. A full IndexedDB wipe is never done, for the reasons in that document.

## Connecting Cognito later

What the Cognito mode needs before a real token is accepted. None of it is written; the provider boundary is where it goes.

Server (`server/src/auth/cognito/cognito-auth.provider.ts`, `verify`):

1. Add a verifier: `aws-jwt-verify` (Amazon's, knows the pool's JWKS and the Cognito claim names) or `jose` (generic JWKS + JWT). The dependency is deliberately not in the tree today.
2. Verify the access token against the pool's JWKS at `https://cognito-idp.<COGNITO_REGION>.amazonaws.com/<COGNITO_USER_POOL_ID>/.well-known/jwks.json`, with the issuer (`https://cognito-idp.<region>.amazonaws.com/<pool id>`), the client id (`client_id` claim on an access token, `aud` on an id token) and `token_use` (`access`) checked, plus expiry. Cache the JWKS; both libraries do.
3. Map the claims to an `IAuthUser`: `sub` is the Cognito identity, `email` (or `username`) the lookup key into `users` by email, `cognito:groups` the role source. Derive `roles` with `rolesOf` from the `users.role` the row holds, or from the group when the groups become the source of truth; either way the list is built on the server. `courier_id` is the `couriers` row with `user_id` = the user's id, as the mock provider does.
4. Decide what happens to a verified token with no `users` row: create the row on first sight (name and email from the claims, the role from the group) or refuse with 403. Add an `external_id` column (the Cognito `sub`) later so a changed email does not orphan the row; today the entity has none.
5. Drop the `JWT_SECRET` requirement in cognito mode once the mock provider is not registered there (today the JWT module is registered in both modes).

Client:

1. Sign in through the pool's Hosted UI with the authorization code flow and PKCE (or Amplify's `signIn` / `signInWithRedirect`, which does the same). The pool federates Entra as its identity provider, so the Hosted UI redirects to Entra and back.
2. Where the token lands: the access token (the one the API verifies) goes where `signIn` puts the mock token today (`localStorage` `es_token`), the `IAuthUser` comes from `GET /api/auth/me` after the redirect, not from the token. `cognitoAuthProvider.signIn` is the place: it starts the redirect, and the callback route finishes it.
3. Refresh: Cognito access tokens last up to 24 hours (configurable per app client); use the refresh token to renew before `exp` instead of the 12 hour client side end, or keep the end and ask for a new sign in. `watchTokenExpiry` reads `exp` only, so it keeps working either way.
4. Logout: clear the session as today, then redirect to the pool's `/logout` endpoint with the client id and a logout URI, which ends the Hosted UI session (and Entra's, when configured).
5. What `identity.ts` needs from the token: `sub` and `courier_id` (the scope of the offline data, `<users.id>:<couriers.id>`) and `exp`. A Cognito token carries its own `sub` (not `users.id`) and no `courier_id`, so either the scope is built from `GET /api/auth/me` once and stored next to the token, or `decodeJwt` learns to read a custom claim the pool adds (a pre token generation Lambda can add `custom:user_id` and `custom:courier_id`). `tokenMatchesScope` compares the token's `sub` with the scope's user id before every background request, so the two must be the same number or the comparison must move to the stored user.

## Connecting Entra ID

Entra ID is not called directly; it is federated into the Cognito user pool:

1. In the pool, add an OIDC identity provider pointing at the Entra tenant (issuer `https://login.microsoftonline.com/<tenant id>/v2.0`, the Entra app registration's client id and secret, scopes `openid profile email`). The Hosted UI then offers Entra as the sign in.
2. Attribute mapping: Entra's `email` (or `preferred_username`) to the pool's `email`, `name` to `name`. The pool's `email` is what the server uses to find the `users` row.
3. Roles: map Entra app roles or security groups to Cognito groups (`cognito:groups` in the token) with a pre token generation Lambda, or keep the role on the `users` row and ignore the groups. The server derives the role list in both cases.

## What is not done

- No real token is verified anywhere: `AUTH_MODE=cognito` refuses every request.
- No refresh: the mock token ends after 12 hours and the client signs in again.
- No account provisioning: the mock identities map to seeded rows; a Cognito user with no `users` row has no defined outcome yet, and the entity has no `external_id`.
- No Hosted UI, PKCE or Amplify code on the client; `cognitoAuthProvider.signIn` throws.
- Open decisions 7, 11 and 17 in the README depend on the above.
