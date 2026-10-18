import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { DeliveryTask } from './delivery-task.entity';

//the person (or company - the wireframe has "אמנון שילוח בע"מ") that drives the equipment to the customer.
//separate from users: a courier exists in the system before anyone gives them a tablet login
@Entity('couriers')
export class Courier {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ nullable: true })
  employee_id: string;

  @Column({ nullable: true, unique: true })
  id_number: string; //תעודת זהות, 9 digits. unique so the same person is not added twice (couriers.service brings a deleted one back instead)

  @Column({ nullable: true })
  phone: string;

  @Column({ nullable: true })
  email: string;

  @Column({ type: 'simple-array', nullable: true })
  zones: string[]; //cities the courier usually covers, free text for now

  @Column({ default: true })
  active: boolean; //false = deleted on the management screen. the row stays because delivery_tasks point at it

  //users.id of the login account, null until the courier gets one. unique: one account holds one courier row at most,
  //the courier operations resolve the row from the account on every call (delivery/courier-identity.service.ts) and the
  //tablet keys its offline data by the pair. null stays repeatable (a courier without a login). migration 1791500000000
  @Column({ nullable: true, unique: true })
  user_id: number;

  @OneToMany(() => DeliveryTask, (t) => t.courier)
  tasks: DeliveryTask[];
}
