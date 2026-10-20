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
      `CREATE TABLE "match_watch" ("id" SERIAL NOT NULL, "mediaId" integer NOT NULL, "kind" character varying NOT NULL, "mediaServer" character varying NOT NULL, "arrServerId" integer NOT NULL, "arrItemId" integer NOT NULL, "arrArtistId" integer, "importedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "nextCheckAt" TIMESTAMP WITH TIME ZONE NOT NULL, "attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "UQ_afeb1f7839b12726534ea708db8" UNIQUE ("mediaId", "mediaServer", "arrServerId", "arrItemId"), CONSTRAINT "PK_eaadd2da4afb9f13869cc1a3faa" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_39b3f2c35b117095eeb4eb2bf0" ON "match_watch" ("nextCheckAt") `
    );
    await queryRunner.query(
      `CREATE TABLE "match_problem" ("id" SERIAL NOT NULL, "key" character varying NOT NULL, "mediaId" integer, "mediaServer" character varying NOT NULL, "kind" character varying NOT NULL, "problem" text NOT NULL, "arrServerId" integer, "arrItemId" integer, "arrAlbumId" integer, "notice" character varying NOT NULL DEFAULT 'waiting', "foundAt" TIMESTAMP WITH TIME ZONE NOT NULL, "sentAt" TIMESTAMP WITH TIME ZONE, "resolvedAt" TIMESTAMP WITH TIME ZONE, "nextCheckAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_e74bff1941a015d6edbc7948012" UNIQUE ("key"), CONSTRAINT "PK_0dbf574dfad7b38517624101438" PRIMARY KEY ("id"))`
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
          `UPDATE "user_settings" SET "notificationTypes" = $1 WHERE "id" = $2`,
          [JSON.stringify(parsed), row.id]
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The notification bit is left: removing it would undo a choice the
    // person may have made since.
    await queryRunner.query(
      `DROP INDEX "public"."IDX_824617c86536bf304e750955df"`
    );
    await queryRunner.query(`DROP TABLE "match_problem"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_39b3f2c35b117095eeb4eb2bf0"`
    );
    await queryRunner.query(`DROP TABLE "match_watch"`);
  }
}
