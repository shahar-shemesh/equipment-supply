import { MigrationInterface, QueryRunner } from 'typeorm';

//the self pickup handover (issuances.service.reportSelfPickup): the manager who handed the equipment over is recorded on
//the issuance, and the attempt hangs off a task without a courier. no foreign key on delivered_by_user_id, like
//delivery_tasks.assigned_by. guarded like the previous migrations, so it is a no-op on a LOCAL database that synchronize
//already updated
export class SelfPickupHandover1791100000000 implements MigrationInterface {
  name = 'SelfPickupHandover1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "issuances" ADD COLUMN IF NOT EXISTS "delivered_by_user_id" integer NULL`);
    await queryRunner.query(`ALTER TABLE "delivery_tasks" ALTER COLUMN "courier_id" DROP NOT NULL`);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //SET NOT NULL fails while handover tasks (courier_id null) exist: they have to be deleted or given a courier first,
  //the migration does not decide that for the operator
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delivery_tasks" ALTER COLUMN "courier_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "issuances" DROP COLUMN IF EXISTS "delivered_by_user_id"`);
  }
}
