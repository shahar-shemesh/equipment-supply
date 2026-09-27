import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { TaskStatus } from '../../../shared/@core';
import { Issuance } from './issuance.entity';
import { Courier } from './courier.entity';
import { DeliveryAttempt } from './delivery-attempt.entity';

//"go deliver issuance X" handed to one courier. this is what the courier board lists.
//re-assigning creates a new task and cancels this one, so the history of who had it stays
@Entity('delivery_tasks')
export class DeliveryTask {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Issuance, (i) => i.tasks)
  @JoinColumn({ name: 'issuance_id' })
  issuance: Issuance;

  @Column()
  issuance_id: number;

  @ManyToOne(() => Courier, (c) => c.tasks)
  @JoinColumn({ name: 'courier_id' })
  courier: Courier;

  @Column()
  courier_id: number;

  @Column({ type: 'varchar', default: TaskStatus.pending })
  status: TaskStatus;

  @Column({ type: 'date', nullable: true })
  scheduled_date: string;

  @Column({ nullable: true })
  assigned_by: number; //users.id of the manager

  @CreateDateColumn()
  assigned_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closed_at: Date;

  @OneToMany(() => DeliveryAttempt, (a) => a.task)
  attempts: DeliveryAttempt[];
}
