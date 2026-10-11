import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { AuditAction, AuditEntityType, IssuanceSortKey, IssuanceStatus, Priority, TaskStatus } from '../../../shared/@core';
import { Issuance, DeliveryTask, DeliveryAttempt, Courier } from '../entities';
import { AuditService } from '../audit/audit.service';
import { changesBetween, snapshot } from '../audit/audit.diff';
import { handedOver, outcomeOf, validateItemAnswers, validateRecipient, validateSignature } from '../delivery/attempt.validation';
import { assertCanDo, editableStatuses } from './issuance.rules';

//the courier on the open task, or on the last closed one, the same pick as withCurrentTask below. a correlated subselect
//instead of a join: an issuance has several tasks over time and a join would multiply the rows under offset / limit.
//a self pickup issuance shows nobody (its courier side ended, the handover did not happen yet), and once the manager
//handed over at the warehouse that task has no courier (LEFT JOIN gives null) and the manager's name takes the place.
//pagination.e2e.spec holds a copy of this expression, change both
export const COURIER_NAME_SQL = `CASE WHEN i.status = '${IssuanceStatus.self_pickup}' THEN NULL ELSE COALESCE((SELECT c.name FROM delivery_tasks t LEFT JOIN couriers c ON c.id = t.courier_id WHERE t.issuance_id = i.id AND t.status != '${TaskStatus.cancelled}' ORDER BY (t.status = '${TaskStatus.pending}') DESC, t.id DESC LIMIT 1), (SELECT u.display_name FROM users u WHERE u.id = i.delivered_by_user_id)) END`;

//the enums sort in the order the manager thinks in (open work first), not in the alphabet of their values
const STATUS_RANK_SQL = `CASE i.status WHEN '${IssuanceStatus.unassigned}' THEN 0 WHEN '${IssuanceStatus.assigned}' THEN 1 WHEN '${IssuanceStatus.partially_delivered}' THEN 2 WHEN '${IssuanceStatus.not_delivered}' THEN 3 WHEN '${IssuanceStatus.delivered}' THEN 4 WHEN '${IssuanceStatus.self_pickup}' THEN 5 ELSE 6 END`;
const PRIORITY_RANK_SQL = `CASE i.priority WHEN '${Priority.urgent}' THEN 0 ELSE 1 END`;

//what ?sort= may name, and the sql each one orders by (columns, or the aliases selected in list())
const SORT_COLUMNS: Record<IssuanceSortKey, string> = {
  number: 'i.sap_number',
  customer: 'i.customer_name',
  destination: 'i.address_street',
  city: 'i.address_city',
  courier: 'courier_name',
  priority: 'priority_rank',
  status: 'status_rank',
};

//the open task, or the last closed one when there is no open task. the board shows its courier, or the manager who
//handed over at the warehouse when that task has none. a self pickup issuance has no current task and no name at all:
//the courier side ended and the handover is still ahead, the same pick as COURIER_NAME_SQL above.
//the delivered_by relation is a users row (password hash included), only its display name leaves the server.
//items are sorted here and not in the query: an ORDER BY on a joined column breaks typeorm's skip/take (it paginates distinct rows, not distinct issuances)
export function withCurrentTask(issuance: Issuance) {
  const { delivered_by, ...rest } = issuance;
  const waiting = issuance.status === IssuanceStatus.self_pickup;
  const tasks = (issuance.tasks || []).filter((t) => t.status !== TaskStatus.cancelled);
  const current = waiting ? null : tasks.find((t) => t.status === TaskStatus.pending) || tasks.sort((a, b) => b.id - a.id)[0] || null;
  const items = (issuance.items || []).sort((a, b) => a.line_no - b.line_no);
  return { ...rest, items, current_task: current, delivered_by_name: waiting ? null : delivered_by?.display_name ?? null };
}

/*──────────────────────────────────────────────────────────────────────────*/

//SELECT ... FOR UPDATE on one issuance row. every flow that changes an issuance or its tasks (assign, self pickup, delete here,
//the courier's report in delivery.service) takes this lock first and only then touches tasks. same order everywhere, so two
//flows on the same issuance run one after the other instead of deadlocking or both succeeding
export function lockIssuance(em: EntityManager, id: number) {
  return em.getRepository(Issuance).createQueryBuilder('i').setLock('pessimistic_write').where('i.id = :id', { id }).getOne();
}

