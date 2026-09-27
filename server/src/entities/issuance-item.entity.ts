import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

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
}
