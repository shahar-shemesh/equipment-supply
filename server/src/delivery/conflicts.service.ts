import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AuditAction, AuditEntityType, ConflictReviewStatus, IAttemptResult, IAuthUser, IConflictObserved, IConflictReceipt, IConflictStatus, IDeliveryConflict, IssuanceStatus, ReportConflictCode, TaskStatus } from '../../../shared/@core';
import { DeliveryAttempt, DeliveryConflict, DeliveryOperation, DeliveryTask, Issuance, User } from '../entities';
import { AuditService } from '../audit/audit.service';
import { lockIssuance } from '../issuances/issuances.service';
import { handedOver, validateRecipient, validateSignature } from './attempt.validation';
import { isConflictUniqueViolation, parseClientTime, payloadHash, validateEvidenceItems, validateIssuanceRevision, validateOperationId } from './operation';
import { CourierIdentityService } from './courier-identity.service';

//rejected delivery reports kept as evidence. the courier side hands a report the attempts route refused over as it was
//signed; the manager side reads it next to the authoritative state and marks it reviewed. nothing in here changes a
//task, an attempt or an issuance: "reviewed" is an administrative acknowledgment, the delivery was not applied

export const REVIEW_NOTE_MAX = 500;
const LIST_MAX = 100;

//every 409 of these routes carries a code like the attempts route, the extra fields ride along for the screen
function conflict(message: string, code: string, extra: any = {}) {
  return new ConflictException({ statusCode: 409, message, code, ...extra });
}

/*──────────────────────────────────────────────────────────────────────────*/

//why the report cannot be applied, read under the issuance and task locks. null means it still could be, so it is not
//evidence of anything and is refused (not_a_conflict). the order mirrors the attempts route
function rejectionOf(task: DeliveryTask | null, issuance: Issuance, submittedRevision: number | null): ReportConflictCode | null {
  if (!task || task.status === TaskStatus.cancelled) return ReportConflictCode.task_cancelled;
  if (task.status === TaskStatus.done) return ReportConflictCode.task_closed;
  if (issuance.status !== IssuanceStatus.assigned) return ReportConflictCode.issuance_not_assigned;
  if (submittedRevision != null && submittedRevision !== issuance.revision) return ReportConflictCode.revision_changed;
  return null;
}

const MESSAGES: Record<string, string> = {
  [ReportConflictCode.task_cancelled]: 'task was cancelled meanwhile (reassigned, self pickup or deleted)',
  [ReportConflictCode.task_closed]: 'task was already reported',
  [ReportConflictCode.issuance_not_assigned]: 'issuance is no longer assigned',
  [ReportConflictCode.revision_changed]: 'issuance changed since the revision the report was written against',
};

/*──────────────────────────────────────────────────────────────────────────*/

@Injectable()
export class ConflictsService {
  private readonly logger = new Logger(ConflictsService.name);

  constructor(
    @InjectRepository(DeliveryConflict) private conflicts: Repository<DeliveryConflict>,
    @InjectRepository(DeliveryTask) private tasks: Repository<DeliveryTask>,
    @InjectRepository(DeliveryOperation) private operations: Repository<DeliveryOperation>,
    @InjectRepository(User) private users: Repository<User>,
    private audit: AuditService,
    private identity: CourierIdentityService,
  ) {}

