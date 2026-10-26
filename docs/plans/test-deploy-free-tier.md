---
title: 'Test deployment on free services'
type: 'chore'
created: '2026-10-26'
status: 'done'
base: '7a30113'
context: ['AGENTS.md', 'server/src/env.ts', 'server/src/main.ts']
---

## Intent

**Problem:** the app only runs on a laptop: the client reaches the api through the vite proxy and the server answers json only. Until the AWS environment exists the team has no shared box to test on.

**Approach:** one Docker image holds the server and the built client, the server serves `client/dist` itself when `CLIENT_DIST` is set (same origin, the client already calls relative `/api`). PostgreSQL on Neon free, the service on Render free through a Blueprint, in the "shared test box" mode `env.ts` already has (`ENVIRONMENT=TEST`, `AUTH_MODE=mock`, `ALLOW_MOCK_AUTH=true`).

## Boundaries & Constraints

**Always:** the image is generic, it sets neither `NODE_ENV` nor `ENVIRONMENT` (`NODE_ENV=production` would lock mock auth out); `render.yaml` carries the test box values. `env.ts` is the only reader of the two new variables and a bad value throws at startup naming the variable. Static serving is off unless `CLIENT_DIST` is set. Migrations run on container start, before the server listens.

**Never:** loosen the seed guard, the mock auth rules or the production lock; touch `client/` sources; add a dependency; commit or push; verify against `equipment_supply` or `equipment_supply_test` (a throwaway database name only); write a secret into a file.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Static off | `CLIENT_DIST` unset, `GET /` | 404 json as today | No error expected |
| SPA route | `CLIENT_DIST` set, `GET /courier` | `index.html`, 200, `no-cache` | No error expected |
| Hashed asset | `GET /assets/<hash>.js` | the file, `immutable` one year | missing file: 404, never `index.html` |
| Worker files | `GET /sw.js`, `/site.webmanifest` | the file, `no-cache` | No error expected |
| Api path | `GET /api/nothing` | Nest's 404 json, never `index.html` | No error expected |
| Non GET | `POST /courier` | not served by the fallback (404) | No error expected |
| Bad dir | `CLIENT_DIST` points at a folder without `index.html` | startup throws, names `CLIENT_DIST` | server does not listen |
| TLS | `DB_SSL` unset or `false` / `true` / other | no ssl / `{ rejectUnauthorized: true }` / throws naming `DB_SSL` | startup error |

## Code Map

- `server/src/env.ts` -- `clientDist()`, `dbSsl()`, both validated in `assertSafeConfig`
- `server/src/main.ts` -- mounts the client after helmet; its comment "no static files" is stale then
- `server/src/client-static.ts` (new) -- the express mount: static with cache headers, extensionless GET/HEAD fallback skipping `/api`
- `server/src/app.module.ts`, `server/src/data-source.ts` -- add `ssl: dbSsl()`
- `server/src/env.spec.ts` and `server/src/client-static.spec.ts` (new, supertest on a bare express app) -- unit tests, no database
- `Dockerfile`, `.dockerignore`, `render.yaml` (new, repo root); `docs/deploy-test.md` (new); `server/.env.example`; `README.md` (documentation link, env switches, test counts)

## Tasks & Acceptance

**Execution:**
- [x] `server/src/env.ts` -- add the two readers and their checks in `assertSafeConfig` -- one place decides
- [x] `server/src/client-static.ts`, `main.ts` -- serve the client; helmet stays, relax only what the built app needs, with the reason in a comment (index.html has no inline script, Rubik loads from fonts.googleapis.com)
- [x] `server/src/app.module.ts`, `data-source.ts` -- `ssl: dbSsl()` in both
- [x] specs -- every row of the matrix
- [x] `Dockerfile` -- stages: client build, server build and `npm prune --omit=dev`, runtime as user `node`, `ENV CLIENT_DIST`, start `npm run migration:run:prod && node dist/server/src/main.js`; optional `ARG VITE_MUI_X_LICENSE_KEY`
- [x] `render.yaml`, `docs/deploy-test.md`, `.env.example`, README -- Neon direct (non pooled) host, one time migrate and seed from a laptop, org admin must authorize the Render GitHub app, cold start ~1 minute after 15 idle, mock login means anyone with the URL is a manager (seed data only, do not share the URL), teardown

**Acceptance Criteria:**
- Given a fresh throwaway database on the compose postgres, when the image starts with the test box variables, then migrations apply, `GET /api/auth/mode` answers `{"mode":"mock"}` and `GET /courier` answers the app shell.
- Given the container, when it starts without `ALLOW_MOCK_AUTH`, then it exits with the existing mock auth error.
- Given the built app in a browser over the container, then login as manager works and the service worker registers.

## Verification

**Commands:**
- `cd server && npx tsc --noEmit -p tsconfig.json && npm run test:unit 2>&1 | tail -40` -- expected: green, new specs included
- `cd client && npm run build 2>&1 | tail -15` -- expected: builds, no source change
- `docker build -t equipment-supply:test .` -- expected: succeeds
- `docker run` against `host.docker.internal:5433`, database `equipment_supply_deploytest`, then curl `/`, `/api/auth/mode`, `/courier`, `/assets/...`, `/sw.js` -- expected: per the matrix

