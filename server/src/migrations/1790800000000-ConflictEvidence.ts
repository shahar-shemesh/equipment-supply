import { DefaultNamingStrategy, MigrationInterface, QueryRunner } from 'typeorm';

//the evidence table for rejected delivery reports (delivery_conflicts). hand written with IF NOT EXISTS guards like the
//offline sync migration, so it is a no-op on a LOCAL database that synchronize already updated. the constraint names come
//from typeorm's own naming strategy, so synchronize sees no diff after this runs. assumes the tables of the previous
//versions exist, it does not create them
const naming = new DefaultNamingStrategy();
const PK = naming.primaryKeyName('delivery_conflicts', ['id']);
const FK = naming.foreignKeyName('delivery_conflicts', ['task_id'], 'delivery_tasks', ['id']);

export class ConflictEvidence1790800000000 implements MigrationInterface {
  name = 'ConflictEvidence1790800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "delivery_conflicts" (
      "id" SERIAL NOT NULL,
      "user_id" integer NOT NULL,
      "courier_id" integer NOT NULL,
      "operation_id" character varying(64) NOT NULL,
      "task_id" integer NOT NULL,
      "issuance_id" integer NOT NULL,
      "submitted_revision" integer NULL,
      "recipient_type" character varying NOT NULL,
      "recipient_name" character varying NULL,
      "recipient_id_number" character varying NULL,
      "recipient_phone" character varying NULL,
      "items" jsonb NOT NULL,
      "signature_png" text NOT NULL,
      "payload_hash" character varying(64) NOT NULL,
      "rejection_code" character varying NOT NULL,
      "rejection_message" text NULL,
      "observed" jsonb NOT NULL,
      "client_reported_at" timestamptz NULL,
      "received_at" timestamptz NOT NULL DEFAULT now(),
      "review_status" character varying NOT NULL DEFAULT 'pending',
      "reviewed_by" integer NULL,
      "reviewed_at" timestamptz NULL,
      "review_note" text NULL,
      "review_version" integer NOT NULL DEFAULT 0,
      CONSTRAINT "${PK}" PRIMARY KEY ("id"),
      CONSTRAINT "${FK}" FOREIGN KEY ("task_id") REFERENCES "delivery_tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_delivery_conflicts_user_operation" ON "delivery_conflicts" ("user_id", "operation_id")`);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_delivery_conflicts_user_operation"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "delivery_conflicts"`);
  }
}
