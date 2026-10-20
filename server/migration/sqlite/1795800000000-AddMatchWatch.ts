import type { MigrationInterface, QueryRunner } from 'typeorm';

const HEALTH = 65536;
const WRONG_MATCH = 131072;

/**
 * Wrong matches caught as they happen: requested titles just imported,
 * waiting to be looked for on each media server, and the wrong matches
 * found, kept so each is told once. The Wrong Match notification is new,
 * so anyone whose channel sends Health gets it there too.
 */
export class AddMatchWatch1795800000000 implements MigrationInterface {
  name = 'AddMatchWatch1795800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "match_watch" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaId" integer NOT NULL, "kind" varchar NOT NULL, "mediaServer" varchar NOT NULL, "arrServerId" integer NOT NULL, "arrItemId" integer NOT NULL, "arrArtistId" integer, "importedAt" datetime NOT NULL, "nextCheckAt" datetime NOT NULL, "attempts" integer NOT NULL DEFAULT (0), CONSTRAINT "UQ_afeb1f7839b12726534ea708db8" UNIQUE ("mediaId", "mediaServer", "arrServerId", "arrItemId"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_39b3f2c35b117095eeb4eb2bf0" ON "match_watch" ("nextCheckAt") `
    );
    await queryRunner.query(
      `CREATE TABLE "match_problem" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "key" varchar NOT NULL, "mediaId" integer, "mediaServer" varchar NOT NULL, "kind" varchar NOT NULL, "problem" text NOT NULL, "arrServerId" integer, "arrItemId" integer, "arrAlbumId" integer, "notice" varchar NOT NULL DEFAULT ('waiting'), "foundAt" datetime NOT NULL, "sentAt" datetime, "resolvedAt" datetime, "nextCheckAt" datetime, CONSTRAINT "UQ_e74bff1941a015d6edbc7948012" UNIQUE ("key"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_824617c86536bf304e750955df" ON "match_problem" ("mediaId") `
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
      for (const [agent, types] of Object.entries(parsed)) {
        if (
          typeof types === 'number' &&
          types & HEALTH &&
          !(types & WRONG_MATCH)
        ) {
          parsed[agent] = types | WRONG_MATCH;
          changed = true;
        }
      }
      if (changed) {
        await queryRunner.query(
          `UPDATE "user_settings" SET "notificationTypes" = ? WHERE "id" = ?`,
          [JSON.stringify(parsed), row.id]
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The notification bit is left: removing it would undo a choice the
    // person may have made since.
    await queryRunner.query(`DROP INDEX "IDX_824617c86536bf304e750955df"`);
    await queryRunner.query(`DROP TABLE "match_problem"`);
    await queryRunner.query(`DROP INDEX "IDX_39b3f2c35b117095eeb4eb2bf0"`);
    await queryRunner.query(`DROP TABLE "match_watch"`);
  }
}
