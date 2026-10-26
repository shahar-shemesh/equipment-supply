import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import { XmlImportErrorKind, XmlImportFileStatus } from '../../../shared/@core';

//one row per xml document the import etl (etls/issuance-xml-import) has seen, keyed by the sha256 of the bytes: the
//same content under any file name is one row, so a copy dropped twice is imported once. the server never writes here;
//the entity lives on this side only so synchronize (LOCAL) and the migration create the table and the parity spec
//guards it. the row is the claim (instance_id, lease_until: another process skips it until the lease runs out), the
//outcome (status, error_kind, the counts, last_error) and the crash recovery (a completed row whose file is still in
//the input directory is archived without a second import). no foreign keys: the row outlives the issuances it touched.
//the uuid default is gen_random_uuid(), built into postgres 13+, like xml_outbox
@Entity('xml_import_files')
export class XmlImportFile {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ type: 'char', length: 64, unique: true })
  content_sha256: string; //hex sha256 of the file bytes, the identity of the document

  @Column({ type: 'varchar', length: 100, nullable: true, unique: true })
  document_id: string; //the DocumentId element, set on completion: a second file with the same id and other bytes is refused

  @Column({ type: 'varchar' })
  file_name: string; //the name the bytes were last seen under

  @Column({ type: 'int' })
  size_bytes: number;

  @Column({ type: 'varchar', length: 12 })
  status: XmlImportFileStatus;

  @Column({ type: 'varchar', length: 12, nullable: true })
  error_kind: XmlImportErrorKind; //with status failed: permanent (the file went to the error directory) or retryable (it stayed)

  @Column({ type: 'int', default: 0 })
  attempts: number; //incremented by every claim; a retryable failure past the etl's limit turns permanent

  @Column({ type: 'varchar', length: 64, nullable: true })
  instance_id: string; //the etl process that holds the claim

  @Column({ type: 'timestamptz', nullable: true })
  lease_until: Date; //while processing: the claim is that instance's until then, afterwards anyone may reclaim

  @Column({ type: 'timestamptz', default: () => 'now()' })
  started_at: Date; //of the last claim

  @Column({ type: 'timestamptz', nullable: true })
  finished_at: Date;

  @Column({ type: 'int', default: 0 })
  inserted: number;

  @Column({ type: 'int', default: 0 })
  updated: number;

  @Column({ type: 'int', default: 0 })
  unchanged: number;

  @Column({ type: 'text', nullable: true })
  last_error: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
