import type { MigrationInterface, QueryRunner } from 'typeorm';

const MEDIA_AVAILABLE = 8;
const MEDIA_FAILED = 16;
const PLAYLIST_UPDATE = 262144;
const REQUEST_FAILED = 524288;
const LEAVING_SOON = 1048576;
/** What web push sent before each person could choose any type. */
const OLD_WEB_PUSH = 8 | 16 | 32 | 8192 | 16384 | 32768 | 65536 | 131072;
/** The services that tell each person through their own settings. */
const PERSONAL = ['email', 'webpush', 'telegram', 'pushbullet', 'pushover'];

/**
 * New personal notifications: Request Failed (a person's own failures, apart
 * from the copies admins get), Playlist Updates and Leaving Soon. Whoever
 * was told of failures keeps being told, and of a playlist's too; whoever
 * is told what is ready is told what is leaving. Web push now sends every
 * type, so what someone had keeps to what it sent before: the rest is theirs
 * to turn on.
 */
export class AddPersonalNotificationTypes1797700000000 implements MigrationInterface {
  name = 'AddPersonalNotificationTypes1797700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
        let types = agent === 'webpush' ? before & OLD_WEB_PUSH : before;
        if (types & MEDIA_FAILED) types |= REQUEST_FAILED | PLAYLIST_UPDATE;
        if (types & MEDIA_AVAILABLE) types |= LEAVING_SOON;
        if (types !== before) {
          parsed[agent] = types;
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

  public async down(): Promise<void> {
    // Left as chosen: undoing it would undo choices made since.
  }
}
