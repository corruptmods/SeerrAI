import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTraktUsername1793100000000 implements MigrationInterface {
  name = 'AddTraktUsername1793100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD COLUMN "traktUsername" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "traktUsername"`
    );
  }
}
