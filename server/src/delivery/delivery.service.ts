import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IAttemptResult, IssuanceStatus, ReportConflictCode, TaskStatus } from '../../../shared/@core';
import { normalizeSapNumber } from '../../../shared/@utils';
import { DeliveryTask, DeliveryAttempt, Issuance, DeliveryOperation } from '../entities';
import { lockIssuance } from '../issuances/issuances.service';
import { outcomeOf, validateItemAnswers, validateRecipient, validateSignature } from './attempt.validation';
import { isOperationUniqueViolation, parseClientTime, payloadHash, validateIssuanceRevision, validateOperationId } from './operation';

//every 409 of the report route carries a code from ReportConflictCode, the tablet shows a hebrew line per code.
//nest sends the object as the body as it is, so statusCode stays for readers of the default nest shape. the default
//"error" field is gone from these responses, a documented contract change
function conflict(message: string, code: ReportConflictCode) {
  return new ConflictException({ statusCode: 409, message, code });
}

/*──────────────────────────────────────────────────────────────────────────*/

//courier side: my tasks, one task, report an attempt, find a task by the printed number
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    @InjectRepository(DeliveryTask) private tasks: Repository<DeliveryTask>,
    @InjectRepository(DeliveryAttempt) private attempts: Repository<DeliveryAttempt>,
    @InjectRepository(Issuance) private issuances: Repository<Issuance>,
    @InjectRepository(DeliveryOperation) private operations: Repository<DeliveryOperation>,
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
  //pending, insert the attempt, close the task with a conditional update, mirror the outcome on the issuance.
  //
  //with an operation_id (the offline queue on the tablet) the same request may arrive twice: the tablet committed the
  //report locally, sent it, and never saw the response. so under the lock the stored operation is looked up FIRST, before
  //the "task is closed" check, and answered with the stored result. the lookup is scoped by the account (user.sub), so
  //another account with the same id never gets this result or this signature back.
  //a report on a task that was cancelled meanwhile (reassigned, even to the same courier when the manager moves the date,
  //self pickup, delete) is a 409 task_cancelled and stays on the tablet for attention. no retargeting to the new task on
  //purpose: the courier signed for that task, the manager decides what the new one means
  async report(user: any, id: number, body: any): Promise<IAttemptResult> {
    const task = await this.myTask(user, id); //also proves the task belongs to this courier
    const operationId = validateOperationId(body?.operation_id);
    const issuanceRevision = validateIssuanceRevision(body?.issuance_revision);
    //the legacy early exit, only without an operation id: with one, a closed task may be the replay of the report that
    //closed it, and that is decided under the lock below
    if (!operationId && task.status !== TaskStatus.pending) throw conflict('task already closed', ReportConflictCode.task_closed);

    const answers = validateItemAnswers(task.issuance.items, body?.items);
    const recipient = validateRecipient(body, task.issuance);
    const signature = validateSignature(body?.signature_png);
    const outcome = outcomeOf(answers);
    const clientReportedAt = parseClientTime(body?.client_reported_at);
    //hashed after validation, so a retry that trims a name differently is still the same report
    const hash = operationId ? payloadHash({ task_id: task.id, recipient, signature_png: signature, items: answers }) : null;

    let result: IAttemptResult;
    try {
      result = await this.tasks.manager.transaction(async (em) => {
        const issuance = await lockIssuance(em, task.issuance_id);
        const locked = await em.getRepository(DeliveryTask).createQueryBuilder('t').setLock('pessimistic_write').where('t.id = :id', { id: task.id }).getOne();

        if (operationId) {
          //typeorm 0.3 throws on findOne without a where, so the scope is spelled out even though it is the whole point
          const stored = await em.findOne(DeliveryOperation, { where: { user_id: user.sub, operation_id: operationId } });
          if (stored) return this.replay(stored, task.id, hash);
        }

        if (!locked || locked.status !== TaskStatus.pending) {
          throw conflict('task is no longer open, it was reported or reassigned meanwhile', locked?.status === TaskStatus.cancelled ? ReportConflictCode.task_cancelled : ReportConflictCode.task_closed);
        }
        if (issuance.status !== IssuanceStatus.assigned) throw conflict(`issuance is ${issuance.status}, a delivery report needs it assigned`, ReportConflictCode.issuance_not_assigned);
        //cannot happen through a real flow today (every bump also cancels or closes the task, caught above), a forward
        //guard for bumps that leave the task alone. see the revision column in issuance.entity
        if (issuanceRevision != null && issuanceRevision !== issuance.revision) {
          throw conflict(`issuance changed since revision ${issuanceRevision}, it is at ${issuance.revision} now`, ReportConflictCode.revision_changed);
        }

        const attempt = em.create(DeliveryAttempt, {
          task_id: task.id,
          outcome,
          recipient_type: recipient.type,
          recipient_name: recipient.name,
          recipient_id_number: recipient.id_number,
          recipient_phone: recipient.phone,
          signature_png: signature,
          client_reported_at: clientReportedAt,
          items: answers,
        });
        await em.save(attempt);

        //conditional update on top of the lock, so even a code path that forgot the lock cannot close a task twice.
        //one attempt closes the task. whether a failed delivery should reopen as a new task or go back to the manager is an
        //open rule, so today it goes back to the board with the not_delivered status and the manager decides
        const closed = await em.update(DeliveryTask, { id: task.id, status: TaskStatus.pending }, { status: TaskStatus.done, closed_at: new Date() });
        if (!closed.affected) throw conflict('task was closed by another request', ReportConflictCode.task_closed);
        await em.update(Issuance, task.issuance_id, { status: outcome as any, revision: issuance.revision + 1 });

        //reported_at comes back from the insert (postgres RETURNING on the create date column)
        const fresh: IAttemptResult = { attempt_id: attempt.id, outcome, task_id: task.id, reported_at: attempt.reported_at.toISOString() };
        if (operationId) {
          fresh.operation_id = operationId;
          //the receipt goes in the same transaction as the attempt: either both exist or neither
          await em.save(em.create(DeliveryOperation, { user_id: user.sub, courier_id: task.courier_id, operation_id: operationId, task_id: task.id, attempt_id: attempt.id, payload_hash: hash, client_reported_at: clientReportedAt, result: fresh }));
        }
        return fresh;
      });
    } catch (e) {
      //two identical requests that slipped past the lock: the second insert hits the unique index. the transaction is
      //already rolled back here (a pg session in error cannot run the re-read inside the callback), so the plain
      //repository on its own connection answers with the row the first request committed
      if (!operationId || !isOperationUniqueViolation(e)) throw e;
      const stored = await this.operations.findOne({ where: { user_id: user.sub, operation_id: operationId } });
      if (!stored) throw e;
      result = this.replay(stored, task.id, hash);
    }

    if (result.replayed) {
      this.logger.log(`task ${task.id} (${task.issuance.sap_number}) operation ${operationId} replayed for courier ${user.courier_id}`);
    } else {
      this.logger.log(`task ${task.id} (${task.issuance.sap_number}) reported ${outcome} by courier ${user.courier_id}${operationId ? `, operation ${operationId}` : ''}`);
    }
    return result;
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //the stored result of an operation this account already sent. same task and same content: the tablet gets the answer it
  //missed. anything else under the same id is a different report wearing an old id, refused so it never silently
  //replaces what the courier really signed
  private replay(stored: DeliveryOperation, taskId: number, hash: string): IAttemptResult {
    if (stored.task_id !== taskId || stored.payload_hash !== hash) throw conflict('operation id was already used with different content', ReportConflictCode.operation_reused);
    return { ...stored.result, replayed: true };
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