**Manual checks:** the built app in the browser pane against the container: manager login, no CSP console error, `navigator.serviceWorker.ready` resolves.

## Implementation Notes

2026-10-26

**Decisions**
- `env.ts`: `clientDist()` returns the absolute folder or `null` and requires `index.html` to be a file; `dbSsl()` returns `false` or `{ rejectUnauthorized: true }`, the certificate is always verified (no switch). Both run in `assertSafeConfig`, which also prints `client:` and `db tls:` in the startup line.
- `client-static.ts`: `express.static` with `index: false`; `/assets/*` gets `public, max-age=31536000, immutable`, every other file `no-cache` (sw.js, site.webmanifest, manifest.webmanifest, workbox-*.js, icons, index.html). The fallback answers GET and HEAD of a path with no extension, never `/api` or `/assets/`; both are compared lower case because express routes case blind (`/API/auth/mode` must still reach the api). `express` is imported although it is not in `server/package.json`: it comes with `@nestjs/platform-express`, is hoisted, and survives `npm prune --omit=dev` (the container runs it). No dependency added.
- helmet: the defaults cover the built app (Rubik is a stylesheet and font files over https, which `style-src` and `font-src` of the defaults allow). One exception, `worker-src 'self' blob:`, only while `CLIENT_DIST` is set: qr-scanner's fallback decoder (no BarcodeDetector: iPad Safari, desktop Firefox) starts its worker from a `blob:` URL (`createWorker` in `qr-scanner-worker.min.js`). Checked in the browser pane: under helmet's default CSP a blob worker errors, under the container's CSP it runs.
- `Dockerfile`: `node:20-alpine`, three stages, `# check=skip=SecretsUsedInArgOrEnv` for the `ARG VITE_MUI_X_LICENSE_KEY` lint (the key is in the shipped bundle anyway). No `chown`, the runtime copy is root owned and read only for user `node`. `exec node` so SIGTERM reaches it: `docker stop` takes 1.5 s, exit 0. `.dockerignore` keeps every `.env` out (server/.env says LOCAL, client/.env holds the license key). Image 335 MB, no `.env` file in it, neither `NODE_ENV` nor `ENVIRONMENT` set.
- `render.yaml`: region `frankfurt`, `autoDeployTrigger: commit`, `PORT=10000`, `DB_PORT=5432`, four `sync: false` values, `JWT_SECRET` generated. The keys were checked against Render's Blueprint spec page; Render's docs say service env vars become Docker build args, which the `ARG` relies on. Neon's free region list was not confirmed.
- README: counts only for the tests (server 298 to 314 tests, 34 to 35 suites, 169 to 185 unit; total 554 to 570), plus the documentation link, the layout lines, the stack row and a paragraph on the two switches.

**Surprises**
- The ten migrations cannot build an empty database: they only alter tables that exist (the base tables have no migration, docs/domain.md). The first start of the image on an empty database stops at `relation "issuances" does not exist`, exit 1, nothing listens. The one time laptop step in `docs/deploy-test.md` therefore is: `npm run seed` with `ENVIRONMENT=LOCAL`, `ALLOW_DESTRUCTIVE_SEED=true` and `DB_SYNCHRONIZE=true` (synchronize creates the tables, the seed fills them), then `npm run migration:run` (records the ten, each a no-op). Verified on the throwaway database (2030 issuances, 10 MB).
- A tab opened by URL in the desktop app's browser cannot register a service worker (`An unknown error occurred when fetching the script`), also on a plain `vite preview` of the same dist, so it is not the server. A temporary `.claude/launch.json` entry with `url` and `preview_start` by name registered it (`navigator.serviceWorker.ready` resolved, state activated). The entry is removed again, launch.json is as tracked.
- Port 3101 on this machine is taken by another process (json 404 on `/`), not touched; the CSP check used 3187.
- The laptop `server/.env` has the xml export worker on, so the seed process started it against the throwaway database; `server/exports` has no new file.

**Files touched**
`server/src/env.ts`, `server/src/env.spec.ts`, `server/src/client-static.ts` (new), `server/src/client-static.spec.ts` (new), `server/src/main.ts`, `server/src/app.module.ts`, `server/src/data-source.ts`, `server/.env.example`, `Dockerfile`, `.dockerignore`, `render.yaml`, `docs/deploy-test.md`, `README.md`, this plan. `client/dist` was rebuilt (git ignored). Throwaway database, containers and the `equipment-supply:test` image are removed.

