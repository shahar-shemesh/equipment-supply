import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { UserRole } from '../../../shared/@core';

//the local user record behind a login. no credential lives here: in mock mode the identity key maps to a username
//(auth/mock/mock-identities.ts), with the real identity provider the token's claims will (auth/cognito/). role is the
//one value the roles are derived from (rolesOf in shared/auth.ts), a manager holds the courier role too
@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  username: string;

  @Column()
  display_name: string;

  @Column({ nullable: true })
  email: string; //what the identity provider says, informative only, nothing is sent

  @Column({ type: 'varchar' })
  role: UserRole; //manager|courier

  @CreateDateColumn()
  created_at: Date;
}
