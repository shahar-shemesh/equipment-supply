import { MigrationInterface, QueryRunner } from 'typeorm';

//a report whose every line is "not delivered" has no recipient and no signature: nothing was handed over, so no one
//received and no one signed. the columns that held them become nullable on both tables that store a signed report.
//DROP NOT NULL is a no-op on a column that is already nullable, so this is safe on a LOCAL database that synchronize
//already updated. the way back puts the constraints again, which postgres refuses while such rows exist: a revert
//after reports without a recipient were stored is a deliberate data decision, not something this file makes
export class NoRecipientWithoutDelivery1790900000000 implements MigrationInterface {
  name = 'NoRecipientWithoutDelivery1790900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delivery_attempts" ALTER COLUMN "recipient_type" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "delivery_conflicts" ALTER COLUMN "recipient_type" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "delivery_conflicts" ALTER COLUMN "signature_png" DROP NOT NULL`);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delivery_conflicts" ALTER COLUMN "signature_png" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "delivery_conflicts" ALTER COLUMN "recipient_type" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "delivery_attempts" ALTER COLUMN "recipient_type" SET NOT NULL`);
  }
}
