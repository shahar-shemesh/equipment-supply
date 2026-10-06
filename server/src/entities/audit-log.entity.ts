import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { AuditAction, AuditActorType, AuditEntityType, UserRole } from '../../../shared/@core';

//append only: who did what, written by audit.service inside the transaction of the change it describes, so a rolled back
//request leaves no row and a committed one always has one. no foreign keys on purpose: the actor and the entity ids are
//copied at write time and the row has to outlive a deleted courier or a renamed user. the indexes are the four reads:
//the history of one issuance, what one user did, the history of one entity, the plain timeline. their names are left to
//typeorm's naming strategy and the migration computes the same ones
@Entity('audit_log')
@Index(['issuance_id', 'at'])
@Index(['actor_user_id', 'at'])
@Index(['entity_type', 'entity_id', 'at'])
@Index(['at'])
export class AuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;

  @Column({ type: 'varchar', length: 8 })
  actor_type: AuditActorType;

  @Column({ type: 'int', nullable: true })
  actor_user_id: number; //users.id, null for the system

  @Column({ type: 'varchar', nullable: true })
  actor_username: string;

  @Column({ type: 'varchar', nullable: true })
  actor_role: UserRole;

  @Column({ type: 'varchar', length: 40 })
  action: AuditAction;

  @Column({ type: 'varchar', length: 24 })
  entity_type: AuditEntityType;

  @Column({ type: 'int', nullable: true })
  entity_id: number;

  @Column({ type: 'int', nullable: true })
  issuance_id: number; //filled on every row about an issuance, the delivery and conflict rows included

  @Column({ type: 'varchar', length: 36, nullable: true })
  batch_id: string; //one uuid for all the rows of a bulk action

  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, any>; //ids and short scalars, cut and filtered in audit.service
}
