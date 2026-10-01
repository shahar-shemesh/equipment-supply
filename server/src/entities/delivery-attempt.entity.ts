import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { AttemptOutcome, RecipientType } from '../../../shared/@core';
import { DeliveryTask } from './delivery-task.entity';
import { DeliveryAttemptItem } from './delivery-attempt-item.entity';

//what the courier reported at the door for one task: who received, the signature and a result per item.
//a task can end up with more than one attempt once "try again tomorrow" is a business rule, today the first attempt closes the task
@Entity('delivery_attempts')
export class DeliveryAttempt {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => DeliveryTask, (t) => t.attempts)
  @JoinColumn({ name: 'task_id' })
  task: DeliveryTask;

  @Column()
  task_id: number;

  @Column({ type: 'varchar' })
  outcome: AttemptOutcome;

  //all null when the outcome is not_delivered: nothing was handed over, so no one received and no one signed.
  //a delivered or partially delivered attempt always has a recipient type and a signature
  @Column({ type: 'varchar', nullable: true })
  recipient_type: RecipientType;

  @Column({ nullable: true })
  recipient_name: string;

  @Column({ nullable: true })
  recipient_id_number: string;

  @Column({ nullable: true })
  recipient_phone: string;

  //png data url straight from the canvas, null when nothing was delivered. the spec asks for a restricted file storage
  //with the issuance id + timestamp, that is a later step, for now the db holds it
  @Column({ type: 'text', nullable: true })
  signature_png: string;

  @CreateDateColumn()
  reported_at: Date; //server receipt time, the meaning it always had

  //the device clock when the courier tapped send, from the offline queue. untrusted and can be hours before reported_at
  //after an outage. null for a legacy request or a junk value, never a reason to reject the report
  @Column({ type: 'timestamptz', nullable: true })
  client_reported_at: Date;

  @OneToMany(() => DeliveryAttemptItem, (i) => i.attempt, { cascade: true })
  items: DeliveryAttemptItem[];
}
