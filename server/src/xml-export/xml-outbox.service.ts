import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { EntityManager, Repository } from 'typeorm';

import { AuditAction, AuditActorType, AuditEntityType, IXmlExportEvent, IXmlExportOverview, IssuanceStatus, UserRole, XmlOutboxStatus } from '../../../shared/@core';
import { AuditService } from '../audit/audit.service';
import { Issuance, XmlOutbox } from '../entities';
import { FORBIDDEN_DETAIL_KEYS, XmlOutboxPayload } from './xml-builder.service';

//what a service hands over after it wrote a status. issuance is the row as it is after the change (the snapshot keeps
//seven fields of it, never the customer), actor the jwt payload of the request, trigger the audit action of the same
//change, details ids and short scalars like the audit row's
export type OutboxEntry = {
  issuance: Pick<Issuance, 'id' | 'sap_number' | 'number_prefix' | 'priority' | 'delivery_date' | 'self_pickup' | 'revision'>;
  from: IssuanceStatus;
  to: IssuanceStatus;
  actor?: { sub?: number; username?: string; role?: UserRole } | null;
  trigger: AuditAction;
  details?: Record<string, any> | null;
};

//the claim: pending rows whose retry time came, and processing rows whose lease ran out (a worker that died mid way).
//one statement, so two processes never take the same row (SKIP LOCKED) and the attempts counter moves with the claim:
//that number is the fence of every later update of the row (renew, complete, fail), so a worker that lost its lease and
//finishes late matches nothing and the worker that reclaimed the row writes the outcome.
//per issuance order: a row is not taken while an earlier sequence of the same issuance is still pending or processing;
//a failed one does not block (the consumer sees the gap, the manager's retry closes it). created_at first, then
//sequence: id is a uuid and says nothing about order
const CLAIM_SQL = `UPDATE xml_outbox SET status = '${XmlOutboxStatus.processing}', attempts = attempts + 1, lease_until = now() + $1::int * interval '1 millisecond'
WHERE id IN (SELECT c.id FROM xml_outbox c
  WHERE ((c.status = '${XmlOutboxStatus.pending}' AND c.next_retry_at <= now()) OR (c.status = '${XmlOutboxStatus.processing}' AND c.lease_until < now()))
    AND NOT EXISTS (SELECT 1 FROM xml_outbox p WHERE p.issuance_id = c.issuance_id AND p.sequence < c.sequence AND p.status IN ('${XmlOutboxStatus.pending}', '${XmlOutboxStatus.processing}'))
  ORDER BY c.created_at, c.sequence LIMIT $2 FOR UPDATE SKIP LOCKED)
RETURNING *`;

//what the worker hands back for a row it holds: the id and the attempts number of its claim, the fence of every later
//update (see claim)
export type Claimed = Pick<XmlOutbox, 'id' | 'attempts'>;

//the manager's overview answers at most this many failed rows, oldest first: the ones waiting longest come first
const FAILED_LIMIT = 100;
const LAST_ERROR_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*──────────────────────────────────────────────────────────────────────────*/

//the writer and the queue side of xml_outbox. record() runs on the caller's EntityManager, after the status write and
//the audit row, inside the same transaction, so the row commits or rolls back with the change it describes. it takes
//no lock: the issuance then task lock order belongs to the services, this is an insert at the end. the rest is the
//worker's (claim, complete, fail) and the manager's (overview, retry)
@Injectable()
export class XmlOutboxService {
  constructor(
    @InjectRepository(XmlOutbox) private rows: Repository<XmlOutbox>,
    private audit: AuditService,
  ) {}

