import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { EntityManager, Repository } from 'typeorm';

import { AuditAction, AuditActorType, AuditEntityType, IAuditEntry, IAuditPage, UserRole } from '../../../shared/@core';
import { AuditLog } from '../entities';
import { parseAuditQuery } from './audit.validation';

//what a service hands over for one row. actor is the jwt payload of the request (sub, username, role); without one the
//row is the system's (the seed). entity_id and issuance_id are the ids after the change, details are ids and short scalars
export type AuditEntry = {
  actor?: { sub?: number; username?: string; role?: UserRole } | null;
  actor_type?: AuditActorType; //only when there is no actor to derive it from: a failed login is a person, not the system
  action: AuditAction;
  entity_type: AuditEntityType;
  entity_id?: number | null;
  issuance_id?: number | null;
  batch_id?: string | null;
  details?: Record<string, any> | null;
};

//the last line on what goes into details: the callers already send short values, this cuts whatever slipped through.
//the signature and the password hash never belong in a row, those keys are dropped whatever the caller meant
export const DETAIL_STRING_MAX = 200;
const DROPPED_KEYS = new Set(['signature_png', 'password', 'password_hash']);

/*──────────────────────────────────────────────────────────────────────────*/

//the one writer and the one reader of audit_log. record() runs on the caller's EntityManager, after the mutation and
//inside the same transaction, so the row commits or rolls back with the change it describes. it takes no lock: the
//issuance then task lock order belongs to the services, this is an insert at the end
@Injectable()
export class AuditService {
  constructor(@InjectRepository(AuditLog) private rows: Repository<AuditLog>) {}

  record(em: EntityManager, entry: AuditEntry) {
    return em.insert(AuditLog, toRow(entry));
  }

  //outside a transaction: a login (nothing else is written) and the seed (its own writes are plain saves)
  recordDetached(entry: AuditEntry) {
    return this.rows.insert(toRow(entry));
  }

  //the rows of one bulk action share it, so "assigned three issuances in one click" reads back as one event
  static batchId() {
    return randomUUID();
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // GET /api/audit  (manager)  -  newest first. no joins, so plain offset / limit is safe here
  async list(q: any): Promise<IAuditPage> {
    const f = parseAuditQuery(q);
    const qb = this.rows.createQueryBuilder('a').orderBy('a.at', 'DESC').addOrderBy('a.id', 'DESC');
    if (f.issuance_id != null) qb.andWhere('a.issuance_id = :issuanceId', { issuanceId: f.issuance_id });
    if (f.actor_user_id != null) qb.andWhere('a.actor_user_id = :actorId', { actorId: f.actor_user_id });
    if (f.action) qb.andWhere('a.action = :action', { action: f.action });
    if (f.from) qb.andWhere('a.at >= :from', { from: f.from });
    if (f.to) qb.andWhere('a.at < :to', { to: f.to });

    const [rows, total] = await qb.offset((f.page - 1) * f.size).limit(f.size).getManyAndCount();
    return { items: rows.map(toEntry), total };
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

function toRow(entry: AuditEntry): Partial<AuditLog> {
  const actor = entry.actor || null;
  return {
    actor_type: entry.actor_type ?? (actor ? AuditActorType.user : AuditActorType.system),
    actor_user_id: actor?.sub ?? null,
    actor_username: actor?.username ?? null,
    actor_role: actor?.role ?? null,
    action: entry.action,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id ?? null,
    issuance_id: entry.issuance_id ?? null,
    batch_id: entry.batch_id ?? null,
    details: entry.details ? scrub(entry.details) : null,
  };
}

//drops the keys that never belong in a row and cuts long strings. nesting stops at the changes of an edit
//({ field: { from, to } }), where from and to may be arrays of scalars (a courier's zones); anything deeper is left out
export function scrub(value: any, depth = 0): any {
  if (typeof value === 'string') return value.length > DETAIL_STRING_MAX ? value.slice(0, DETAIL_STRING_MAX) : value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return depth <= 3 ? value.map((v) => scrub(v, depth + 1)) : null;
  if (value && typeof value === 'object') {
    if (depth >= 3) return null;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) if (!DROPPED_KEYS.has(k)) out[k] = scrub(v, depth + 1);
    return out;
  }
  return value;
}

function toEntry(r: AuditLog): IAuditEntry {
  return { ...r, at: r.at.toISOString() };
}
