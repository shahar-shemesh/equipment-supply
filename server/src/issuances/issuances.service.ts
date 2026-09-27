import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IssuanceStatus, Priority, TaskStatus } from '../../../shared/@core';
import { Issuance, DeliveryTask, Courier } from '../entities';

//the open task, or the last closed one when there is no open task. the board shows its courier.
//items are sorted here and not in the query: an ORDER BY on a joined column breaks typeorm's skip/take (it paginates distinct rows, not distinct issuances)
export function withCurrentTask(issuance: Issuance) {
  const tasks = (issuance.tasks || []).filter((t) => t.status !== TaskStatus.cancelled);
  const current = tasks.find((t) => t.status === TaskStatus.pending) || tasks.sort((a, b) => b.id - a.id)[0] || null;
  const items = (issuance.items || []).sort((a, b) => a.line_no - b.line_no);
  return { ...issuance, items, current_task: current };
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

  // /api/issuances?status=&priority=&city=&customer=&courier_id=&date=&search=&page=&page_size=
  async list(q: any) {
    const page = Math.max(+q.page || 1, 1);
    const pageSize = Math.min(+q.page_size || 15, 100);

    const qb = this.issuances
      .createQueryBuilder('i')
      .leftJoinAndSelect('i.items', 'item')
      .leftJoinAndSelect('i.tasks', 'task', 'task.status != :cancelled', { cancelled: TaskStatus.cancelled })
      .leftJoinAndSelect('task.courier', 'courier')
      .where('i.deleted_at IS NULL');

    if (q.status) qb.andWhere('i.status = :status', { status: q.status });
    if (q.priority) qb.andWhere('i.priority = :priority', { priority: q.priority });
    if (q.city) qb.andWhere('i.address_city = :city', { city: q.city });
    if (q.customer) qb.andWhere('i.customer_name ILIKE :customer', { customer: `%${q.customer}%` });
    if (q.date) qb.andWhere('i.delivery_date = :date', { date: q.date });
    if (q.courier_id) qb.andWhere('task.courier_id = :courierId AND task.status = :pending', { courierId: +q.courier_id, pending: TaskStatus.pending });
    if (q.search) {
      qb.andWhere('(i.sap_number ILIKE :s OR i.customer_name ILIKE :s OR i.address_street ILIKE :s OR i.address_city ILIKE :s)', { s: `%${q.search}%` });
    }

    //'urgent' > 'normal' alphabetically, so DESC puts the urgent rows first. cheap trick, replace if a third priority shows up
    qb.orderBy('i.priority', 'DESC').addOrderBy('i.delivery_date', 'ASC', 'NULLS LAST').addOrderBy('i.id', 'ASC');

    const [rows, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    // console.log('issuances.list', { page, pageSize, total });
    return { rows: rows.map(withCurrentTask), total, page, page_size: pageSize };
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
    const issuance = await this.issuances.findOne({ where: { id } });
    if (!issuance) throw new NotFoundException(`issuance ${id} not found`);
    if (issuance.status === IssuanceStatus.deleted) throw new BadRequestException('issuance was deleted');

    if (body?.priority) issuance.priority = body.priority;
    if ('delivery_date' in (body || {})) issuance.delivery_date = body.delivery_date || null;
    if ('notes' in (body || {})) issuance.notes = body.notes;

    //self pickup ends the courier side of this issuance. what SAP should hear about it is an open question
    if (body?.self_pickup) {
      issuance.self_pickup = true;
      issuance.status = IssuanceStatus.self_pickup;
      await this.cancelOpenTasks(id);
      this.logger.log(`issuance ${issuance.sap_number} moved to self pickup by user ${user?.sub}`);
    }

    await this.issuances.save(issuance);
    return this.findOne(id);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // POST /api/issuances/mark-urgent { ids }
  async setPriority(ids: number[], priority: Priority) {
    if (!ids.length) return { updated: 0 };
    await this.issuances.update(ids, { priority });
    return { updated: ids.length };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // POST /api/issuances/assign { ids, courier_id, scheduled_date? }
  //one task per issuance. a previous open task is cancelled, not edited, so "who had it before" stays in the table
  async assign(ids: number[], courierId: number, scheduledDate: string, user: any) {
    if (!ids.length) throw new BadRequestException('no issuances selected');
    const courier = await this.couriers.findOne({ where: { id: courierId, active: true } });
    if (!courier) throw new NotFoundException(`courier ${courierId} not found`);

    for (const id of ids) {
      const issuance = await this.issuances.findOne({ where: { id } });
      if (!issuance || issuance.status === IssuanceStatus.deleted) continue;

      await this.cancelOpenTasks(id);
      await this.tasks.save(this.tasks.create({ issuance_id: id, courier_id: courierId, scheduled_date: scheduledDate || issuance.delivery_date || null, assigned_by: user?.sub ?? null }));

      issuance.status = IssuanceStatus.assigned;
      issuance.self_pickup = false;
      if (scheduledDate) issuance.delivery_date = scheduledDate;
      await this.issuances.save(issuance);
    }

    this.logger.log(`===== assigned ${ids.length} issuances to ${courier.name} =====`);
    return { assigned: ids.length, courier };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // DELETE /api/issuances/:id { reason }
  //soft delete. the design asks for a reason and warns it cannot be undone, so the row keeps deleted_at + delete_reason
  async softDelete(id: number, reason: string, user: any) {
    const issuance = await this.issuances.findOne({ where: { id } });
    if (!issuance) throw new NotFoundException(`issuance ${id} not found`);

    issuance.status = IssuanceStatus.deleted;
    issuance.deleted_at = new Date();
    issuance.delete_reason = reason || null;
    await this.cancelOpenTasks(id);
    await this.issuances.save(issuance);

    this.logger.warn(`issuance ${issuance.sap_number} deleted by user ${user?.sub}, reason: ${reason || '-'}`);
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

  /*──────────────────────────────────────────────────────────────────────────*/

  private async cancelOpenTasks(issuanceId: number) {
    await this.tasks.update({ issuance_id: issuanceId, status: TaskStatus.pending }, { status: TaskStatus.cancelled, closed_at: new Date() });
  }
}
