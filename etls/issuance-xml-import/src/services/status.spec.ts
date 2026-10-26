import { describe, expect, it } from 'vitest';

import type { RunSummary } from '../types';
import { RunStatus } from './status';

function summary(id: string, extra: Partial<RunSummary> = {}): RunSummary {
  return { id, trigger: 'auto', started_at: 't', finished_at: 't', discovered: 2, processed: 2, succeeded: 1, failed: 1, skipped: 0, already_imported: 0, error: null, ...extra };
}

describe('RunStatus', () => {
  it('starts one run at a time and answers the holder to the second caller', async () => {
    let release!: () => void;
    const ids = ['run-1', 'run-2'][Symbol.iterator]();
    const status = new RunStatus('etl-a', true, () => new Date('2026-10-25T10:00:00Z'), () => ids.next().value!);
    const first = status.tryStart('auto', (id) => new Promise<RunSummary>((resolve) => (release = () => resolve(summary(id)))));
    expect(first).toMatchObject({ started: true });
    expect(status.running).toBe(true);
    expect(status.currentRunId).toBe('run-1');
    expect(status.tryStart('manual', async (id) => summary(id))).toEqual({ started: false, run_id: 'run-1' });

    release();
    await (first as { run: Promise<RunSummary> }).run;
    expect(status.running).toBe(false);
    expect(status.last_run?.id).toBe('run-1');
    expect(status.totals).toEqual({ runs: 1, files: 2, succeeded: 1, failed: 1 });
    expect(status.snapshot(3)).toEqual({ enabled: true, running: false, current_run_id: null, instance_id: 'etl-a', started_at: '2026-10-25T10:00:00.000Z', last_run: summary('run-1'), totals: { runs: 1, files: 2, succeeded: 1, failed: 1 }, awaiting: 3 });

    const second = status.tryStart('manual', async (id) => summary(id, { trigger: 'manual' }));
    expect(second).toMatchObject({ started: true });
    expect(await (second as { run: Promise<RunSummary> }).run).toMatchObject({ id: 'run-2', trigger: 'manual' });
    expect(status.totals.runs).toBe(2);
  });

  it('turns a crashed run into a summary with the error and releases the mutex', async () => {
    const status = new RunStatus('etl-a', false);
    const r = status.tryStart('auto', async () => {
      throw new Error('boom');
    });
    const result = await (r as { run: Promise<RunSummary> }).run;
    expect(result.error).toBe('run crashed: boom');
    expect(status.running).toBe(false);
    expect(status.last_run).toBe(result);
  });

  it('whenIdle resolves after the run in flight', async () => {
    const status = new RunStatus('etl-a', true);
    let release!: () => void;
    status.tryStart('auto', (id) => new Promise<RunSummary>((resolve) => (release = () => resolve(summary(id)))));
    let idle = false;
    const waiting = status.whenIdle().then(() => (idle = true));
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await waiting;
    expect(idle).toBe(true);
    await status.whenIdle();
  });
});