export async function cancelOpenTasks(em: EntityManager, issuanceId: number) {
  await em.update(DeliveryTask, { issuance_id: issuanceId, status: TaskStatus.pending }, { status: TaskStatus.cancelled, closed_at: new Date() });
}

function isIsoDate(s: any) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

//the board's status quick actions and city multi select send one comma list (status=assigned,delivered); one value is
//a list of one, so the old single value form still works, compared verbatim as before (no trim: a city stored with
//outer spaces is offered as is by the summary and must still match). blank items are dropped, nothing left means no filter
function listOf(v: any) {
  const list = v == null ? [] : String(v).split(',').filter(Boolean);
  return list.length ? list : null;
}

//what PATCH may change, and what the audit row of an edit compares before and after
const EDIT_FIELDS = ['priority', 'delivery_date', 'notes'];

/*──────────────────────────────────────────────────────────────────────────*/

@Injectable()
export class IssuancesService {
  private readonly logger = new Logger(IssuancesService.name);

  constructor(
    @InjectRepository(Issuance) private issuances: Repository<Issuance>,
    @InjectRepository(DeliveryTask) private tasks: Repository<DeliveryTask>,
    @InjectRepository(Courier) private couriers: Repository<Courier>,
    private audit: AuditService,
  ) {}

  // /api/issuances?status=&priority=&city=&customer=&courier_id=&date=&search=&sort=&order=&page=&page_size=
  //two queries on purpose: the page of ids comes from a flat query with plain offset / limit, where any sort expression
  //(the courier subselect, the CASE ranks) is safe. the entities with their relations are loaded for those ids after.
  //typeorm's skip / take on a joined query paginates joined rows and breaks as soon as the order touches a joined column
  async list(q: any) {
    const page = Math.max(+q.page || 1, 1);
    const pageSize = Math.min(+q.page_size || 15, 100);
    const sortKey = q.sort ? (String(q.sort) as IssuanceSortKey) : null;
    if (sortKey && !SORT_COLUMNS[sortKey]) throw new BadRequestException(`unknown sort column ${sortKey}`);
    const dir: 'ASC' | 'DESC' = String(q.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const qb = this.issuances
      .createQueryBuilder('i')
      .select('i.id', 'id')
      .addSelect(COURIER_NAME_SQL, 'courier_name')
      .addSelect(STATUS_RANK_SQL, 'status_rank')
      .addSelect(PRIORITY_RANK_SQL, 'priority_rank')
      .where('i.deleted_at IS NULL');

    const status = listOf(q.status);
    if (status) qb.andWhere('i.status IN (:...status)', { status });
    //QR lookup must not match a partial number, address or customer name.
    if (q.number != null) {
      if (typeof q.number !== 'string' || !/^\d+$/.test(q.number)) throw new BadRequestException('number must contain digits only');
      qb.andWhere('i.sap_number = :number', { number: q.number });
    }
    const priority = listOf(q.priority);
    if (priority) qb.andWhere('i.priority IN (:...priority)', { priority });
    const city = listOf(q.city);
    if (city) qb.andWhere('i.address_city IN (:...city)', { city });
    if (q.customer) qb.andWhere('i.customer_name ILIKE :customer', { customer: `%${q.customer}%` });
    if (q.date) qb.andWhere('i.delivery_date = :date', { date: q.date });
    if (q.courier_id) {
      qb.andWhere('EXISTS (SELECT 1 FROM delivery_tasks t WHERE t.issuance_id = i.id AND t.courier_id = :courierId AND t.status = :pending)', { courierId: +q.courier_id, pending: TaskStatus.pending });
    }
    if (q.search) {
      qb.andWhere('(i.sap_number ILIKE :s OR i.customer_name ILIKE :s OR i.address_street ILIKE :s OR i.address_city ILIKE :s)', { s: `%${q.search}%` });
    }

    const total = await qb.getCount();

    if (sortKey) {
      qb.orderBy(SORT_COLUMNS[sortKey], dir, 'NULLS LAST').addOrderBy('i.id', 'ASC');
    } else {
      //nothing chosen: urgent first, then by delivery date, the order the board has opened with from day one
      qb.orderBy('priority_rank', 'ASC').addOrderBy('i.delivery_date', 'ASC', 'NULLS LAST').addOrderBy('i.id', 'ASC');
    }

    const ids = (await qb.offset((page - 1) * pageSize).limit(pageSize).getRawMany()).map((r) => +r.id);
    if (!ids.length) return { rows: [], total, page, page_size: pageSize };

    const entities = await this.issuances.find({ where: { id: In(ids) }, relations: { items: true, tasks: { courier: true }, delivered_by: true } });
    //find() has its own order, the id list is the order of the page
    const byId = new Map(entities.map((e) => [e.id, e]));
    // console.log('issuances.list', { page, pageSize, total, sortKey, dir });
    return { rows: ids.map((id) => withCurrentTask(byId.get(id))), total, page, page_size: pageSize };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  async findOne(id: number) {
    const issuance = await this.issuances.findOne({
      where: { id },
      relations: { items: true, tasks: { courier: true, attempts: { items: true } }, delivered_by: true },
      order: { items: { line_no: 'ASC' }, tasks: { id: 'ASC' } },
    });
    if (!issuance) throw new NotFoundException(`issuance ${id} not found`);
    return withCurrentTask(issuance);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // POST /api/issuances/:id/self-pickup/report  (IAttemptPayload without the offline fields)
  //the warehouse manager hands the equipment over at the warehouse: the courier's report payload, checked by the same
  //validators, stored as an attempt on a task that never had a courier, and the outcome mirrored on the issuance exactly
  //as a courier report does. self_pickup stays true, the manager from the token is recorded as the one who delivered.
  //online only, so no operation id, no revision check and no replay: a second report finds the issuance delivered / not
  //delivered and gets the 409 of the transition table. validation first, outside the transaction, like delivery.service
  async reportSelfPickup(id: number, body: any, user: any) {
    const issuance = await this.issuances.findOne({ where: { id }, relations: { items: true }, order: { items: { line_no: 'ASC' } } });
    if (!issuance) throw new NotFoundException(`issuance ${id} not found`);

    const answers = validateItemAnswers(issuance.items, body?.items);
    const outcome = outcomeOf(answers);
    //nothing handed over: no one received, recipient and signature are null, same rule as the courier's report
    const recipient = validateRecipient(body, issuance, handedOver(answers));
    const signature = validateSignature(body?.signature_png, handedOver(answers));

    await this.issuances.manager.transaction(async (em) => {
      const locked = await lockIssuance(em, id);
      if (!locked) throw new NotFoundException(`issuance ${id} not found`);
      assertCanDo('self_pickup_report', locked);

      //the task is born closed: the handover is the delivery, there was never anything to drive. courier_id null keeps
      //it off every courier board (delivery.service filters by courier_id)
      const task = await em.save(em.create(DeliveryTask, { issuance_id: id, courier_id: null, status: TaskStatus.done, closed_at: new Date(), scheduled_date: locked.delivery_date || null, assigned_by: user?.sub ?? null }));
      const attempt = em.create(DeliveryAttempt, {
        task_id: task.id,
        outcome,
        recipient_type: recipient?.type ?? null,
        recipient_name: recipient?.name ?? null,
        recipient_id_number: recipient?.id_number ?? null,
        recipient_phone: recipient?.phone ?? null,
        signature_png: signature,
        items: answers,
      });
      await em.save(attempt);

      //em.update and not save: the locked entity has no relations loaded and a save would null what it does not know
      await em.update(Issuance, id, { status: outcome as any, revision: locked.revision + 1, delivered_by_user_id: user.sub });
      await this.audit.record(em, { actor: user, action: AuditAction.issuance_self_pickup_report, entity_type: AuditEntityType.issuance, entity_id: id, issuance_id: id, details: { task_id: task.id, attempt_id: attempt.id, outcome, items_delivered: answers.filter((a) => a.delivered).length, items_total: answers.length, revision: locked.revision + 1 } });
      this.logger.log(`issuance ${locked.sap_number} handed over at the warehouse (${outcome}) by user ${user?.sub}, task ${task.id}`);
    });

    return this.findOne(id);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // PATCH /api/issuances/:id - priority, delivery_date, notes, self_pickup.
  //nothing else is editable from here, the customer / items / address belong to the SAP document
  async update(id: number, body: any, user: any) {
    const priority = body?.priority;
    if (priority && !Object.values(Priority).includes(priority)) throw new BadRequestException(`unknown priority ${priority}`);

    const hasDate = 'delivery_date' in (body || {});
    const date = hasDate ? body.delivery_date || null : undefined;
    if (date && !isIsoDate(date)) throw new BadRequestException('delivery_date must be yyyy-mm-dd');

    const hasNotes = 'notes' in (body || {});
    if (hasNotes && body.notes != null && (typeof body.notes !== 'string' || body.notes.length > 500)) throw new BadRequestException('notes must be a string up to 500 chars');

    const wantsSelfPickup = !!body?.self_pickup;

    await this.issuances.manager.transaction(async (em) => {
      const issuance = await lockIssuance(em, id);
      if (!issuance) throw new NotFoundException(`issuance ${id} not found`);
      assertCanDo(wantsSelfPickup ? 'self_pickup' : 'edit', issuance);
      const before = snapshot(issuance, EDIT_FIELDS);
      const fromStatus = issuance.status;

      if (priority) issuance.priority = priority;
      if (hasDate) issuance.delivery_date = date;
      if (hasNotes) issuance.notes = body.notes;

      //self pickup ends the courier side of this issuance. what SAP should hear about it is an open question.
      //it also bumps the revision, a plain priority / date / notes edit does not (see the column in issuance.entity)
      if (wantsSelfPickup) {
        issuance.self_pickup = true;
        issuance.status = IssuanceStatus.self_pickup;
        issuance.revision += 1;
        //a handover that collected nothing can come back here: nobody delivered yet, so nobody is recorded
        issuance.delivered_by_user_id = null;
        await cancelOpenTasks(em, id);
        this.logger.log(`issuance ${issuance.sap_number} moved to self pickup by user ${user?.sub}`);
      }

      await em.save(issuance);

      //the audit row says what changed, not what was sent: a PATCH that repeats the stored values is a 200 and no row.
      //self pickup is always a change (the status moved) and carries the field edits that came along with it
      const changes = changesBetween(before, issuance, EDIT_FIELDS);
      if (wantsSelfPickup) {
        await this.audit.record(em, { actor: user, action: AuditAction.issuance_self_pickup, entity_type: AuditEntityType.issuance, entity_id: id, issuance_id: id, details: { from_status: fromStatus, ...(changes ? { changes } : {}) } });
      } else if (changes) {
        await this.audit.record(em, { actor: user, action: AuditAction.issuance_edit, entity_type: AuditEntityType.issuance, entity_id: id, issuance_id: id, details: { changes } });
      }
    });

    return this.findOne(id);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // POST /api/issuances/mark-urgent { ids }
  //closed rows are skipped, not an error: the bar action is a bulk shortcut and the count tells the manager what happened.
  //the open rows are locked in id order like assign does, then updated in one statement as before. the count stays the
  //number of editable rows (the board relies on it); the audit rows are only for the ones whose priority really moved
  async setPriority(ids: number[], priority: Priority, user: any) {
    if (!ids.length) return { updated: 0 };
    if (!Object.values(Priority).includes(priority)) throw new BadRequestException(`unknown priority ${priority}`);

    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    const batchId = AuditService.batchId();

    return this.issuances.manager.transaction(async (em) => {
      const open = await em
        .getRepository(Issuance)
        .createQueryBuilder('i')
        .select(['i.id', 'i.priority'])
        .setLock('pessimistic_write')
        .where('i.id IN (:...ids) AND i.status IN (:...open)', { ids: sorted, open: editableStatuses })
        .orderBy('i.id', 'ASC')
        .getMany();

      const res = await em
        .getRepository(Issuance)
        .createQueryBuilder()
        .update()
        .set({ priority })
        .where('id IN (:...ids) AND status IN (:...open)', { ids: sorted, open: editableStatuses })
        .execute();

      for (const row of open.filter((r) => r.priority !== priority)) {
        await this.audit.record(em, { actor: user, action: AuditAction.issuance_mark_urgent, entity_type: AuditEntityType.issuance, entity_id: row.id, issuance_id: row.id, batch_id: batchId, details: { from_priority: row.priority } });
      }
      return { updated: res.affected || 0 };
    });
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // POST /api/issuances/assign { ids, courier_id, scheduled_date? }
  //one task per issuance. a previous open task is cancelled, not edited, so "who had it before" stays in the table.
  //all or nothing: one issuance that may not be assigned (delivered, deleted, partially delivered...) fails the whole batch
  //with 409 and nothing is written. ids are locked in ascending order so two managers with overlapping batches cannot deadlock
  async assign(ids: number[], courierId: number, scheduledDate: string, user: any) {
    if (!ids.length) throw new BadRequestException('no issuances selected');
    if (scheduledDate && !isIsoDate(scheduledDate)) throw new BadRequestException('scheduled_date must be yyyy-mm-dd');

    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    const batchId = AuditService.batchId();
    let courier: Courier;

    await this.issuances.manager.transaction(async (em) => {
      //FOR SHARE on the courier row, inside the transaction: a delete of this courier (couriers.service.remove, FOR UPDATE)
      //either waits for us and then sees the new open tasks, or we wait for it and find the courier gone. the courier is
      //locked before the issuances so this and remove() never hold each other's rows
      courier = await em.getRepository(Courier).createQueryBuilder('c').setLock('pessimistic_read').where('c.id = :id AND c.active = true', { id: courierId }).getOne();
      if (!courier) throw new NotFoundException(`courier ${courierId} not found`);

      for (const id of sorted) {
        const issuance = await lockIssuance(em, id);
        if (!issuance) throw new NotFoundException(`issuance ${id} not found`);
        assertCanDo('assign', issuance);
        const fromStatus = issuance.status;

        await cancelOpenTasks(em, id);
        const task = await em.save(em.create(DeliveryTask, { issuance_id: id, courier_id: courierId, scheduled_date: scheduledDate || issuance.delivery_date || null, assigned_by: user?.sub ?? null }));

        issuance.status = IssuanceStatus.assigned;
        issuance.self_pickup = false;
        //a courier takes over from a handover that collected nothing: the manager's record stays in the task history,
        //not on the issuance, so a courier delivery is never attributed to the manager
        issuance.delivered_by_user_id = null;
        issuance.revision += 1; //a report written against the old task is stale now, whoever the new courier is
        if (scheduledDate) issuance.delivery_date = scheduledDate;
        await em.save(issuance);
        await this.audit.record(em, { actor: user, action: AuditAction.issuance_assign, entity_type: AuditEntityType.issuance, entity_id: id, issuance_id: id, batch_id: batchId, details: { courier_id: courierId, task_id: task.id, scheduled_date: task.scheduled_date, from_status: fromStatus } });
      }
    });

    this.logger.log(`===== assigned ${sorted.length} issuances to ${courier.name} =====`);
    return { assigned: sorted.length, courier };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // DELETE /api/issuances/:id { reason }
  //soft delete. the design asks for a reason and warns it cannot be undone, so the row keeps deleted_at + delete_reason
  async softDelete(id: number, reason: string, user: any) {
    if (reason != null && (typeof reason !== 'string' || reason.length > 500)) throw new BadRequestException('reason must be a string up to 500 chars');

    await this.issuances.manager.transaction(async (em) => {
      const issuance = await lockIssuance(em, id);
      if (!issuance) throw new NotFoundException(`issuance ${id} not found`);
      assertCanDo('delete', issuance);
      const fromStatus = issuance.status;

      issuance.status = IssuanceStatus.deleted;
      issuance.deleted_at = new Date();
      issuance.delete_reason = reason?.trim() || null;
      issuance.revision += 1;
      await cancelOpenTasks(em, id);
      await em.save(issuance);
      await this.audit.record(em, { actor: user, action: AuditAction.issuance_delete, entity_type: AuditEntityType.issuance, entity_id: id, issuance_id: id, details: { reason: issuance.delete_reason, from_status: fromStatus } });

      this.logger.warn(`issuance ${issuance.sap_number} deleted by user ${user?.sub}, reason: ${issuance.delete_reason || '-'}`);
    });

    return { deleted: id };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // /api/issuances/summary - the "משלוחים לפי עיר" widget: how many still wait for a courier in each city ("X לא שובצו"
  //in the spec), so assigned rows do not count. every date, like the courier load next to it
  async summary() {
    const byCity = await this.issuances
      .createQueryBuilder('i')
      .select('i.address_city', 'city')
      .addSelect('COUNT(*)', 'count')
      .where('i.deleted_at IS NULL AND i.status = :status', { status: IssuanceStatus.unassigned })
      .groupBy('i.address_city')
      .orderBy('count', 'DESC')
      .getRawMany();

    const cities = await this.issuances.createQueryBuilder('i').select('DISTINCT i.address_city', 'city').where('i.deleted_at IS NULL').orderBy('city').getRawMany();

    return {
      by_city: byCity.map((r) => ({ city: r.city, count: +r.count })),
      cities: cities.map((r) => r.city), //for the city filter dropdown
    };
  }
}
