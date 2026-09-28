import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { IAttemptResult } from '../../../shared/@core';
import { DeliveryAttempt } from './delivery-attempt.entity';

//the receipt of one delivery report sent with an operation id (the offline queue on the tablet). the same id sent again,
//by the same account, is answered with the stored result instead of a second attempt: the tablet may have committed the
//report here and never seen the response. only successful reports get a row, a rejected one is not remembered.
//the index is named explicitly so the migration and synchronize agree on it, delivery.service catches it by that name
@Entity('delivery_operations')
@Index('UQ_delivery_operations_user_operation', ['user_id', 'operation_id'], { unique: true })
export class DeliveryOperation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  user_id: number; //users.id, the jwt sub. the lookup is scoped by it so another account never gets this result back

  @Column()
  courier_id: number;

  @Column({ length: 64 })
  operation_id: string; //generated on the device, see validateOperationId

  @Column()
  task_id: number;

  //cascade so TRUNCATE ... CASCADE and the seed reach this table through delivery_attempts
  @ManyToOne(() => DeliveryAttempt, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'attempt_id' })
  attempt: DeliveryAttempt;

  @Column()
  attempt_id: number;

  @Column({ length: 64 })
  payload_hash: string; //sha256 of the validated report, a reused id with other content is refused

  @Column({ type: 'timestamptz', nullable: true })
  client_reported_at: Date; //device clock, untrusted

  //server clock. the explicit type keeps the entity identical to the migration
  @CreateDateColumn({ type: 'timestamptz' })
  received_at: Date;

  @Column({ type: 'jsonb' })
  result: IAttemptResult; //the exact body that was returned, a replay sends it again with replayed: true
}