**Verified**
- `npx tsc --noEmit -p tsconfig.json` clean; `npm run test:unit`: 23 suites, 185 tests (16 new: 7 in `env.spec.ts`, 9 in `client-static.spec.ts`).
- `client`: `npm run build` builds, no source change.
- `docker build` succeeds, `docker build --check` has no warnings.
- Container on `host.docker.internal:5433`, database `equipment_supply_deploytest`, one migration left pending: it applied on start, `/api/auth/mode` `{"mode":"mock"}`, `/` and `/courier` and `/manager/issuances` the shell with `no-cache` and the CSP with `worker-src`, `/assets/index-*.js` immutable, `/assets/missing-abc.js` and `/assets/missing` 404 json, `/sw.js` and `/site.webmanifest` `no-cache` (conditional GET 304), `/api/nothing` 404 json, `POST /courier` 404 json, `HEAD /courier` 200, `/API/auth/mode` reaches the api.
- Container without `ALLOW_MOCK_AUTH`: exit 1 with the mock auth error. `CLIENT_DIST` at a folder without index.html: exit 1 naming `CLIENT_DIST`. `DB_SSL=yes`: exit 1 naming `DB_SSL`. `DB_SSL=true` against the compose database (no TLS): exit 1, `The server does not support SSL connections`, so the setting reaches the migration connection. `CLIENT_DIST` blank: `/`, `/courier`, `/sw.js` 404 json, api unchanged.
- Browser pane over the container: manager login works and the board loads, the service worker registers and activates, no CSP console error, Rubik loaded, deep route fetch returns the shell.

**Not verified**
- Nothing ran on Render or Neon: no real TLS handshake with Neon (the Node bundle holds ISRG Root X1, Neon's documented root), no Blueprint creation, no build-arg pass-through on Render, the free plan's Neon regions.
- The QR fallback worker itself (no camera in the pane); only the CSP allowance was checked.

## Plan Change Log

- 2026-10-26: Acceptance criterion 1 ("a fresh throwaway database ... the image starts, then migrations apply") cannot hold on an empty database, see Surprises above. Verified instead on a throwaway database prepared as the doc's step 2 says, with the last migration row deleted so the container had one to apply. A baseline migration that makes an empty database buildable by the container is the alternative; it touches `server/src/migrations/`, `docs/domain.md` and the migration e2e harness, outside this plan, so it is left as a question.

- 2026-10-26 (review pass 1): `client-static.ts` no longer imports `express`; static files go through nest's `useStaticAssets` (no dependency was added, and none is relied on by hoisting). helmet and the mount moved out of `main.ts` into `applyHttpDefaults(app, dist)` in `client-static.ts`, so the spec runs what `main.ts` runs. The spec now boots a real nest express app. Counts after: server 319 tests in 36 suites (190 unit, 129 e2e), total 575; README updated to match. Must survive: no dependency added, `CLIENT_DIST` unset keeps the server json only, the worker-src exception only with `CLIENT_DIST` set.

- 2026-10-26 (after this plan): the one time laptop `synchronize` step of the Surprises above is gone. `Baseline1790000000000` (`docs/plans/baseline-migration.md`) lets the container build the empty Neon database itself; `docs/deploy-test.md` step 2 is the seed only, after the first deploy.

## Review Triage Log

**Pass 1, 2026-10-26.** Two reviewers on the diff (edge cases with this plan as claims file, verification gaps). Nine findings, five fixed, two refuted or accepted as is, two deferred.

- Edge case: `//api/x` (doubled leading slash) got `index.html` -- fixed: the guard collapses doubled slashes (`client-static.ts`), the spec has the rows `//api/ping`, `//api/nothing`, `///API/nothing`. Verified in the container: `//api/auth/mode` is the json 404.
- Edge case: seed against Neon from a laptop whose `server/.env` has `XML_EXPORT_ENABLED=true` starts the export worker against Neon -- fixed: the doc's block sets `XML_EXPORT_ENABLED=false` for that run. The reviewer's trace was right: this machine's seed log showed the worker on.
- Edge case and claims check: `express` imported without being a dependency -- fixed (see Plan Change Log), reported by both reviewers.
- Verification gap: the `main.ts` wiring (helmet options, `worker-src`, the mount after helmet) had no test -- fixed: `applyHttpDefaults` and spec rows for the CSP on html, assets, an api route and a 404, with and without `CLIENT_DIST`.
- Verification gap: `ssl: dbSsl()` in `data-source.ts` not asserted -- fixed: `data-source.spec.ts` (`true` gives `{ rejectUnauthorized: true }`, `false` gives `false`, synchronize stays off).
- Verification gap: `ssl: dbSsl()` in `app.module.ts` not asserted -- deferred. Asserting it means hoisting the TypeORM options out of `AppModule`, a refactor outside this plan. The line is the same one-liner as the tested one, and a missing line fails loud on the first deploy (the app cannot connect to Neon).
- Verification gap: no repeatable image smoke check -- deferred. The repo has no CI and no docker test path; the manual recipe is in this plan's Verified section.
- Edge case: the service worker's own fetches of the Google Fonts files run under `sw.js`'s CSP, which has no `connect-src` for them -- not changed, not verified. The CSP of a worker's `fetch()` of an intercepted request follows the request's destination (style, font), which `style-src` and `font-src` allow over https; whether workbox's copy of the request keeps that destination was not checked in a controlled tab. Worst case Rubik falls back to the system font offline. Adding `connect-src` for the two hosts without evidence would widen the CSP for a guess.
- Reviewer note on the unrelated ` D etls/issuance-xml-import/.env.example` -- not this task's, left alone.
