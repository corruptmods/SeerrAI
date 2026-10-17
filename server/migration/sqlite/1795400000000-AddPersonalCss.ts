import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Each person's own CSS (Profile → Settings → Appearance), used only when
 * an admin lets people add their own. Empty for everyone at first.
 */
export class AddPersonalCss1795400000000 implements MigrationInterface {
  name = 'AddPersonalCss1795400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD COLUMN "customCss" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "customCss"`
    );
  }
}
