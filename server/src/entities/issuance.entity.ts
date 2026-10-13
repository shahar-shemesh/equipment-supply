import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { IssuanceStatus, Priority } from '../../../shared/@core';
import { IssuanceItem } from './issuance-item.entity';
import { DeliveryTask } from './delivery-task.entity';
import { User } from './user.entity';

//the SAP document: who gets what, where. exists whether or not anyone was sent to deliver it.
//everything a courier does with it lives in delivery_tasks / delivery_attempts, this row only mirrors the latest outcome in status
@Entity('issuances')
export class Issuance {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  sap_number: string; //the number printed on the SAP document, digits only

  @Column({ nullable: true })
  number_prefix: string; //the design shows ס' / ד' / כ' before the number. nobody explained it yet so it is stored as is, not interpreted

  @Column({ type: 'varchar', default: IssuanceStatus.unassigned })
  status: IssuanceStatus;

  @Column({ type: 'varchar', default: Priority.normal })
  priority: Priority;

  @Column()
  customer_name: string;

  @Column({ nullable: true })
  customer_id_number: string;

  @Column({ nullable: true })
  customer_phone: string;

  @Column()
  address_street: string;

  @Column({ nullable: true })
  address_building: string; //"בניין B קומה 3, חדר 1" style free text

  @Column()
  address_city: string;

  @Column({ type: 'date', nullable: true })
  delivery_date: string; //planned date, the manager can move it (שינוי מועד חלוקה)

  @Column({ default: false })
  self_pickup: boolean;

  @Column({ nullable: true })
  notes: string;

  @Column({ default: 'sample' })
  source: string; //'sample' = seeded. the SAP interface is not defined yet, when it is it should write 'sap' here

  //the concurrency token of an offline delivery report: the tablet stores it with the snapshot and sends it back, a
  //different number means the issuance changed materially since. bumped inside the locked transactions of assign,
  //self pickup, delete, a line the manager took off (issuances.service.removeItem) and the report itself. priority /
  //delivery_date / notes edits and mark urgent leave it alone, a report written before such an edit is still good.
  //assign, self pickup, delete and the report also cancel or close the task, so for those the task check in
  //delivery.service fires first; a line removal leaves the task alone and is the one flow that reaches the revision
  //check there (item or customer changes from SAP will take the same path, when that interface exists)
  @Column({ default: 1 })
  revision: number;

  //the manager who handed the equipment over at the warehouse (POST /issuances/:id/self-pickup/report). null for every
  //courier delivery. no foreign key, like delivery_tasks.assigned_by: the relation only loads the display name for the board
  @Column({ nullable: true })
  delivered_by_user_id: number;

  @ManyToOne(() => User, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'delivered_by_user_id' })
  delivered_by: User;

  @Column({ type: 'timestamptz', nullable: true })
  deleted_at: Date;

  @Column({ nullable: true })
  delete_reason: string;

  @OneToMany(() => IssuanceItem, (i) => i.issuance, { cascade: true })
  items: IssuanceItem[];

  @OneToMany(() => DeliveryTask, (t) => t.issuance)
  tasks: DeliveryTask[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
