import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { IssuanceStatus, Priority } from '../../../shared/@core';
import { IssuanceItem } from './issuance-item.entity';
import { DeliveryTask } from './delivery-task.entity';

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
  //self pickup, delete and the report itself. priority / delivery_date / notes edits and mark urgent leave it alone,
  //a report written before such an edit is still good. today every bump also cancels or closes the task, so the task
  //check in delivery.service fires first and this is a forward guard for bump sources that do not touch the task
  //(item or customer changes from SAP, when that interface exists)
  @Column({ default: 1 })
  revision: number;

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
