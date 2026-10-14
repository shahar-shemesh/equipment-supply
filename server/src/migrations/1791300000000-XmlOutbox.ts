import { DefaultNamingStrategy, MigrationInterface, QueryRunner } from 'typeorm';

//the xml_outbox table (entities/xml-outbox.entity, xml-export/). hand written with IF NOT EXISTS guards like the previous
//ones, so it is a no-op on a LOCAL database that synchronize already updated. no foreign keys by design (the rows are
//snapshots that outlive the issuance); the primary key and the index names come from typeorm's own naming strategy, so
//synchronize sees no diff after this runs. the uuid default is gen_random_uuid(), built into postgres 13+, no extension
const naming = new DefaultNamingStrategy();
const TABLE = 'xml_outbox';
const PK = naming.primaryKeyName(TABLE, ['id']);
const INDEXES = [
  { columns: ['status', 'next_retry_at'], unique: false },
  { columns: ['issuance_id', 'sequence'], unique: true },
  { columns: ['status', 'lease_until'], unique: false },
].map(({ columns, unique }) => ({ name: naming.indexName(TABLE, columns), columns, unique }));

export class XmlOutbox1791300000000 implements MigrationInterface {
  name = 'XmlOutbox1791300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "${TABLE}" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "issuance_id" integer NOT NULL,
      "sequence" integer NOT NULL,
      "previous_status" character varying(24) NOT NULL,
      "new_status" character varying(24) NOT NULL,
      "trigger" character varying(40) NOT NULL,
      "payload" jsonb NOT NULL,
      "status" character varying(12) NOT NULL DEFAULT 'pending',
      "attempts" integer NOT NULL DEFAULT 0,
      "next_retry_at" timestamptz NOT NULL DEFAULT now(),
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "occurred_at" timestamptz NOT NULL,
      "lease_until" timestamptz NULL,
      "processed_at" timestamptz NULL,
      "s3_key" character varying NULL,
      "content_sha256" character(64) NULL,
      "last_error" text NULL,
      CONSTRAINT "${PK}" PRIMARY KEY ("id")
    )`);
    for (const { name, columns, unique } of INDEXES) {
      await queryRunner.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${name}" ON "${TABLE}" (${columns.map((c) => `"${c}"`).join(', ')})`);
    }
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { name } of INDEXES) await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  }
}
