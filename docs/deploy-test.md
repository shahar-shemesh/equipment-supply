# Test deployment on free services

A shared box the team can open in a browser until the AWS environment exists: one Docker image with the NestJS server and the built client, running on Render's free tier, with PostgreSQL on Neon's free plan. Not a pre-production: the login is the mock one, the data is the seed, and the free tiers sleep.

The server serves `client/dist` itself when `CLIENT_DIST` is set (`server/src/client-static.ts`), so the browser talks to one origin and the client keeps calling the relative `/api`. No proxy, no CORS, no second service.

## Read this first

- **Anyone with the URL is a manager.** The box runs `AUTH_MODE=mock`: the login page has two buttons, manager and courier, and no password. It holds the seed data only. Do not share the URL outside the team, never load real issuances into it.
- **It sleeps.** Render stops a free service after 15 minutes without traffic and the next request waits about a minute for it to start (the browser shows Render's loading page). Neon suspends an idle compute after 5 minutes; the first query after that is slower by a moment.
- **Nothing the server writes to disk survives.** The filesystem of a free service is gone on every restart and deploy. All data is in Neon. The XML export is off on this box (`XML_EXPORT_ENABLED` is not set); its outbox rows are written to the database as everywhere.
- **Limits that matter** (the plans of Render and Neon, check the current pages): 750 free instance hours per month for the whole Render workspace, one instance, 1 GB of storage and 100 compute hours per month per Neon project.

## What runs where

| Variable | Value | Set by |
| --- | --- | --- |
| `CLIENT_DIST` | `/app/client/dist` | the Dockerfile |
| `ENVIRONMENT` | `TEST` | `render.yaml` |
| `AUTH_MODE` | `mock` | `render.yaml` |
| `ALLOW_MOCK_AUTH` | `true` | `render.yaml` |
| `JWT_SECRET` | generated | Render, once |
| `PORT` | `10000` | `render.yaml` |
| `DB_SSL` | `true` | `render.yaml` |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | from Neon | you, once, when the Blueprint is created |
| `DB_PORT` | `5432` | `render.yaml` |
| `VITE_MUI_X_LICENSE_KEY` | the MUI X key, optional | you, in the dashboard (build time) |

The image sets neither `NODE_ENV` nor `ENVIRONMENT`. `NODE_ENV=production` would turn the mock login off for good (see [Environment switches](../README.md#environment-switches)), and what a box is belongs to the box. `ENVIRONMENT=TEST` is not LOCAL, so no developer switch opens: the seed is refused, `synchronize` is off, the schema moves with migrations only.

`DB_SSL=true` turns on TLS for both connections (the app's and the migration CLI's) and always verifies the certificate. Neon's certificate comes from Let's Encrypt (ISRG Root X1), which Node already trusts, so nothing has to be installed. Any value other than `true` or `false` stops the server at startup, naming the variable.

## One time setup

### 1. The database on Neon

Create a project (the region next to Render's `frankfurt`, AWS eu-central-1, if the free plan offers it) and note the database name and the role. In the console open Connect and take the **direct** host: the one without `-pooler` in its name (turn Connection pooling off to see it). The pooler runs in transaction mode, which breaks anything that needs a session, and a single instance gains nothing from it.

### 2. Sample data, once, from a laptop, after the first deploy

The schema needs nothing from the laptop. The container runs the migrations before the server listens, and on the empty Neon database the first of them, the baseline, builds every table ([Schema upgrade](domain.md#schema-upgrade)); every later deploy applies whatever migration is new. So do this step once the first deploy of step 4 is live, before the check in step 5: until then the database has no tables and the seed fails on the first one.

`npm run seed` runs only with `ENVIRONMENT=LOCAL` and `ALLOW_DESTRUCTIVE_SEED=true`, and that guard stays as it is: set the two for this one command and point the connection at Neon. dotenv never overrides a variable that is already set, so the shell wins over `server/.env`. Set **all five** `DB_*` variables: one that is missing falls back to the value in your `server/.env`, and the seed truncates every table of whatever database it lands on. For the same reason `DB_SYNCHRONIZE` is set to `false`: `server/.env` usually says `true`, and the schema on Neon belongs to the migrations.

```powershell
cd server
$env:ENVIRONMENT = "LOCAL"
$env:ALLOW_DESTRUCTIVE_SEED = "true"
$env:DB_SYNCHRONIZE = "false"   # the migrations of the first deploy built the tables, synchronize stays off
$env:XML_EXPORT_ENABLED = "false"   # the seed boots the whole app: a server/.env that turns the export worker on would start it against Neon
$env:DB_SSL = "true"
$env:DB_HOST = "<direct host of the Neon project>"
$env:DB_PORT = "5432"
$env:DB_USER = "<role>"
$env:DB_PASSWORD = "<password>"
$env:DB_NAME = "<database>"
npm run seed                    # empties the tables and fills them
```

In bash use `export NAME=value` for the same names. `SEED_BULK=0` seeds the 30 handcrafted issuances only; unset it adds 2000 generated ones (about 10 MB in the database).

Close that terminal afterwards. The variables stay set in it and the next `npm run seed` would run against Neon.

To reset the box to the sample data later, run the same block again. A redeploy never touches the data.

### 3. Render's access to the repository

Render has to read the repository. If it belongs to a GitHub organization, an organization admin has to install the Render GitHub app there (`github.com/apps/render/installations/new`) and, under Repository access, include this repository. Until that is done Render cannot read the repository, so ask for it before anything else in this list.

### 4. The Blueprint

In the Render dashboard: New, Blueprint, pick the repository and branch. Render reads `render.yaml` and asks once for `DB_HOST`, `DB_USER`, `DB_PASSWORD` and `DB_NAME` (the values of step 1). Create it. The first deploy builds the image, the container applies the migrations (on the empty database they build every table), then listens. Now run step 2.

Optional: add `VITE_MUI_X_LICENSE_KEY` in the service's Environment tab. Render passes the variables of a service to the image build as build arguments, and the Dockerfile reads this one; without it the data grid on the manager board draws the MUI watermark. The key ends up in the shipped JavaScript, as it does in any build.

### 5. Check

- `https://<service>.onrender.com/api/auth/mode` answers `{"mode":"mock"}`.
- The root opens the app, the login page offers manager and courier, the manager sees the board.
- The Logs tab of the service has the startup line: `environment: TEST, auth: mock, ... client: /app/client/dist, db tls: on`, and the warning about mock auth.

## Day to day

- A push to the connected branch deploys it (`autoDeployTrigger: commit` in `render.yaml`; `off` makes it manual).
- A change of the schema is a migration (`server/src/migrations/`, see [Schema upgrade](domain.md#schema-upgrade)). It runs before the new server listens; one that fails stops the container and the deploy fails with it.
- The service worker is registered by the built app, so the courier's offline shell works here, over Render's HTTPS.

## Running the image on a laptop

For checking the image before pushing. The compose PostgreSQL (`docker compose up -d`, host port 5433) with a database of its own, never `equipment_supply` or `equipment_supply_test`:

```bash
docker exec equipment-supply-db psql -U equipment -c "CREATE DATABASE equipment_supply_deploytest"
docker build -t equipment-supply:test .
docker run --rm -p 3100:3000 \
  -e ENVIRONMENT=TEST -e AUTH_MODE=mock -e ALLOW_MOCK_AUTH=true -e JWT_SECRET=<anything but the dev default> \
  -e DB_HOST=host.docker.internal -e DB_PORT=5433 -e DB_USER=equipment -e DB_PASSWORD=equipment -e DB_NAME=equipment_supply_deploytest \
  equipment-supply:test
```

Without `ALLOW_MOCK_AUTH` the container exits with the mock auth error, and without `DB_SSL` the connection is plain (the compose database has no TLS). On the empty database the container builds the schema with the migrations; seed it afterwards the way step 2 does (`DB_HOST=localhost`, `DB_PORT=5433`, `DB_USER=equipment`, `DB_PASSWORD=equipment`, no `DB_SSL`, the throwaway database name).

## Teardown

Delete the service in Render (Settings, Delete Service) and the project in Neon. Both hold nothing else. The Render GitHub app can stay installed or be removed from the organization's settings.
