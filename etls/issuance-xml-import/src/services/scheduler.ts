import type { Logger } from '../utils/logger';

//the automatic mode: one tick, then the next one pollMs after it finished. a setTimeout chain and never setInterval,
//so a slow run (a big batch, a database that answers late) never piles ticks up behind it. the tick is the status's
//tryStart, so a manual run in flight makes the tick a no-op. stop() clears the timer and waits for the tick in
//flight, so a shutdown never leaves a file mid transaction. the timer is unref'd: it never keeps a process alive
//that has nothing else to do

export type SchedulerOptions = { pollMs: number; tick: () => Promise<unknown>; logger: Logger };

/*──────────────────────────────────────────────────────────────────────────*/

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inFlight: Promise<unknown> | null = null;

  constructor(private readonly opts: SchedulerOptions) {}

  get isRunning() {
    return !this.stopped;
  }

  //the first tick runs at once, on the next turn of the loop
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => void this.run(), delayMs);
    this.timer.unref?.();
  }

  //a tick never rejects out of here: a failure is a log line, the chain goes on
  private async run() {
    this.timer = null;
    //through a resolved promise, so a tick that throws before returning its promise lands in the catch like a rejection
    this.inFlight = Promise.resolve()
      .then(() => this.opts.tick())
      .catch((e) => this.opts.logger.error('tick failed', { error: (e as Error)?.message ?? String(e) }));
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
      if (!this.stopped) this.schedule(this.opts.pollMs);
    }
  }
}