  // POST /api/delivery/tasks/:id/conflicts  (IAttemptPayload with operation_id)
  //the body is validated like a delivery report (recipient, png signature, per line answers) except that the answers are
  //not matched to the issuance's current lines: they are evidence of what was signed, not a report to apply. then, under
  //the same locks as the attempts route: a stored success for this operation wins (the tablet lost a 201, this is not a
  //conflict), a stored conflict replays its receipt, a report that could still be applied is refused, anything else is
  //recorded with the authoritative state of that moment. the receipt says kind: "conflict_recorded" so the tablet never
  //mistakes it for a delivery result
  async record(user: IAuthUser, taskId: number, body: any): Promise<IConflictReceipt | (IAttemptResult & { kind: 'delivered' })> {
    const courierId = await this.identity.resolve(user);
    const task = await this.tasks.findOne({ where: { id: taskId, courier_id: courierId }, relations: { issuance: true } });
    if (!task) throw new NotFoundException(`task ${taskId} not found for this courier`);

    const operationId = validateOperationId(body?.operation_id);
    if (!operationId) throw new BadRequestException('operation_id is required to keep a rejected report');
    const submittedRevision = validateIssuanceRevision(body?.issuance_revision);
    const items = validateEvidenceItems(body?.items);
    //the same rule as a delivery report: nothing delivered, no one to sign, recipient and signature optional
    const recipient = validateRecipient(body, task.issuance, handedOver(items));
    const signature = validateSignature(body?.signature_png, handedOver(items));
    const clientReportedAt = parseClientTime(body?.client_reported_at);
    const hash = payloadHash({ task_id: task.id, recipient, signature_png: signature, items });

    let result: IConflictReceipt | (IAttemptResult & { kind: 'delivered' });
    try {
      result = await this.conflicts.manager.transaction(async (em) => {
        const issuance = await lockIssuance(em, task.issuance_id);
        const locked = await em.getRepository(DeliveryTask).createQueryBuilder('t').setLock('pessimistic_write').where('t.id = :id', { id: task.id }).getOne();

        //the operation was applied after all: the tablet lost the 201 and later read a retry's 409 as a rejection
        const delivered = await em.findOne(DeliveryOperation, { where: { user_id: user.id, operation_id: operationId } });
        if (delivered) {
          if (delivered.task_id !== task.id || delivered.payload_hash !== hash) throw conflict('operation id was already used with different content', ReportConflictCode.operation_reused);
          return { kind: 'delivered' as const, ...delivered.result, replayed: true };
        }
        const stored = await em.findOne(DeliveryConflict, { where: { user_id: user.id, operation_id: operationId } });
        if (stored) return this.replay(stored, task.id, hash);

        const code = rejectionOf(locked, issuance, submittedRevision);
        if (!code) throw conflict('the report could still be applied, it is not a conflict. send it as a delivery report', ReportConflictCode.not_a_conflict);

        const open = await em.findOne(DeliveryTask, { where: { issuance_id: task.issuance_id, status: TaskStatus.pending } });
        const last = await em.findOne(DeliveryAttempt, { where: { task_id: task.id }, order: { id: 'DESC' } });
        const observed: IConflictObserved = {
          task_status: locked.status,
          issuance_status: issuance.status,
          issuance_revision: issuance.revision,
          current_task_id: open?.id ?? null,
          current_courier_id: open?.courier_id ?? null,
          attempt_id: last?.id ?? null,
        };
        const row = em.create(DeliveryConflict, {
          user_id: user.id,
          courier_id: courierId,
          operation_id: operationId,
          task_id: task.id,
          issuance_id: task.issuance_id,
          submitted_revision: submittedRevision,
          recipient_type: recipient?.type ?? null,
          recipient_name: recipient?.name ?? null,
          recipient_id_number: recipient?.id_number ?? null,
          recipient_phone: recipient?.phone ?? null,
          items,
          signature_png: signature,
          payload_hash: hash,
          rejection_code: code,
          rejection_message: MESSAGES[code],
          observed,
          client_reported_at: clientReportedAt,
        });
        await em.save(row);
        //the 409 of the attempts route left no row (a rejected request); the evidence being kept is the event
        await this.audit.record(em, { actor: user, action: AuditAction.delivery_conflict_record, entity_type: AuditEntityType.delivery_conflict, entity_id: row.id, issuance_id: task.issuance_id, details: { task_id: task.id, operation_id: operationId, rejection_code: code, submitted_revision: submittedRevision } });
        return this.receipt(row, false);
      });
    } catch (e) {
      //two identical uploads that slipped past the lock: the second insert hits the unique index after the rollback,
      //the plain repository answers with the row the first one committed
      if (!isConflictUniqueViolation(e)) throw e;
      const stored = await this.conflicts.findOne({ where: { user_id: user.id, operation_id: operationId } });
      if (!stored) throw e;
      result = this.replay(stored, task.id, hash);
    }

    if (result.kind === 'conflict_recorded') {
      this.logger.log(`task ${task.id} (${task.issuance.sap_number}) rejected report kept as conflict ${result.conflict_id} (${(result as any).rejection_code || ''}) for courier ${courierId}${result.replayed ? ', replayed' : ''}`);
    } else {
      this.logger.log(`task ${task.id} (${task.issuance.sap_number}) operation ${operationId} had been applied, delivery result returned instead of a conflict`);
    }
    return result;
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  private replay(stored: DeliveryConflict, taskId: number, hash: string): IConflictReceipt {
    if (stored.task_id !== taskId || stored.payload_hash !== hash) throw conflict('operation id was already used with different content', ReportConflictCode.operation_reused);
    return this.receipt(stored, true);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  private receipt(row: DeliveryConflict, replayed: boolean): IConflictReceipt {
    const r: IConflictReceipt = {
      kind: 'conflict_recorded',
      conflict_id: row.id,
      operation_id: row.operation_id,
      task_id: row.task_id,
      received_at: row.received_at.toISOString(),
      review_status: row.review_status,
      reviewed_at: row.reviewed_at ? row.reviewed_at.toISOString() : null,
    };
    if (replayed) r.replayed = true;
    return r;
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // GET /api/delivery/conflicts?operation_ids=a,b  -  the courier's own evidence, review status only
  async mine(user: IAuthUser, raw: string): Promise<IConflictStatus[]> {
    await this.identity.resolve(user);
    const ids = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    if (!ids.length) return [];
    const rows = await this.conflicts.find({ where: { user_id: user.id, operation_id: In(ids) }, select: { id: true, operation_id: true, received_at: true, review_status: true, reviewed_at: true } });
    return rows.map((r) => ({ operation_id: r.operation_id, conflict_id: r.id, received_at: r.received_at.toISOString(), review_status: r.review_status, reviewed_at: r.reviewed_at ? r.reviewed_at.toISOString() : null }));
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // GET /api/conflicts?status=pending|reviewed|all&page=&page_size=  (manager)
  //the list never loads signatures or answers, those come with one row from findOne
  async list(q: any) {
    const page = Math.max(+q?.page || 1, 1);
    const pageSize = Math.min(+q?.page_size || 20, LIST_MAX);
    const status = q?.status === 'all' ? null : q?.status === ConflictReviewStatus.reviewed ? ConflictReviewStatus.reviewed : ConflictReviewStatus.pending;

    const qb = this.conflicts
      .createQueryBuilder('c')
      .select(['c.id', 'c.operation_id', 'c.user_id', 'c.courier_id', 'c.task_id', 'c.issuance_id', 'c.submitted_revision', 'c.rejection_code', 'c.rejection_message', 'c.observed', 'c.client_reported_at', 'c.received_at', 'c.review_status', 'c.reviewed_by', 'c.reviewed_at', 'c.review_note', 'c.review_version'])
      .leftJoin('c.task', 't')
      //the task itself has to be selected for the joins below it to hydrate
      .addSelect(['t.id', 't.status', 't.courier_id'])
      .leftJoin('t.issuance', 'i')
      .addSelect(['i.id', 'i.sap_number', 'i.number_prefix', 'i.customer_name', 'i.address_city', 'i.status', 'i.revision'])
      .leftJoin('t.courier', 'cr')
      .addSelect(['cr.id', 'cr.name'])
      .orderBy('c.received_at', 'DESC')
      .addOrderBy('c.id', 'DESC');
    if (status) qb.where('c.review_status = :status', { status });

    const [rows, total] = await qb.offset((page - 1) * pageSize).limit(pageSize).getManyAndCount();
    const names = await this.reviewerNames(rows);
    return { rows: rows.map((r) => this.toDto(r, names)), total, page, page_size: pageSize };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // GET /api/conflicts/:id  (manager)  -  the evidence with its signature, next to the authoritative state right now
  async findOne(id: number) {
    //withDeleted: the review names the lines as the report knew them, a line the manager took off since included
    //(removed_at set on it), which is the very line a revision_changed report is in dispute about
    const row = await this.conflicts.findOne({ where: { id }, relations: { task: { issuance: { items: true }, courier: true } }, withDeleted: true });
    if (!row) throw new NotFoundException(`conflict ${id} not found`);
    const names = await this.reviewerNames([row]);

    //the state now, read plainly: this screen compares, it does not lock anything
    const issuance = await this.tasks.manager.getRepository(Issuance).findOne({ where: { id: row.issuance_id }, relations: { tasks: { courier: true } } });
    const attempt = await this.tasks.manager.getRepository(DeliveryAttempt).findOne({ where: { task_id: row.task_id }, relations: { items: true }, order: { id: 'DESC' } });
    const tasks = (issuance?.tasks || []).sort((a, b) => a.id - b.id).map((t) => ({ id: t.id, status: t.status, courier_id: t.courier_id, courier_name: t.courier?.name || null, closed_at: t.closed_at }));

    return {
      conflict: { ...this.toDto(row, names), items: row.items, signature_png: row.signature_png },
      current: {
        issuance: issuance ? { id: issuance.id, status: issuance.status, revision: issuance.revision, self_pickup: issuance.self_pickup, deleted_at: issuance.deleted_at } : null,
        tasks,
        //the attempt that really closed the rejected report's task, if one did. its signature stays out of this screen
        attempt: attempt ? { id: attempt.id, outcome: attempt.outcome, reported_at: attempt.reported_at, recipient_name: attempt.recipient_name, recipient_phone: attempt.recipient_phone, items: attempt.items } : null,
      },
    };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // POST /api/conflicts/:id/review { note, version }  (manager)
  //marks the row reviewed with a note. the row is locked so two managers cannot interleave: the version the screen loaded
  //must still be the row's version, and a row another manager already reviewed answers 409 with that review instead of
  //taking a second note on top of it. the same manager sending the same note again gets the same answer (a lost response)
  async review(id: number, user: IAuthUser, body: any) {
    const note = typeof body?.note === 'string' ? body.note.trim() : '';
    if (!note) throw new BadRequestException('note is required');
    if (note.length > REVIEW_NOTE_MAX) throw new BadRequestException(`note is longer than ${REVIEW_NOTE_MAX} chars`);
    const version = body?.version;
    if (!Number.isInteger(version)) throw new BadRequestException('version must be the integer the screen loaded');

    const updated = await this.conflicts.manager.transaction(async (em) => {
      const row = await em.getRepository(DeliveryConflict).createQueryBuilder('c').setLock('pessimistic_write').where('c.id = :id', { id }).getOne();
      if (!row) throw new NotFoundException(`conflict ${id} not found`);

      if (row.review_status === ConflictReviewStatus.reviewed) {
        if (row.reviewed_by === user.id && row.review_note === note) return row;
        throw conflict('already reviewed by another manager', 'review_conflict', { review: await this.reviewOf(row) });
      }
      if (row.review_version !== version) throw conflict('the report changed since the screen loaded it', 'review_conflict', { review: await this.reviewOf(row) });

      await em.update(DeliveryConflict, { id }, { review_status: ConflictReviewStatus.reviewed, reviewed_by: user.id, reviewed_at: new Date(), review_note: note, review_version: row.review_version + 1 });
      //only the write gets a row: the same manager repeating the same note returned above without changing anything
      await this.audit.record(em, { actor: user, action: AuditAction.delivery_conflict_review, entity_type: AuditEntityType.delivery_conflict, entity_id: id, issuance_id: row.issuance_id, details: { review_version: row.review_version + 1 } });
      return em.getRepository(DeliveryConflict).findOne({ where: { id } });
    });

    this.logger.log(`conflict ${id} marked reviewed by user ${user?.id}`);
    const names = await this.reviewerNames([updated]);
    return this.toDto(updated, names);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  private async reviewOf(row: DeliveryConflict) {
    const names = await this.reviewerNames([row]);
    return { review_status: row.review_status, reviewed_by: row.reviewed_by, reviewed_by_name: names.get(row.reviewed_by) || null, reviewed_at: row.reviewed_at, review_note: row.review_note, review_version: row.review_version };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  private async reviewerNames(rows: DeliveryConflict[]) {
    const ids = [...new Set(rows.map((r) => r.reviewed_by).filter(Boolean))];
    const names = new Map<number, string>();
    if (!ids.length) return names;
    for (const u of await this.users.find({ where: { id: In(ids) } })) names.set(u.id, u.display_name);
    return names;
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //the row for the screens: everything but the signature and the answers, plus the courier and the issuance summary
  private toDto(r: DeliveryConflict, names: Map<number, string>): IDeliveryConflict {
    const { signature_png, items, task, ...rest } = r as any;
    return {
      ...rest,
      items: undefined,
      reviewed_by_name: r.reviewed_by ? names.get(r.reviewed_by) || null : null,
      courier: task?.courier ? { id: task.courier.id, name: task.courier.name } : undefined,
      issuance: task?.issuance || undefined,
    } as IDeliveryConflict;
  }
}
