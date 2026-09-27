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

  @Column({ nullable: true })
  phone: string;

  @Column({ nullable: true })
  email: string;

  @Column({ type: 'simple-array', nullable: true })
  zones: string[]; //cities the courier usually covers, free text for now

  @Column({ default: true })
  active: boolean;

  @Column({ nullable: true })
  user_id: number; //users.id of the login account, null until the courier gets one

  @OneToMany(() => DeliveryTask, (t) => t.courier)
  tasks: DeliveryTask[];
}