  //no row when the status did not move (a reassign of an assigned issuance): the guard lives here, not at the call
  //sites. the sequence is one above the issuance's highest (not its row count: a row a retention job removed must not
  //make the next one collide with the unique index), safe because every caller holds the issuance lock
  async record(em: EntityManager, entry: OutboxEntry) {
    if (entry.from === entry.to) return;
    const last = await em.createQueryBuilder(XmlOutbox, 'x').select('COALESCE(MAX(x.sequence), 0)', 'max').where('x.issuance_id = :id', { id: entry.issuance.id }).getRawOne<{ max: number | string }>();
    await em.insert(XmlOutbox, {
      id: randomUUID(),
      issuance_id: entry.issuance.id,
      sequence: Number(last?.max ?? 0) + 1,
      previous_status: entry.from,
      new_status: entry.to,
      trigger: entry.trigger,
      payload: toPayload(entry) as Record<string, any>,
      status: XmlOutboxStatus.pending,
      attempts: 0,
      //the database clock, the one the claim compares with: a server whose clock runs ahead must not make every new row wait
      next_retry_at: () => 'now()',
      occurred_at: new Date(),
    });
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //up to batch rows, now processing with a lease of leaseMs, attempts already counted. pg gives the dates back as Date
  //objects and the jsonb parsed, the rows read like entities. typeorm answers an UPDATE ... RETURNING with
  //[rows, affected], hence the destructuring
  async claim(batch: number, leaseMs: number): Promise<XmlOutbox[]> {
    const [rows] = await this.rows.query(CLAIM_SQL, [leaseMs, batch]);
    return rows;
  }

  //the lease again from now, before an upload: a batch goes one row after the other and the last rows of a slow batch
  //would otherwise outlive the lease they got at the claim. false when the row is no longer this worker's
  async renew(row: Claimed, leaseMs: number) {
    const [, affected] = await this.rows.query(`UPDATE xml_outbox SET lease_until = now() + $2::int * interval '1 millisecond' WHERE id = $1 AND status = '${XmlOutboxStatus.processing}' AND attempts = $3`, [row.id, leaseMs, row.attempts]);
    return affected > 0;
  }

  //fenced on the attempts of the claim, like renew and fail: false when the row was taken over meanwhile, and whoever
  //holds it now writes its outcome (the same key, the 412 path)
  async complete(row: Claimed, s3Key: string, sha256: string) {
    const [, affected] = await this.rows.query(`UPDATE xml_outbox SET status = '${XmlOutboxStatus.completed}', processed_at = now(), s3_key = $2, content_sha256 = $3, lease_until = NULL, last_error = NULL WHERE id = $1 AND status = '${XmlOutboxStatus.processing}' AND attempts = $4`, [row.id, s3Key, sha256, row.attempts]);
    return affected > 0;
  }

  //permanent, or out of attempts: failed, for a manager. otherwise back to pending after the backoff of this attempt,
  //counted from the database clock. the lease is released either way. null when the row was no longer this worker's
  async fail(row: XmlOutbox, error: string, permanent: boolean, maxAttempts: number): Promise<XmlOutboxStatus | null> {
    const lastError = error.length > LAST_ERROR_MAX ? error.slice(0, LAST_ERROR_MAX) : error;
    const final = permanent || row.attempts >= maxAttempts;
    const status = final ? XmlOutboxStatus.failed : XmlOutboxStatus.pending;
    const delayMs = final ? 0 : backoffMs(row.attempts);
    const [, affected] = await this.rows.query(`UPDATE xml_outbox SET status = $2, next_retry_at = now() + $3::int * interval '1 millisecond', lease_until = NULL, last_error = $4 WHERE id = $1 AND status = '${XmlOutboxStatus.processing}' AND attempts = $5`, [row.id, status, delayMs, lastError, row.attempts]);
    return affected > 0 ? status : null;
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // GET /api/xml-export  (manager)
  async overview(): Promise<IXmlExportOverview> {
    const [c] = await this.rows.query(`SELECT
      COUNT(*) FILTER (WHERE status = '${XmlOutboxStatus.pending}')::int AS pending,
      COUNT(*) FILTER (WHERE status = '${XmlOutboxStatus.processing}')::int AS processing,
      COUNT(*) FILTER (WHERE status = '${XmlOutboxStatus.completed}')::int AS completed,
      COUNT(*) FILTER (WHERE status = '${XmlOutboxStatus.failed}')::int AS failed,
      COUNT(*) FILTER (WHERE status = '${XmlOutboxStatus.pending}' AND next_retry_at > now())::int AS retry_waiting,
      COUNT(*) FILTER (WHERE status = '${XmlOutboxStatus.processing}' AND lease_until < now())::int AS lease_expired
      FROM xml_outbox`);
    const failed = await this.rows.find({ where: { status: XmlOutboxStatus.failed }, order: { created_at: 'ASC', sequence: 'ASC' }, take: FAILED_LIMIT });
    return { counts: { pending: c.pending, processing: c.processing, completed: c.completed, failed: c.failed, retry_waiting: c.retry_waiting, lease_expired: c.lease_expired }, failed: failed.map(toEvent) };
  }

  // POST /api/xml-export/:id/retry  (manager)  -  a failed row goes back to the queue with a fresh attempts count.
  //under the row's own lock so two managers clicking together write one audit row, not two. only the outbox row is
  //locked, no issuance: the export side never touches the issuance tables
  async retry(id: string, user: any): Promise<IXmlExportEvent> {
    if (typeof id !== 'string' || !UUID.test(id)) throw new BadRequestException('id must be a uuid');
    return this.rows.manager.transaction(async (em) => {
      const row = await em.getRepository(XmlOutbox).createQueryBuilder('x').setLock('pessimistic_write').where('x.id = :id', { id }).getOne();
      if (!row) throw new NotFoundException(`xml export ${id} not found`);
      if (row.status !== XmlOutboxStatus.failed) {
        throw new ConflictException({ statusCode: 409, message: `xml export ${id} is ${row.status}, only a failed one is retried`, code: 'not_failed', status: row.status });
      }
      await em.update(XmlOutbox, id, { status: XmlOutboxStatus.pending, attempts: 0, next_retry_at: new Date(), lease_until: null, last_error: null });
      await this.audit.record(em, { actor: user, action: AuditAction.xml_export_retry, entity_type: AuditEntityType.issuance, entity_id: row.issuance_id, issuance_id: row.issuance_id, details: { event_id: id, sequence: row.sequence, previous_attempts: row.attempts, last_error: row.last_error } });
      return toEvent(await em.findOneByOrFail(XmlOutbox, { id }));
    });
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//5s, 10s, 20s... capped at 15 minutes, with half the value of jitter either way so a burst of failures (the bucket was
//gone for a minute) does not come back as one burst of retries. attempt is the count after the claim, so the first
//failure waits 5s
export const BACKOFF_BASE_MS = 5000;
export const BACKOFF_CAP_MS = 15 * 60 * 1000;

export function backoffMs(attempt: number, random = Math.random) {
  const exponent = Math.max(attempt, 1) - 1;
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(exponent, 30), BACKOFF_CAP_MS);
  return Math.round(base * (0.5 + random()));
}

//the snapshot. seven fields of the issuance, the actor as the audit row keeps it, the details filtered to scalars with
//the forbidden keys dropped: a caller that passes the whole issuance by mistake does not put the customer in the bucket
export function toPayload(entry: OutboxEntry): XmlOutboxPayload {
  const i = entry.issuance;
  const actor = entry.actor || null;
  const details: XmlOutboxPayload['details'] = {};
  for (const [k, v] of Object.entries(entry.details || {})) {
    if (FORBIDDEN_DETAIL_KEYS.has(k)) continue;
    if (v instanceof Date) details[k] = v.toISOString();
    else if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') details[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) : v;
  }
  return {
    issuance: { id: i.id, sap_number: i.sap_number, number_prefix: i.number_prefix ?? null, priority: i.priority, delivery_date: i.delivery_date ?? null, self_pickup: !!i.self_pickup, revision: i.revision },
    actor: { type: actor ? AuditActorType.user : AuditActorType.system, user_id: actor?.sub ?? null, username: actor?.username ?? null, role: actor?.role ?? null },
    details,
  };
}

function toEvent(r: XmlOutbox): IXmlExportEvent {
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    id: r.id,
    issuance_id: r.issuance_id,
    sequence: r.sequence,
    previous_status: r.previous_status,
    new_status: r.new_status,
    trigger: r.trigger,
    status: r.status,
    attempts: r.attempts,
    next_retry_at: iso(r.next_retry_at),
    created_at: iso(r.created_at),
    occurred_at: iso(r.occurred_at),
    lease_until: iso(r.lease_until),
    processed_at: iso(r.processed_at),
    s3_key: r.s3_key,
    content_sha256: r.content_sha256,
    last_error: r.last_error,
  };
}
