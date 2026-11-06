import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Quality profiles people pick for their own requests; none so far. */
export class AddUserDefaultProfiles1797900000002 implements MigrationInterface {
  name = 'AddUserDefaultProfiles1797900000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "defaultProfiles" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "defaultProfiles"`
    );
  }
}
