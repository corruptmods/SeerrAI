import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Each person's own look (Profile → Settings → Appearance): light or dark,
 * accent, dark background and extras, kept as one JSON value. Empty for the
 * people who use the server's default, which is everyone at first.
 */
export class AddAppearance1795200000000 implements MigrationInterface {
  name = 'AddAppearance1795200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "appearance" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "appearance"`
    );
  }
}
