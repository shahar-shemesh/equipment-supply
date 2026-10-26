import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../utils/logger';
import { Scheduler } from './scheduler';

const lines: string[] = [];
const logger = createLogger('debug', {}, (line) => lines.push(line));

beforeEach(() => {
  vi.useFakeTimers();
  lines.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Scheduler', () => {
  it('ticks at once, then pollMs after each tick finished, never overlapping', async () => {
    const calls: number[] = [];
    let release!: () => void;
    const scheduler = new Scheduler({
      pollMs: 1000,
      logger,
      tick: () => {
        calls.push(Date.now());
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    const t0 = Date.now();
    scheduler.start();
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([t0]);

    //the first tick is still running: time passes, nothing new starts
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBe(6000);
    release();
    await scheduler.stop();
  });

  it('stop clears the next tick and waits for the one in flight; start twice is one chain', async () => {
    let inFlight = 0;
    let release!: () => void;
    const scheduler = new Scheduler({
      pollMs: 1000,
      logger,
      tick: () => {
        inFlight++;
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(inFlight).toBe(1);
    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(inFlight).toBe(1);
    expect(scheduler.isRunning).toBe(false);
  });

  it('logs a tick that rejects and keeps the chain', async () => {
    let n = 0;
    const scheduler = new Scheduler({
      pollMs: 100,
      logger,
      tick: async () => {
        n++;
        if (n === 1) throw new Error('db down');
      },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(n).toBe(2);
    expect(lines.some((l) => l.includes('"msg":"tick failed"') && l.includes('db down'))).toBe(true);
    await scheduler.stop();
  });
});
