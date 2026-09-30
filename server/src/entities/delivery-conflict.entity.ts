import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { ConflictReviewStatus, IConflictObserved, IDeliveryAttemptItem, RecipientType, ReportConflictCode } from '../../../shared/@core';
import { DeliveryTask } from './delivery-task.entity';

//a delivery report the server refused (409) and the tablet then handed over as evidence: what the courier signed at the
//door for a task that had changed meanwhile. nothing here touches the delivery: no attempt, no task close, no issuance
//status, no revision bump. the submitted content is frozen at the insert, only the review_* fields change, and a
//"reviewed" row is still a report that was not applied.
//one row per (account, operation id), the same index shape as delivery_operations, so a lost response replays the receipt
@Entity('delivery_conflicts')
@Index('UQ_delivery_conflicts_user_operation', ['user_id', 'operation_id'], { unique: true })
export class DeliveryConflict {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  user_id: number; //users.id from the jwt, never from the body

  @Column()
  courier_id: number;

  @Column({ length: 64 })
  operation_id: string;

  //cascade so TRUNCATE ... CASCADE and the seed reach this table through delivery_tasks
  @ManyToOne(() => DeliveryTask, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: DeliveryTask;

  @Column()
  task_id: number; //the task the courier reported on, never retargeted

  @Column()
  issuance_id: number;

  @Column({ type: 'int', nullable: true })
  submitted_revision: number; //issuance_revision the tablet sent

  @Column({ type: 'varchar' })
  recipient_type: RecipientType;

  @Column({ nullable: true })
  recipient_name: string;

  @Column({ nullable: true })
  recipient_id_number: string;

  @Column({ nullable: true })
  recipient_phone: string;

  //the answers as submitted, structurally valid. item ids are kept even when the issuance lines changed since
  @Column({ type: 'jsonb' })
  items: IDeliveryAttemptItem[];

  @Column({ type: 'text' })
  signature_png: string; //a real png data url, same limits as a delivery attempt. never in list responses or logs

  @Column({ length: 64 })
  payload_hash: string; //sha256 of the validated content, the same function as delivery_operations

  @Column({ type: 'varchar' })
  rejection_code: ReportConflictCode;

  @Column({ type: 'text', nullable: true })
  rejection_message: string;

  @Column({ type: 'jsonb' })
  observed: IConflictObserved; //the authoritative state under the lock when the evidence was recorded

  @Column({ type: 'timestamptz', nullable: true })
  client_reported_at: Date; //device clock, untrusted

  @CreateDateColumn({ type: 'timestamptz' })
  received_at: Date;

  @Column({ type: 'varchar', default: ConflictReviewStatus.pending })
  review_status: ConflictReviewStatus;

  @Column({ nullable: true })
  reviewed_by: number; //users.id of the manager

  @Column({ type: 'timestamptz', nullable: true })
  reviewed_at: Date;

  @Column({ type: 'text', nullable: true })
  review_note: string;

  @Column({ default: 0 })
  review_version: number; //bumped by every review write, the client sends it back so two managers cannot overwrite each other
}
