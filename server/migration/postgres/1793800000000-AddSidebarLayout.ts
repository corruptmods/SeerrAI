import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSidebarLayout1793800000000 implements MigrationInterface {
  name = 'AddSidebarLayout1793800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "sidebarOrder" text`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "sidebarHidden" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "sidebarHidden"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "sidebarOrder"`
    );
  }
}
