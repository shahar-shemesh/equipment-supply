import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { NonDeliveryReason } from '../../../shared/@core';
import { DeliveryAttempt } from './delivery-attempt.entity';

//the per line answer of an attempt. reason + details only when delivered = false
@Entity('delivery_attempt_items')
export class DeliveryAttemptItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => DeliveryAttempt, (a) => a.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'attempt_id' })
  attempt: DeliveryAttempt;

  @Column()
  attempt_id: number;

  @Column()
  item_id: number; //issuance_items.id

  @Column()
  delivered: boolean;

  @Column({ type: 'varchar', nullable: true })
  reason: NonDeliveryReason;

  @Column({ nullable: true })
  reason_details: string;
}
