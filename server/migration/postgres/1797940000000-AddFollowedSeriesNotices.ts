import type { MigrationInterface, QueryRunner } from 'typeorm';

const MEDIA_AVAILABLE = 8;
const FOLLOWED_SERIES = 2097152;
/** The services that tell each person through their own settings. */
const PERSONAL = ['email', 'webpush', 'telegram', 'pushbullet', 'pushover'];

/**
 * Followed series tell their followers what happened: the latest season each
 * was told premiered, which for an existing follow is the one before the next
 * it waits for, and the Followed Series notification for whoever is told what
 * is ready.
 */
export class AddFollowedSeriesNotices1797940000000 implements MigrationInterface {
  name = 'AddFollowedSeriesNotices1797940000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "future_season_subscription" ADD "premieredSeason" integer NOT NULL DEFAULT '0'`
    );
    await queryRunner.query(
      `UPDATE "future_season_subscription" SET "premieredSeason" = "fromSeason" - 1`
    );

    const rows: { id: number; notificationTypes: string | null }[] =
      await queryRunner.query(
        `SELECT "id", "notificationTypes" FROM "user_settings"`
      );
    for (const row of rows) {
      if (!row.notificationTypes) continue;
      let parsed: Record<string, number>;
      try {
        parsed = JSON.parse(row.notificationTypes);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      let changed = false;
      for (const [agent, before] of Object.entries(parsed)) {
        if (typeof before !== 'number' || !PERSONAL.includes(agent)) continue;
        if (before & MEDIA_AVAILABLE && !(before & FOLLOWED_SERIES)) {
          parsed[agent] = before | FOLLOWED_SERIES;
          changed = true;
        }
      }
      if (changed) {
        await queryRunner.query(
          `UPDATE "user_settings" SET "notificationTypes" = $1 WHERE "id" = $2`,
          [JSON.stringify(parsed), row.id]
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Notification choices are left as they are: undoing them would undo
    // choices made since.
    await queryRunner.query(
      `ALTER TABLE "future_season_subscription" DROP COLUMN "premieredSeason"`
    );
  }
}
