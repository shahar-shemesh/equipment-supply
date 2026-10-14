import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

import { AuditAction, IssuanceStatus, XmlOutboxStatus } from '../../../shared/@core';

//the transactional outbox of the xml export: one row per committed issuance status change, written by
//xml-export/xml-outbox.service inside the transaction of the change (after the audit row, no lock), claimed and completed
//by xml-export/xml-export.worker. the payload is a snapshot taken at write time, so the worker never reads issuances and a
//row reads the same after the issuance moved on or was deleted. no foreign keys for the same reason.
//the uuid is generated in javascript on insert and by the database default when a row is inserted by hand (gen_random_uuid
//is built into postgres 13+, no extension). the indexes are the three reads: the claim (status, next_retry_at), the
//per issuance order and the sequence uniqueness (issuance_id, sequence), the lease sweep (status, lease_until).
//their names are left to typeorm's naming strategy and the migration computes the same ones
@Entity('xml_outbox')
@Index(['status', 'next_retry_at'])
@Index(['issuance_id', 'sequence'], { unique: true })
@Index(['status', 'lease_until'])
export class XmlOutbox {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ type: 'int' })
  issuance_id: number;

  @Column({ type: 'int' })
  sequence: number; //1, 2, 3... per issuance, in commit order; a failed row leaves a gap the consumer can see

  @Column({ type: 'varchar', length: 24 })
  previous_status: IssuanceStatus;

  @Column({ type: 'varchar', length: 24 })
  new_status: IssuanceStatus;

  @Column({ type: 'varchar', length: 40 })
  trigger: AuditAction; //the action that moved the status, the same name as its audit row

  @Column({ type: 'jsonb' })
  payload: Record<string, any>; //XmlOutboxPayload in xml-builder.service: the issuance snapshot, the actor, the details

  @Column({ type: 'varchar', length: 12, default: XmlOutboxStatus.pending })
  status: XmlOutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number; //incremented by every claim, reset by a manager's retry

  @Column({ type: 'timestamptz', default: () => 'now()' })
  next_retry_at: Date; //a pending row is not claimed before this

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz' })
  occurred_at: Date; //when the change was written; the object key's date and the document's OccurredAt

  @Column({ type: 'timestamptz', nullable: true })
  lease_until: Date; //while processing: the claim is the worker's until then, afterwards anyone may reclaim

  @Column({ type: 'timestamptz', nullable: true })
  processed_at: Date;

  @Column({ type: 'varchar', nullable: true })
  s3_key: string;

  @Column({ type: 'char', length: 64, nullable: true })
  content_sha256: string; //hex sha256 of the uploaded document, also in the object's metadata

  @Column({ type: 'text', nullable: true })
  last_error: string; //"category: message" of the last failure, cleared on completion
}
