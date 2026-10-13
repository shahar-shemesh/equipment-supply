import { MigrationInterface, QueryRunner } from 'typeorm';

//one SAP line taken off an issuance (issuances.service.removeItem). the line keeps its row with removed_at set because
//delivery_attempt_items.item_id points at it with no foreign key and a past attempt must keep its reference. guarded like
//the previous migrations, so it is a no-op on a LOCAL database that synchronize already updated
export class RemoveIssuanceItem1791200000000 implements MigrationInterface {
  name = 'RemoveIssuanceItem1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "issuance_items" ADD COLUMN IF NOT EXISTS "removed_at" timestamptz NULL`);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //dropping the column brings every removed line back as a live one: the mark was the only thing that hid them
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "issuance_items" DROP COLUMN IF EXISTS "removed_at"`);
  }
}
