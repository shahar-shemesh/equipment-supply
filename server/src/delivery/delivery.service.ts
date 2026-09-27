import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AttemptOutcome, RecipientType, TaskStatus } from '../../../shared/@core';
import { normalizeSapNumber } from '../../../shared/@utils';
import { DeliveryTask, DeliveryAttempt, Issuance } from '../entities';

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
  //the outcome is derived from the per item answers, the ui never sends it
  async report(user: any, id: number, body: any) {
    const task = await this.myTask(user, id);
    if (task.status !== TaskStatus.pending) throw new BadRequestException('task already closed');

    const items = task.issuance.items;
    const answers: any[] = Array.isArray(body?.items) ? body.items : [];

    //every line needs an answer and every "not delivered" needs a reason. the screen enforces the same
    for (const item of items) {
      const answer = answers.find((a) => +a.item_id === item.id);
      if (!answer) throw new BadRequestException(`missing answer for item ${item.id}`);
      if (!answer.delivered && !answer.reason) throw new BadRequestException(`missing reason for item ${item.id}`);
    }
    if (!body?.signature_png) throw new BadRequestException('signature is required');

    const recipientType = body.recipient_type === RecipientType.other ? RecipientType.other : RecipientType.customer;
    if (recipientType === RecipientType.other && (!body.recipient_name || !body.recipient_id_number || !body.recipient_phone)) {
      throw new BadRequestException('recipient details are required when someone else received the delivery');
    }

    const deliveredCount = answers.filter((a) => !!a.delivered).length;
    const outcome = deliveredCount === items.length ? AttemptOutcome.delivered : deliveredCount === 0 ? AttemptOutcome.not_delivered : AttemptOutcome.partially_delivered;

    const attempt = this.attempts.create({
      task_id: task.id,
      outcome,
      recipient_type: recipientType,
      //when the customer signs we copy the customer details, so the attempt row reads on its own
      recipient_name: recipientType === RecipientType.other ? body.recipient_name : task.issuance.customer_name,
      recipient_id_number: recipientType === RecipientType.other ? body.recipient_id_number : task.issuance.customer_id_number,
      recipient_phone: recipientType === RecipientType.other ? body.recipient_phone : task.issuance.customer_phone,
      signature_png: body.signature_png,
      items: items.map((item) => {
        const a = answers.find((x) => +x.item_id === item.id);
        return { item_id: item.id, delivered: !!a.delivered, reason: a.delivered ? null : a.reason, reason_details: a.delivered ? null : a.reason_details || null };
      }),
    });
    //one attempt closes the task. whether a failed delivery should reopen as a new task or go back to the manager is an open rule,
    //so today it just goes back to the board with the not_delivered status and the manager decides.
    //plain update() on the task, not save(task): task was loaded with attempts=[] and save would "orphan" the attempt we just inserted (sets task_id null)
    await this.attempts.manager.transaction(async (em) => {
      await em.save(attempt);
      await em.update(DeliveryTask, task.id, { status: TaskStatus.done, closed_at: new Date() });
      await em.update(Issuance, task.issuance_id, { status: outcome as any });
    });

    this.logger.log(`task ${task.id} (${task.issuance.sap_number}) reported ${outcome} by courier ${user.courier_id}`);
    return { attempt_id: attempt.id, outcome };
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
