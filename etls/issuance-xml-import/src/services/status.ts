import { randomUUID } from 'crypto';

import type { RunSummary, RunTrigger } from '../types';

//the counters of GET /status and the one in-process mutex the scheduler and POST /run share: a run is started
//through tryStart, which hands the work a run id or says who holds it. the summary of the last run and the totals
//are kept here; nothing is persisted, a restart starts from zero (the database rows are the record)

export type StatusSnapshot = {
  enabled: boolean;
  running: boolean;
  current_run_id: string | null;
  instance_id: string;
  started_at: string;
  last_run: RunSummary | null;
  totals: { runs: number; files: number; succeeded: number; failed: number };
  awaiting: number;
};

type Current = { id: string; trigger: RunTrigger; started_at: string; promise: Promise<RunSummary> };

/*──────────────────────────────────────────────────────────────────────────*/

export class RunStatus {
  readonly started_at: string;
  last_run: RunSummary | null = null;
  readonly totals = { runs: 0, files: 0, succeeded: 0, failed: 0 };
  private current: Current | null = null;

  constructor(
    readonly instanceId: string,
    readonly enabled: boolean,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {
    this.started_at = this.now().toISOString();
  }

  get running() {
    return this.current !== null;
  }

  get currentRunId() {
    return this.current?.id ?? null;
  }

  //the work never rejects by contract (the pipeline turns every failure into its summary), but a programming error
  //must still release the mutex and leave a readable last_run
  tryStart(trigger: RunTrigger, work: (runId: string) => Promise<RunSummary>): { started: true; run: Promise<RunSummary> } | { started: false; run_id: string } {
    if (this.current) return { started: false, run_id: this.current.id };
    const id = this.newId();
    const started_at = this.now().toISOString();
    const promise = work(id)
      .catch((e): RunSummary => ({ id, trigger, started_at, finished_at: this.now().toISOString(), discovered: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, already_imported: 0, error: `run crashed: ${(e as Error)?.message ?? e}` }))
      .then((summary) => {
        this.last_run = summary;
        this.totals.runs++;
        this.totals.files += summary.processed;
        this.totals.succeeded += summary.succeeded;
        this.totals.failed += summary.failed;
        return summary;
      })
      .finally(() => {
        this.current = null;
      });
    this.current = { id, trigger, started_at, promise };
    return { started: true, run: promise };
  }

  //resolves once no run is in flight; the shutdown waits on it
  async whenIdle() {
    while (this.current) await this.current.promise;
  }

  snapshot(awaiting: number): StatusSnapshot {
    return {
      enabled: this.enabled,
      running: this.running,
      current_run_id: this.currentRunId,
      instance_id: this.instanceId,
      started_at: this.started_at,
      last_run: this.last_run,
      totals: { ...this.totals },
      awaiting,
    };
  }
}
