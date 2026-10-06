import { DefaultNamingStrategy, MigrationInterface, QueryRunner } from 'typeorm';

//the audit_log table (audit.service). hand written with IF NOT EXISTS guards like the previous ones, so it is a no-op on a
//LOCAL database that synchronize already updated. no foreign keys by design (the rows outlive what they describe); the
//primary key and the index names come from typeorm's own naming strategy, so synchronize sees no diff after this runs
const naming = new DefaultNamingStrategy();
const TABLE = 'audit_log';
const PK = naming.primaryKeyName(TABLE, ['id']);
const INDEXES = [['issuance_id', 'at'], ['actor_user_id', 'at'], ['entity_type', 'entity_id', 'at'], ['at']].map((columns) => ({ name: naming.indexName(TABLE, columns), columns }));

export class AuditLog1791000000000 implements MigrationInterface {
  name = 'AuditLog1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "${TABLE}" (
      "id" SERIAL NOT NULL,
      "at" timestamptz NOT NULL DEFAULT now(),
      "actor_type" character varying(8) NOT NULL,
      "actor_user_id" integer NULL,
      "actor_username" character varying NULL,
      "actor_role" character varying NULL,
      "action" character varying(40) NOT NULL,
      "entity_type" character varying(24) NOT NULL,
      "entity_id" integer NULL,
      "issuance_id" integer NULL,
      "batch_id" character varying(36) NULL,
      "details" jsonb NULL,
      CONSTRAINT "${PK}" PRIMARY KEY ("id")
    )`);
    for (const { name, columns } of INDEXES) {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "${TABLE}" (${columns.map((c) => `"${c}"`).join(', ')})`);
    }
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { name } of INDEXES) await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  }
}
