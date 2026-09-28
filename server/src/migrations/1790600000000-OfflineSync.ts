import { MigrationInterface, QueryRunner } from 'typeorm';

//the offline courier work: a revision on the issuance, the device time on the attempt, and the operations table that
//makes a report idempotent. hand written, with IF NOT EXISTS guards, so it is a no-op on a LOCAL database that
//synchronize already updated. the column types and the constraint names are exactly what synchronize would create from
//the entities (typeorm's DefaultNamingStrategy for the PK and the FK), so synchronize sees no diff after this runs.
//assumes the tables of the previous version exist, it does not create them
export class OfflineSync1790600000000 implements MigrationInterface {
  name = 'OfflineSync1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "issuances" ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1`);
    await queryRunner.query(`ALTER TABLE "delivery_attempts" ADD COLUMN IF NOT EXISTS "client_reported_at" timestamptz NULL`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "delivery_operations" (
      "id" SERIAL NOT NULL,
      "user_id" integer NOT NULL,
      "courier_id" integer NOT NULL,
      "operation_id" character varying(64) NOT NULL,
      "task_id" integer NOT NULL,
      "attempt_id" integer NOT NULL,
      "payload_hash" character varying(64) NOT NULL,
      "client_reported_at" timestamptz NULL,
      "received_at" timestamptz NOT NULL DEFAULT now(),
      "result" jsonb NOT NULL,
      CONSTRAINT "PK_eec63c5360cfb1612c61bc97aa3" PRIMARY KEY ("id"),
      CONSTRAINT "FK_ec298294ee28fdd0ebb31b4bb87" FOREIGN KEY ("attempt_id") REFERENCES "delivery_attempts"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_delivery_operations_user_operation" ON "delivery_operations" ("user_id", "operation_id")`);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_delivery_operations_user_operation"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "delivery_operations"`);
    await queryRunner.query(`ALTER TABLE "delivery_attempts" DROP COLUMN IF EXISTS "client_reported_at"`);
    await queryRunner.query(`ALTER TABLE "issuances" DROP COLUMN IF EXISTS "revision"`);
  }
}
