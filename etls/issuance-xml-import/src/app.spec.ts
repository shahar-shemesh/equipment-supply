import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AppDeps, buildApp } from './app';
import { RunStatus } from './services/status';
import type { RunSummary } from './types';
import { createLogger } from './utils/logger';

function summary(id: string): RunSummary {
  return { id, trigger: 'manual', started_at: 't', finished_at: 't', discovered: 1, processed: 1, succeeded: 1, failed: 0, skipped: 0, already_imported: 0, error: null };
}

let status: RunStatus;
let dbUp: boolean;
let release: (() => void) | null | undefined; //undefined: the fake run resolves at once; null or a function: it waits for release()
let deps: AppDeps;

beforeEach(() => {
  status = new RunStatus('etl-a', true, () => new Date('2026-10-25T10:00:00Z'), () => 'run-x');
  dbUp = true;
  release = null;
  deps = {
    status,
    runner: {
      start: (trigger) =>
        status.tryStart(trigger, (id) =>
          release === undefined ? Promise.resolve(summary(id)) : new Promise<RunSummary>((resolve) => (release = () => resolve(summary(id)))),
        ),
    },
    db: { ping: async () => dbUp },
    auth: { token: 'secret' },
    awaiting: async () => 4,
    logger: createLogger('error', {}, () => undefined),
  };
});

describe('GET /health', () => {
  it('is open and says ok while the database answers, 503 degraded when it does not', async () => {
    const ok = await request(buildApp(deps)).get('/health');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ok', db: 'up' });
    expect(typeof ok.body.uptime_s).toBe('number');
    expect(ok.headers['x-powered-by']).toBeUndefined();
    dbUp = false;
    const down = await request(buildApp(deps)).get('/health');
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ status: 'degraded', db: 'down' });
  });
});

describe('the bearer token', () => {
  it('refuses /status and /run without it, with another one, or with another scheme, and takes the right one', async () => {
    const app = buildApp(deps);
    expect((await request(app).get('/status')).status).toBe(401);
    expect((await request(app).post('/run')).status).toBe(401);
    expect((await request(app).get('/status').set('Authorization', 'Bearer nope')).status).toBe(401);
    expect((await request(app).get('/status').set('Authorization', 'Bearer secre')).status).toBe(401);
    expect((await request(app).get('/status').set('Authorization', 'Basic secret')).status).toBe(401);
    expect((await request(app).get('/status').set('Authorization', 'Bearer ' + 's'.repeat(300))).status).toBe(401);
    const res = await request(app).get('/status').set('Authorization', 'Bearer secret');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, running: false, current_run_id: null, instance_id: 'etl-a', started_at: '2026-10-25T10:00:00.000Z', last_run: null, totals: { runs: 0, files: 0, succeeded: 0, failed: 0 }, awaiting: 4 });
  });

  it('opens the two routes when no token is configured (LOCAL)', async () => {
    deps.auth.token = null;
    expect((await request(buildApp(deps)).get('/status')).status).toBe(200);
  });
});

describe('POST /run', () => {
  it('runs the pipeline and answers its summary, then /status shows it as the last run', async () => {
    release = undefined;
    const app = buildApp(deps);
    const res = await request(app).post('/run').set('Authorization', 'Bearer secret');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(summary('run-x'));
    const st = await request(app).get('/status').set('Authorization', 'Bearer secret');
    expect(st.body.last_run).toEqual(summary('run-x'));
    expect(st.body.totals).toEqual({ runs: 1, files: 1, succeeded: 1, failed: 0 });
  });

  it('answers 409 run_in_progress with the run id while one runs', async () => {
    const app = buildApp(deps);
    const first = request(app).post('/run').set('Authorization', 'Bearer secret');
    const firstStarted = first.then(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    const second = await request(app).post('/run').set('Authorization', 'Bearer secret');
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ code: 'run_in_progress', run_id: 'run-x' });
    const st = await request(app).get('/status').set('Authorization', 'Bearer secret');
    expect(st.body).toMatchObject({ running: true, current_run_id: 'run-x' });
    release!();
    await firstStarted;
    expect((await first).status).toBe(200);
  });
});

describe('the rest', () => {
  it('answers json 404 on an unknown route', async () => {
    const res = await request(buildApp(deps)).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'not_found' });
  });

  it('answers json 500 when a route throws, without the message', async () => {
    deps.db.ping = async () => {
      throw new Error('internal detail');
    };
    const res = await request(buildApp(deps)).get('/health');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'internal_error' });
  });
});
