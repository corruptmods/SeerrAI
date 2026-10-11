import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHiddenSliders1792900000000 implements MigrationInterface {
  name = 'AddHiddenSliders1792900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD COLUMN "hiddenSliders" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "hiddenSliders"`
    );
  }
}
