import { MigrationInterface, QueryRunner } from 'typeorm';

//the users table after the mock identities (docs/plans/auth-foundation.md): no credential column, the login is an
//identity key resolved to a username in mock mode and a verified token with the real provider; email is what the
//identity provider says about the person, nullable because the mock has it only for the seeded rows. guarded like
//the previous migrations, so it is a no-op on a LOCAL database that synchronize already updated
export class AuthMockIdentities1791400000000 implements MigrationInterface {
  name = 'AuthMockIdentities1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "password_hash"`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" character varying NULL`);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //the hashes are gone for good: the column comes back empty, every row gets a value nothing verifies against
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "email"`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" character varying NOT NULL DEFAULT ''`);
  }
}
