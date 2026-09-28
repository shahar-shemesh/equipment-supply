import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IssuanceStatus, TaskStatus } from '../../../shared/@core';
import { normalizeSapNumber } from '../../../shared/@utils';
import { DeliveryTask, DeliveryAttempt, Issuance } from '../entities';
import { lockIssuance } from '../issuances/issuances.service';
import { outcomeOf, validateItemAnswers, validateRecipient, validateSignature } from './attempt.validation';

//courier side: my tasks, one task, report an attempt, find a task by the printed number
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    @InjectRepository(DeliveryTask) private tasks: Repository<DeliveryTask>,
    @InjectRepository(DeliveryAttempt) private attempts: Repository<DeliveryAttempt>,
    @InjectRepository(Issuance) private issuances: Repository<Issuance>,
  ) {}

  // /api/delivery/tasks?tab=all|pending|done&search=
  async myTasks(user: any, tab = 'all', search = '') {
    const courierId = this.courierIdOf(user);

    const qb = this.tasks
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.issuance', 'i')
      .leftJoinAndSelect('i.items', 'item')
      .leftJoinAndSelect('t.attempts', 'a')
      .where('t.courier_id = :cid', { cid: courierId })
      .andWhere('t.status != :cancelled', { cancelled: TaskStatus.cancelled });

    if (tab === 'pending') qb.andWhere('t.status = :p', { p: TaskStatus.pending });
    if (tab === 'done') qb.andWhere('t.status = :d', { d: TaskStatus.done });
    if (search) {
      qb.andWhere('(i.sap_number ILIKE :s OR i.customer_name ILIKE :s OR i.address_street ILIKE :s OR i.address_city ILIKE :s)', { s: `%${search}%` });
    }

    //'pending' > 'done' alphabetically so DESC keeps the open ones on top, then urgent first, then by date
    qb.orderBy('t.status', 'DESC').addOrderBy('i.priority', 'DESC').addOrderBy('t.scheduled_date', 'ASC', 'NULLS LAST').addOrderBy('t.id', 'ASC');

    const rows = await qb.getMany();
    for (const t of rows) t.issuance?.items?.sort((a, b) => a.line_no - b.line_no);

    //tab counters ("הכל (30)") are for the whole list, not the filtered one
    const raw = await this.tasks
      .createQueryBuilder('t')
      .select('t.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('t.courier_id = :cid AND t.status != :cancelled', { cid: courierId, cancelled: TaskStatus.cancelled })
      .groupBy('t.status')
      .getRawMany();
    const pending = +(raw.find((r) => r.status === TaskStatus.pending)?.count || 0);
    const done = +(raw.find((r) => r.status === TaskStatus.done)?.count || 0);

    //the signature png is heavy and the board does not show it
    for (const t of rows) for (const a of t.attempts || []) delete a.signature_png;

    return { rows, counts: { all: pending + done, pending, done } };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // /api/delivery/tasks/:id
  async myTask(user: any, id: number) {
    const task = await this.tasks.findOne({
      where: { id, courier_id: this.courierIdOf(user) },
      relations: { issuance: { items: true }, attempts: { items: true } },
      order: { issuance: { items: { line_no: 'ASC' } }, attempts: { id: 'ASC' } },
    });
    if (!task) throw new NotFoundException(`task ${id} not found for this courier`);
    return task;
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // POST /api/delivery/tasks/:id/attempts  (IAttemptPayload)
  //validation first, outside the transaction, so a bad payload never touches the db. the outcome is derived from the
  //validated answers, the body never says it.
  //then, under the issuance lock (same order as the manager flows: issuance, then task): re-check that the task is still
  //pending, insert the attempt, close the task with a conditional update, mirror the outcome on the issuance
  async report(user: any, id: number, body: any) {
    const task = await this.myTask(user, id); //also proves the task belongs to this courier
    if (task.status !== TaskStatus.pending) throw new ConflictException('task already closed');

    const answers = validateItemAnswers(task.issuance.items, body?.items);
    const recipient = validateRecipient(body, task.issuance);
    const signature = validateSignature(body?.signature_png);
    const outcome = outcomeOf(answers);

    let attemptId: number;
    await this.tasks.manager.transaction(async (em) => {
      const issuance = await lockIssuance(em, task.issuance_id);
      const locked = await em.getRepository(DeliveryTask).createQueryBuilder('t').setLock('pessimistic_write').where('t.id = :id', { id: task.id }).getOne();
      if (!locked || locked.status !== TaskStatus.pending) throw new ConflictException('task is no longer open, it was reported or reassigned meanwhile');
      if (issuance.status !== IssuanceStatus.assigned) throw new ConflictException(`issuance is ${issuance.status}, a delivery report needs it assigned`);

      const attempt = em.create(DeliveryAttempt, {
        task_id: task.id,
        outcome,
        recipient_type: recipient.type,
        recipient_name: recipient.name,
        recipient_id_number: recipient.id_number,
        recipient_phone: recipient.phone,
        signature_png: signature,
        items: answers,
      });
      await em.save(attempt);
      attemptId = attempt.id;

      //conditional update on top of the lock, so even a code path that forgot the lock cannot close a task twice.
      //one attempt closes the task. whether a failed delivery should reopen as a new task or go back to the manager is an
      //open rule, so today it goes back to the board with the not_delivered status and the manager decides
      const closed = await em.update(DeliveryTask, { id: task.id, status: TaskStatus.pending }, { status: TaskStatus.done, closed_at: new Date() });
      if (!closed.affected) throw new ConflictException('task was closed by another request');
      await em.update(Issuance, task.issuance_id, { status: outcome as any });
    });

    this.logger.log(`task ${task.id} (${task.issuance.sap_number}) reported ${outcome} by courier ${user.courier_id}`);
    return { attempt_id: attemptId, outcome };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // /api/delivery/lookup?number=1234567  -  the "איתור הנפקה" button, manual entry until the camera is wired
  async lookup(user: any, rawNumber: string) {
    const number = normalizeSapNumber(rawNumber);
    if (!number) throw new BadRequestException('number is required');

    const issuance = await this.issuances.findOne({ where: { sap_number: number } });
    if (!issuance) throw new NotFoundException('issuance not found');

    const task = await this.tasks.findOne({ where: { issuance_id: issuance.id, courier_id: this.courierIdOf(user) }, order: { id: 'DESC' } });
    if (!task || task.status === TaskStatus.cancelled) throw new ForbiddenException('issuance is not assigned to you');
    return { task_id: task.id };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  private courierIdOf(user: any) {
    if (!user?.courier_id) throw new ForbiddenException('this account is not linked to a courier');
    return +user.courier_id;
  }
}
