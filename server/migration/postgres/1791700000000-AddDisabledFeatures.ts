import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDisabledFeatures1791700000000 implements MigrationInterface {
  name = 'AddDisabledFeatures1791700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "disabledFeatures" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "disabledFeatures"`
    );
  }
}
