import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Diwali and Pride Month were seasonal themes. Someone's answer to one's
 * note ('diwali-2026:off') can no longer mean anything, so it is cleared;
 * answers about the seasons that remain are kept.
 */
export class ClearRetiredSeasonNotes1795500000000 implements MigrationInterface {
  name = 'ClearRetiredSeasonNotes1795500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "user_settings" SET "seasonNote" = NULL WHERE "seasonNote" LIKE 'diwali-%' OR "seasonNote" LIKE 'pride-%'`
    );
  }

  public async down(): Promise<void> {
    // The answers were about seasons that no longer exist; there is
    // nothing to put back.
  }
}
