import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Each person's answer to a seasonal theme's note (Keep or Turn off), so it
 * holds on every device and isn't asked again until the season comes
 * round. Empty for everyone at first.
 */
export class AddSeasonNote1795300000000 implements MigrationInterface {
  name = 'AddSeasonNote1795300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "seasonNote" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "seasonNote"`
    );
  }
}
