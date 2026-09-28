import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { IssuanceSortKey, IssuanceStatus, Priority, TaskStatus } from '../../../shared/@core';
import { Issuance, DeliveryTask, Courier } from '../entities';
import { assertCanDo, editableStatuses } from './issuance.rules';

//the courier on the open task, or on the last closed one, the same pick as withCurrentTask below. a correlated subselect
//instead of a join: an issuance has several tasks over time and a join would multiply the rows under offset / limit
const COURIER_NAME_SQL = `(SELECT c.name FROM delivery_tasks t JOIN couriers c ON c.id = t.courier_id WHERE t.issuance_id = i.id AND t.status != '${TaskStatus.cancelled}' ORDER BY (t.status = '${TaskStatus.pending}') DESC, t.id DESC LIMIT 1)`;

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

//the open task, or the last closed one when there is no open task. the board shows its courier.
//items are sorted here and not in the query: an ORDER BY on a joined column breaks typeorm's skip/take (it paginates distinct rows, not distinct issuances)
export function withCurrentTask(issuance: Issuance) {
  const tasks = (issuance.tasks || []).filter((t) => t.status !== TaskStatus.cancelled);
  const current = tasks.find((t) => t.status === TaskStatus.pending) || tasks.sort((a, b) => b.id - a.id)[0] || null;
  const items = (issuance.items || []).sort((a, b) => a.line_no - b.line_no);
  return { ...issuance, items, current_task: current };
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

/*──────────────────────────────────────────────────────────────────────────*/

@Injectable()
export class IssuancesService {
  private readonly logger = new Logger(IssuancesService.name);

  constructor(
    @InjectRepository(Issuance) private issuances: Repository<Issuance>,
    @InjectRepository(DeliveryTask) private tasks: Repository<DeliveryTask>,
    @InjectRepository(Courier) private couriers: Repository<Courier>,
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

    if (q.status) qb.andWhere('i.status = :status', { status: q.status });
    if (q.priority) qb.andWhere('i.priority = :priority', { priority: q.priority });
    if (q.city) qb.andWhere('i.address_city = :city', { city: q.city });
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

    const entities = await this.issuances.find({ where: { id: In(ids) }, relations: { items: true, tasks: { courier: true } } });
    //find() has its own order, the id list is the order of the page
    const byId = new Map(entities.map((e) => [e.id, e]));
    // console.log('issuances.list', { page, pageSize, total, sortKey, dir });
    return { rows: ids.map((id) => withCurrentTask(byId.get(id))), total, page, page_size: pageSize };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  async findOne(id: number) {
    const issuance = await this.issuances.findOne({
      where: { id },
      relations: { items: true, tasks: { courier: true, attempts: { items: true } } },
      order: { items: { line_no: 'ASC' }, tasks: { id: 'ASC' } },
    });
    if (!issuance) throw new NotFoundException(`issuance ${id} not found`);
    return withCurrentTask(issuance);
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

      if (priority) issuance.priority = priority;
      if (hasDate) issuance.delivery_date = date;
      if (hasNotes) issuance.notes = body.notes;

      //self pickup ends the courier side of this issuance. what SAP should hear about it is an open question
      if (wantsSelfPickup) {
        issuance.self_pickup = true;
        issuance.status = IssuanceStatus.self_pickup;
        await cancelOpenTasks(em, id);
        this.logger.log(`issuance ${issuance.sap_number} moved to self pickup by user ${user?.sub}`);
      }

      await em.save(issuance);
    });

    return this.findOne(id);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // POST /api/issuances/mark-urgent { ids }
  //closed rows are skipped, not an error: the bar action is a bulk shortcut and the count tells the manager what happened
  async setPriority(ids: number[], priority: Priority) {
    if (!ids.length) return { updated: 0 };
    if (!Object.values(Priority).includes(priority)) throw new BadRequestException(`unknown priority ${priority}`);

    const res = await this.issuances
      .createQueryBuilder()
      .update()
      .set({ priority })
      .where('id IN (:...ids) AND status IN (:...open)', { ids, open: editableStatuses })
      .execute();
    return { updated: res.affected || 0 };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // POST /api/issuances/assign { ids, courier_id, scheduled_date? }
  //one task per issuance. a previous open task is cancelled, not edited, so "who had it before" stays in the table.
  //all or nothing: one issuance that may not be assigned (delivered, deleted, partially delivered...) fails the whole batch
  //with 409 and nothing is written. ids are locked in ascending order so two managers with overlapping batches cannot deadlock
  async assign(ids: number[], courierId: number, scheduledDate: string, user: any) {
    if (!ids.length) throw new BadRequestException('no issuances selected');
    if (scheduledDate && !isIsoDate(scheduledDate)) throw new BadRequestException('scheduled_date must be yyyy-mm-dd');

    const courier = await this.couriers.findOne({ where: { id: courierId, active: true } });
    if (!courier) throw new NotFoundException(`courier ${courierId} not found`);

    const sorted = [...new Set(ids)].sort((a, b) => a - b);

    await this.issuances.manager.transaction(async (em) => {
      for (const id of sorted) {
        const issuance = await lockIssuance(em, id);
        if (!issuance) throw new NotFoundException(`issuance ${id} not found`);
        assertCanDo('assign', issuance);

        await cancelOpenTasks(em, id);
        await em.save(em.create(DeliveryTask, { issuance_id: id, courier_id: courierId, scheduled_date: scheduledDate || issuance.delivery_date || null, assigned_by: user?.sub ?? null }));

        issuance.status = IssuanceStatus.assigned;
        issuance.self_pickup = false;
        if (scheduledDate) issuance.delivery_date = scheduledDate;
        await em.save(issuance);
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

      issuance.status = IssuanceStatus.deleted;
      issuance.deleted_at = new Date();
      issuance.delete_reason = reason?.trim() || null;
      await cancelOpenTasks(em, id);
      await em.save(issuance);

      this.logger.warn(`issuance ${issuance.sap_number} deleted by user ${user?.sub}, reason: ${issuance.delete_reason || '-'}`);
    });

    return { deleted: id };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // /api/issuances/summary - the "משלוחים לפי עיר" widget. open = still waiting for a courier or for delivery
  async summary() {
    const byCity = await this.issuances
      .createQueryBuilder('i')
      .select('i.address_city', 'city')
      .addSelect('COUNT(*)', 'count')
      .where('i.deleted_at IS NULL AND i.status IN (:...open)', { open: [IssuanceStatus.unassigned, IssuanceStatus.assigned] })
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
