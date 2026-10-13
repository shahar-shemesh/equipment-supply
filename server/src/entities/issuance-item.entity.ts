import { Column, DeleteDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Issuance } from './issuance.entity';

//one product line inside an issuance. the courier answers "נמסר / לא נמסר" per line, so partial delivery is possible
@Entity('issuance_items')
export class IssuanceItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Issuance, (i) => i.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'issuance_id' })
  issuance: Issuance;

  @Column()
  issuance_id: number;

  @Column()
  line_no: number;

  @Column()
  product_name: string;

  @Column({ nullable: true })
  catalog_number: string; //מק"ט

  @Column({ nullable: true })
  station_number: string;

  @Column({ nullable: true })
  serial_number: string;

  @Column({ default: 1 })
  quantity: number;

  //a line the manager took off the issuance (issuances.service.removeItem). soft on purpose: delivery_attempt_items.item_id
  //points here with no foreign key, so a past attempt keeps its reference. a delete date column and not a plain flag
  //because typeorm then leaves the line out of every relation load (find relations, leftJoinAndSelect): the boards, the
  //detail, the courier's task and the report validators see live lines only without a filter of their own
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  removed_at: Date;
}
