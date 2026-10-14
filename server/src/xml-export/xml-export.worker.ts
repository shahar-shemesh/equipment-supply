import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { XmlOutboxStatus } from '../../../shared/@core';
import { XmlOutbox } from '../entities';
import { XmlExportConfig, xmlExportConfig, xmlExportTarget } from '../env';
import { StorageError, XML_STORAGE, XmlStorage } from './xml-storage';
import { XmlBuildError, XmlBuilderService } from './xml-builder.service';
import { XmlOutboxService } from './xml-outbox.service';

//what one tick did, for the log line and for the specs that call tick() by hand. lost: rows another worker took over
//while this one held them (a lease that ran out under a slow upload, a retry by hand), left to that worker
export type TickSummary = { claimed: number; completed: number; retried: number; failed: number; lost: number };

//claims per tick at most: with the default batch of 20 a tick moves up to a thousand rows, then the next tick continues
const MAX_ROUNDS = 50;

/*──────────────────────────────────────────────────────────────────────────*/

//the polling worker: claim a batch, and per row build the document, put it, mark the row. no network inside a database
//transaction: the claim is one statement, the upload runs on its own, the completion is one statement again. a tick
//in flight skips the next one, so a slow bucket never piles ticks up; the timer is unref'd so it never keeps a process
//alive that is shutting down, and onModuleDestroy waits for the tick in flight so a row is not left mid upload.
//started only with XML_EXPORT_ENABLED=true: the specs never start it, they call tick() on a fake storage
@Injectable()
export class XmlExportWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(XmlExportWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<TickSummary> | null = null;

  constructor(
    private outbox: XmlOutboxService,
    private builder: XmlBuilderService,
    @Inject(XML_STORAGE) private storage: XmlStorage,
  ) {}

  onApplicationBootstrap() {
    const cfg = xmlExportConfig();
    if (!cfg.enabled) return;
    this.timer = setInterval(() => void this.tick(), cfg.pollMs);
    this.timer.unref();
    this.logger.log(`xml export worker on: every ${cfg.pollMs}ms, batch ${cfg.batch}, lease ${cfg.leaseMs}ms, max attempts ${cfg.maxAttempts}, storage ${xmlExportTarget(cfg)}`);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  //one round. public for the specs. returns the summary of the round, or of the tick already in flight when this one
  //was skipped. a tick never rejects: the interval callback has nobody to catch for it and node 20 ends the process on
  //an unhandled rejection, so a database that drops out between the claim and the completion is a logged tick, not a crash
  tick(): Promise<TickSummary> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.round()
      .catch((e): TickSummary => {
        this.logger.error(`xml export: tick aborted, ${e?.message || e}`);
        return { claimed: 0, completed: 0, retried: 0, failed: 0, lost: 0 };
      })
      .finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //claims in rounds until a claim comes back empty: the claim takes one row per issuance (the later sequences wait for
  //the earlier one), so a chain of three changes of one issuance leaves in one tick and not in three. bounded, so a
  //row that keeps coming back cannot hold a tick forever; a transient failure is not claimed again before its backoff anyway
  private async round(): Promise<TickSummary> {
    const cfg = xmlExportConfig();
    const summary: TickSummary = { claimed: 0, completed: 0, retried: 0, failed: 0, lost: 0 };
    for (let rounds = 0; rounds < MAX_ROUNDS; rounds++) {
      let rows: XmlOutbox[];
      try {
        rows = await this.outbox.claim(cfg.batch, cfg.leaseMs);
      } catch (e) {
        //the database is the one dependency the whole process shares; a failed claim is logged and the next tick tries again
        this.logger.error(`xml export: claim failed, ${e?.message || e}`);
        break;
      }
      if (!rows.length) break;
      summary.claimed += rows.length;
      for (const row of rows) {
        const outcome = await this.process(row, cfg);
        if (outcome === XmlOutboxStatus.completed) summary.completed++;
        else if (outcome === XmlOutboxStatus.failed) summary.failed++;
        else if (outcome === null) summary.lost++;
        else summary.retried++;
      }
    }
    if (summary.claimed) this.logger.log(`xml export: tick claimed ${summary.claimed}, completed ${summary.completed}, retried ${summary.retried}, failed ${summary.failed}, lost ${summary.lost}`);
    return summary;
  }

  //renew, build, put, complete; every failure ends in fail() with its category. the attempts of the claim fence every
  //update of the row: a row that is no longer this worker's (the lease ran out under a slow upload and another process
  //took it, a manager retried it by hand) is dropped here as lost, and whoever holds it now writes its outcome
  private async process(row: XmlOutbox, cfg: XmlExportConfig): Promise<XmlOutboxStatus | null> {
    const started = Date.now();
    const tag = `event ${row.id} issuance ${row.issuance_id} sequence ${row.sequence} attempt ${row.attempts}`;

    //the lease again from now: the rows of a batch go one after the other, and the last of a slow batch must not run
    //out of the lease it got at the claim while this worker is still on the earlier ones
    if (!(await this.outbox.renew(row, cfg.leaseMs))) return this.lost(tag);

    //a row that was retried by hand past the limit, or a limit lowered since: no upload, the manager sees it at once
    if (row.attempts > cfg.maxAttempts) {
      return this.settle(row, `attempts: ${row.attempts} claims, the limit is ${cfg.maxAttempts}`, true, cfg.maxAttempts, tag, `attempts over the limit of ${cfg.maxAttempts}`, started);
    }

    let xml: string;
    let sha256: string;
    try {
      ({ xml, sha256 } = this.builder.build(row));
    } catch (e) {
      const message = e instanceof XmlBuildError ? e.message : `unexpected: ${e?.message || e}`;
      return this.settle(row, `xml: ${message}`, true, cfg.maxAttempts, tag, `the document could not be built (${message})`, started);
    }

    const key = objectKey(cfg.prefix, row);
    const metadata = { 'event-id': row.id, 'issuance-id': String(row.issuance_id), sequence: String(row.sequence), 'content-sha256': sha256 };
    try {
      await this.storage.putIfAbsent(key, Buffer.from(xml, 'utf8'), metadata);
    } catch (e) {
      const error = e instanceof StorageError ? e : new StorageError('transient', `unexpected: ${e?.message || e}`, false, e);
      if (error.category === 'precondition') return this.reconcile(row, key, sha256, cfg.maxAttempts, tag, started);
      const category = error.config ? 'config' : error.category;
      return this.settle(row, `${category}: ${error.message}`, error.category === 'permanent', cfg.maxAttempts, tag, `key ${key}, ${category} error ${error.message}`, started);
    }
    //the completion is outside the try on purpose: a database that fails here fails fail() too, so the tick ends with
    //its log line and the row is reclaimed after its lease, where the put meets its own object (the 412 path)
    return this.finish(row, key, sha256, tag, `completed, key ${key}`, started);
  }

  //the key is taken. an object carrying the row's event id is this very row's, from an attempt whose completion never
  //happened (a timeout on the response, a process that died, a lease that ran out): the row is completed without a
  //second object, with the hash the bucket holds. a different hash under the same event id means the document changed
  //between the attempts (a new schema version, a payload edited by hand); the first rendering stays and the log says so,
  //a put would never replace it anyway. another event id under the key is a collision nobody expected, failed for a manager
  private async reconcile(row: XmlOutbox, key: string, sha256: string, maxAttempts: number, tag: string, started: number): Promise<XmlOutboxStatus | null> {
    let existing: { metadata: Record<string, string> } | null;
    try {
      existing = await this.storage.head(key);
    } catch (e) {
      const error = e instanceof StorageError ? e : new StorageError('transient', `unexpected: ${e?.message || e}`, false, e);
      const category = error.config ? 'config' : 'transient';
      return this.settle(row, `${category}: head after 412, ${error.message}`, false, maxAttempts, tag, `key ${key}, head after 412 ${error.message}`, started);
    }
    if (!existing) {
      //a 412 and then nothing under the key: the object went away between the two calls. the next attempt puts again
      return this.settle(row, 'transient: 412 but no object under the key', false, maxAttempts, tag, `key ${key}, 412 but no object under the key`, started);
    }
    const theirs = existing.metadata['event-id'] || '?';
    if (theirs === row.id) {
      const stored = existing.metadata['content-sha256'] || sha256;
      if (stored !== sha256) this.logger.warn(`xml export: ${tag} key ${key} holds an earlier rendering of this event (sha256 ${stored}, this attempt built ${sha256}), kept as it is`);
      return this.finish(row, key, stored, tag, `completed, key ${key} was already there from an earlier attempt`, started);
    }
    return this.settle(row, `key_collision: ${key} holds event ${theirs} sha256 ${existing.metadata['content-sha256'] || '?'}`, true, maxAttempts, tag, `key ${key} holds another object (event ${theirs})`, started);
  }

  //the completion, fenced like every update: false means the row was taken over meanwhile
  private async finish(row: XmlOutbox, key: string, sha256: string, tag: string, how: string, started: number): Promise<XmlOutboxStatus | null> {
    if (!(await this.outbox.complete(row, key, sha256))) return this.lost(tag);
    this.logger.log(`xml export: ${tag} ${how}, ${Date.now() - started}ms`);
    return XmlOutboxStatus.completed;
  }

  //fail() and its log line: a warning while the row will be tried again, an error once it is failed for a manager
  private async settle(row: XmlOutbox, error: string, permanent: boolean, maxAttempts: number, tag: string, what: string, started: number): Promise<XmlOutboxStatus | null> {
    const status = await this.outbox.fail(row, error, permanent, maxAttempts);
    if (!status) return this.lost(tag);
    const line = `xml export: ${tag} ${status === XmlOutboxStatus.failed ? 'failed' : 'will retry'}, ${what}, ${Date.now() - started}ms`;
    if (status === XmlOutboxStatus.failed) this.logger.error(line);
    else this.logger.warn(line);
    return status;
  }

  private lost(tag: string): null {
    this.logger.warn(`xml export: ${tag} is no longer this worker's (the lease ran out and another process took it, or a manager retried it), left to whoever holds it`);
    return null;
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//the same event always lands on the same key: the day folder from occurred_at in utc, the issuance id and the event id.
//a second attempt of a row meets its own object there, never a new one
export function objectKey(prefix: string, row: Pick<XmlOutbox, 'id' | 'issuance_id' | 'occurred_at'>) {
  const at = row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at);
  const day = at.toISOString().slice(0, 10).replace(/-/g, '/');
  return `${prefix}${day}/issuance_${row.issuance_id}_${row.id}.xml`;
}
