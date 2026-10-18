import { DefaultNamingStrategy, MigrationInterface, QueryRunner } from 'typeorm';

const naming = new DefaultNamingStrategy();
//the name synchronize gives the entity's unique: true (courier.entity.ts), so a LOCAL database shows no diff
export const COURIERS_USER_UNIQUE = naming.uniqueConstraintName('couriers', ['user_id']);

//one login account holds at most one courier row: the courier operations resolve the row from the account on every
//call (delivery/courier-identity.service.ts) and the tablet keys its offline data by users.id + couriers.id, so two
//rows for one account would be two identities answering for one person. a unique constraint on user_id; null stays
//allowed and repeatable (a courier without a login).
//data first: a database that already holds two rows for one account refuses the migration and names them, the rows are
//fixed by hand (which one is the person's), the constraint is never forced over them
export class CourierUserUnique1791500000000 implements MigrationInterface {
  name = 'CourierUserUnique1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const duplicates: { user_id: number; ids: string }[] = await queryRunner.query(`SELECT "user_id", string_agg("id"::text, ',' ORDER BY "id") AS ids FROM "couriers" WHERE "user_id" IS NOT NULL GROUP BY "user_id" HAVING count(*) > 1 ORDER BY "user_id"`);
    if (duplicates.length) {
      throw new Error(`couriers.user_id is not unique, fix these rows before the migration: ${duplicates.map((d) => `user ${d.user_id} -> couriers ${d.ids}`).join('; ')}`);
    }
    const existing = await queryRunner.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [COURIERS_USER_UNIQUE]);
    if (!existing.length) await queryRunner.query(`ALTER TABLE "couriers" ADD CONSTRAINT "${COURIERS_USER_UNIQUE}" UNIQUE ("user_id")`);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "couriers" DROP CONSTRAINT IF EXISTS "${COURIERS_USER_UNIQUE}"`);
  }
}
