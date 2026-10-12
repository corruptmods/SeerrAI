import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDiscoverNetworks1793000000000 implements MigrationInterface {
  name = 'AddDiscoverNetworks1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "discoverNetworks" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "discoverNetworks"`
    );
  }
}
