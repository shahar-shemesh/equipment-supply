import { DefaultNamingStrategy, MigrationInterface, QueryRunner } from 'typeorm';

//the xml_import_files table (entities/xml-import-file.entity), the tracking table of the import etl in
//etls/issuance-xml-import. hand written with IF NOT EXISTS guards like the previous ones, so it is a no-op on a LOCAL
//database that synchronize already updated. no foreign keys by design (a row outlives the issuances it touched); the
//primary key and the two unique constraints are named by typeorm's own naming strategy, so synchronize sees no diff
//after this runs. the uuid default is gen_random_uuid(), built into postgres 13+, no extension
const naming = new DefaultNamingStrategy();
const TABLE = 'xml_import_files';
const PK = naming.primaryKeyName(TABLE, ['id']);
const UNIQUES = [['content_sha256'], ['document_id']].map((columns) => ({ name: naming.uniqueConstraintName(TABLE, columns), columns }));

export class XmlImportFiles1791600000000 implements MigrationInterface {
  name = 'XmlImportFiles1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "${TABLE}" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "content_sha256" character(64) NOT NULL,
      "document_id" character varying(100) NULL,
      "file_name" character varying NOT NULL,
      "size_bytes" integer NOT NULL,
      "status" character varying(12) NOT NULL,
      "error_kind" character varying(12) NULL,
      "attempts" integer NOT NULL DEFAULT 0,
      "instance_id" character varying(64) NULL,
      "lease_until" timestamptz NULL,
      "started_at" timestamptz NOT NULL DEFAULT now(),
      "finished_at" timestamptz NULL,
      "inserted" integer NOT NULL DEFAULT 0,
      "updated" integer NOT NULL DEFAULT 0,
      "unchanged" integer NOT NULL DEFAULT 0,
      "last_error" text NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "${PK}" PRIMARY KEY ("id"),
      ${UNIQUES.map(({ name, columns }) => `CONSTRAINT "${name}" UNIQUE (${columns.map((c) => `"${c}"`).join(', ')})`).join(',\n      ')}
    )`);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  }
}
