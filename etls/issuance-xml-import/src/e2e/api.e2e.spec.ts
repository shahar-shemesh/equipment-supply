import * as fs from 'fs/promises';
import * as path from 'path';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { ping } from '../repositories/db';
import { PipelineDeps, runOnce } from '../services/pipeline';
import { countCandidates } from '../services/scanner';
import { Scheduler } from '../services/scheduler';
import { RunStatus } from '../services/status';
import type { RunSummary } from '../types';
import { createLogger } from '../utils/logger';
import { createTestSchema, dbConfig, makeDeps, tempDirs, testPool, truncateAll, xmlDocument } from './setup';

//the three routes and the scheduler on the real pipeline and the real database: the acceptance criteria of the plan

const pool = testPool();
let dirs: PipelineDeps['config']['dirs'];
let root: string;
let deps: PipelineDeps;
let status: RunStatus;

const logger = createLogger('error', {}, () => undefined);
const TOKEN = 'secret-token';
const doc = (id: string, sap: string) => xmlDocument({ id, issuances: [{ sap, customer: { name: 'לקוח' }, address: { street: 'רחוב', city: 'עיר' }, items: [{ line: 1, product: 'מוצר' }] }] });

function wire(p: Pool = pool) {
  status = new RunStatus('etl-api', true);
  const runner = { start: (trigger: 'auto' | 'manual') => status.tryStart(trigger, (id) => runOnce(deps, id, trigger)) };
  return { app: buildApp({ status, runner, db: { ping: () => ping(p) }, auth: { token: TOKEN }, awaiting: () => countCandidates(dirs.input), logger }), runner };
}

beforeAll(async () => {
  await createTestSchema();
  ({ root, dirs } = await tempDirs());
  deps = makeDeps(pool, dirs);
});

afterAll(async () => {
  await pool.end();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(pool);
  for (const dir of Object.values(dirs)) {
    for (const name of await fs.readdir(dir)) await fs.rm(path.join(dir, name), { force: true });
  }
});

describe('GET /health', () => {
  it('says ok with the database up and 503 degraded when it is unreachable, while the process keeps answering', async () => {
    const { app } = wire();
    const ok = await request(app).get('/health');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ok', db: 'up' });

    const dead = new Pool({ ...dbConfig, port: 1, connectionTimeoutMillis: 1500 });
    dead.on('error', () => undefined);
    const { app: degraded } = wire(dead);
    const down = await request(degraded).get('/health');
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ status: 'degraded', db: 'down' });
    await dead.end();
  });
});

describe('POST /run and GET /status', () => {
  it('needs the token, runs the pipeline to the end and answers the summary the status then shows', async () => {
    const { app } = wire();
    await fs.writeFile(path.join(dirs.input, 'one.xml'), doc('SAP-DLV-1', '3000001'));
    expect((await request(app).post('/run')).status).toBe(401);
    expect((await request(app).get('/status')).status).toBe(401);
    expect(await countCandidates(dirs.input)).toBe(1);

    const res = await request(app).post('/run').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ trigger: 'manual', discovered: 1, processed: 1, succeeded: 1, failed: 0, skipped: 0, already_imported: 0, error: null });
    expect(typeof res.body.id).toBe('string');
    expect(Date.parse(res.body.finished_at)).toBeGreaterThanOrEqual(Date.parse(res.body.started_at));
    expect((await pool.query(`SELECT source FROM issuances WHERE sap_number = '3000001'`)).rows).toEqual([{ source: 'sap' }]);

    const st = await request(app).get('/status').set('Authorization', `Bearer ${TOKEN}`);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ enabled: true, running: false, current_run_id: null, instance_id: 'etl-api', last_run: res.body, totals: { runs: 1, files: 1, succeeded: 1, failed: 0 }, awaiting: 0 });
    expect(Date.parse(st.body.started_at)).not.toBeNaN();
  });

  it('answers 409 run_in_progress while a run holds the mutex, with its id', async () => {
    const { app } = wire();
    let release!: () => void;
    const held = status.tryStart('auto', (id) => new Promise<RunSummary>((resolve) => (release = () => resolve({ id, trigger: 'auto', started_at: 't', finished_at: 't', discovered: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, already_imported: 0, error: null }))));
    expect(held.started).toBe(true);
    const res = await request(app).post('/run').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'run_in_progress', run_id: status.currentRunId });
    const st = await request(app).get('/status').set('Authorization', `Bearer ${TOKEN}`);
    expect(st.body).toMatchObject({ running: true, current_run_id: status.currentRunId });
    release();
    await status.whenIdle();
    expect((await request(app).post('/run').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(200);
  });
});

describe('the automatic mode', () => {
  it('imports a dropped file on the first tick without anyone calling /run', async () => {
    const { runner } = wire();
    await fs.writeFile(path.join(dirs.input, 'auto.xml'), doc('SAP-DLV-AUTO', '3000002'));
    const scheduler = new Scheduler({
      pollMs: 60000,
      logger,
      tick: () => {
        const started = runner.start('auto');
        return started.started ? started.run : Promise.resolve(null);
      },
    });
    scheduler.start();
    const deadline = Date.now() + 10000;
    while (status.totals.runs < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await scheduler.stop();
    expect(status.last_run).toMatchObject({ trigger: 'auto', succeeded: 1 });
    expect((await pool.query(`SELECT status, source FROM issuances WHERE sap_number = '3000002'`)).rows).toEqual([{ status: 'unassigned', source: 'sap' }]);
    expect((await pool.query(`SELECT action FROM audit_log`)).rows).toEqual([{ action: 'issuance.import' }]);
    expect((await pool.query(`SELECT status FROM xml_import_files`)).rows).toEqual([{ status: 'completed' }]);
    expect(await fs.readdir(dirs.archive)).toEqual(['auto.xml']);
  });
});
