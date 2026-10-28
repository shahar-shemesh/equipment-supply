import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { EntityManager, In, Repository } from 'typeorm';

import { AuditAction, AuditActorType, AuditEntityType, IAuditEntry, IAuditPage, UserRole } from '../../../shared/@core';
import { primaryRole } from '../../../shared/auth';
import { AuditLog, Courier, Issuance, User } from '../entities';
import { parseAuditQuery } from './audit.validation';

//what a service hands over for one row. actor is the request's user (id, username, roles; the row keeps the primary
//role, a manager's actions are a manager's); without one the row is the system's (the seed). entity_id and issuance_id are the ids after the change, details are ids and short scalars
export type AuditEntry = {
  actor?: { id?: number; username?: string; roles?: UserRole[] } | null;
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

  // GET /api/audit  (manager)  -  newest first unless order=asc. no joins, so plain offset / limit is safe here; the
  // names the screen prints are looked up afterwards for the one page (namesFor)
  async list(q: any): Promise<IAuditPage> {
    const f = parseAuditQuery(q);
    const dir = f.order === 'asc' ? 'ASC' : 'DESC';
    const qb = this.rows.createQueryBuilder('a').orderBy('a.at', dir).addOrderBy('a.id', dir);
    if (f.issuance_id != null) qb.andWhere('a.issuance_id = :issuanceId', { issuanceId: f.issuance_id });
    if (f.actor_user_id != null) qb.andWhere('a.actor_user_id = :actorId', { actorId: f.actor_user_id });
    if (f.actions) qb.andWhere('a.action IN (:...actions)', { actions: f.actions });
    if (f.from) qb.andWhere('a.at >= :from', { from: f.from });
    if (f.to) qb.andWhere('a.at < :to', { to: f.to });
    //the text search: the username copied on the row, the user's current name (a rename after the fact still finds the
    //rows) and the issuance number. the OR scans whatever the other filters leave; users and couriers are tiny and
    //sap_number is unique indexed, fine at this table's growth (docs/api.md). no wildcard escaping, like the board's search
    if (f.q) {
      qb.andWhere(
        '(a.actor_username ILIKE :like OR a.actor_user_id IN (SELECT u.id FROM users u WHERE u.display_name ILIKE :like OR u.username ILIKE :like) OR a.issuance_id IN (SELECT i.id FROM issuances i WHERE i.sap_number ILIKE :like))',
        { like: `%${f.q}%` },
      );
    }

    const [rows, total] = await qb.offset((f.page - 1) * f.size).limit(f.size).getManyAndCount();
    const names = await this.namesFor(rows);
    return { items: rows.map((r) => toEntry(r, names)), total };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //three IN (...) reads for the ids of one page, each skipped when the page names none. live rows only: a deleted account
  //has no users row any more (the entry falls back to actor_username), an inactive courier still has its row and is found
  private async namesFor(rows: AuditLog[]): Promise<Names> {
    const em = this.rows.manager;
    const ids = <T>(pick: (r: AuditLog) => T | null | undefined) => Array.from(new Set(rows.map(pick).filter((v) => v != null)));
    const userIds = ids((r) => r.actor_user_id);
    const issuanceIds = ids((r) => r.issuance_id);
    const courierIds = ids(courierIdOf);
    const [users, issuances, couriers] = await Promise.all([
      userIds.length ? em.getRepository(User).find({ where: { id: In(userIds) }, select: ['id', 'display_name'] }) : ([] as User[]),
      issuanceIds.length ? em.getRepository(Issuance).find({ where: { id: In(issuanceIds) }, select: ['id', 'sap_number'] }) : ([] as Issuance[]),
      courierIds.length ? em.getRepository(Courier).find({ where: { id: In(courierIds) }, select: ['id', 'name'] }) : ([] as Courier[]),
    ]);
    return {
      users: new Map(users.map((u) => [u.id, u.display_name])),
      issuances: new Map(issuances.map((i) => [i.id, i.sap_number])),
      couriers: new Map(couriers.map((c) => [c.id, c.name])),
    };
  }
}

type Names = { users: Map<number, string>; issuances: Map<number, string>; couriers: Map<number, string> };

//the courier a row is about: the row's own entity on a courier action, the one in details on an assign (the entity
//there is the issuance). the delivery rows name a task, not a courier, and get none
function courierIdOf(r: AuditLog): number | null {
  if (r.entity_type === AuditEntityType.courier) return r.entity_id;
  if (r.action === AuditAction.issuance_assign) return typeof r.details?.courier_id === 'number' ? r.details.courier_id : null;
  return null;
}

/*──────────────────────────────────────────────────────────────────────────*/

function toRow(entry: AuditEntry): Partial<AuditLog> {
  const actor = entry.actor || null;
  return {
    actor_type: entry.actor_type ?? (actor ? AuditActorType.user : AuditActorType.system),
    actor_user_id: actor?.id ?? null,
    actor_username: actor?.username ?? null,
    actor_role: primaryRole(actor?.roles),
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

function toEntry(r: AuditLog, names: Names): IAuditEntry {
  const courierId = courierIdOf(r);
  return {
    ...r,
    at: r.at.toISOString(),
    actor_name: (r.actor_user_id != null && names.users.get(r.actor_user_id)) || null,
    issuance_number: (r.issuance_id != null && names.issuances.get(r.issuance_id)) || null,
    courier_name: (courierId != null && names.couriers.get(courierId)) || null,
  };
}
