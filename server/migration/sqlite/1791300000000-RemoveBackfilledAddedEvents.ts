import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the "Added to the library" events the history backfill created.
 *
 * They were dated from media.mediaAddedAt, which the database fills in when
 * Seerr first creates a title's record — usually when it is requested — so
 * titles not yet released showed as added, and others showed their request
 * date. The real date cannot be recovered: when Radarr or Sonarr marks a
 * title available before the media server scan does, the column is never
 * updated. Availability is recorded as it happens from now on.
 */
export class RemoveBackfilledAddedEvents1791300000000 implements MigrationInterface {
  name = 'RemoveBackfilledAddedEvents1791300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "media_event" WHERE "type" = 'added'`);
  }

  public async down(): Promise<void> {
    // The removed events were wrong; there is nothing to restore.
  }
}
