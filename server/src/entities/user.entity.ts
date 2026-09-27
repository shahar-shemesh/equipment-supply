import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { UserRole } from '../../../shared/@core';

//login accounts. in the local foundation these are only the seeded dev accounts (seed.data.ts).
//the production identity source is still open in the spec: email + password, or national identity (הזדהות לאומית)?
//whatever it turns out to be, it should replace auth.service.login and leave this table as the local user record
@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  username: string;

  @Column()
  password_hash: string; //bcrypt, dev accounts only

  @Column()
  display_name: string;

  @Column({ type: 'varchar' })
  role: UserRole; //manager|courier

  @CreateDateColumn()
  created_at: Date;
}
