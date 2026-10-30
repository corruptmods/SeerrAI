import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Playlists: a list is a watch list or a playlist, a playlist may be
 * linked to a Spotify or Apple Music playlist, and holds songs.
 */
export class AddPlaylists1796800000000 implements MigrationInterface {
  name = 'AddPlaylists1796800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD COLUMN "kind" varchar NOT NULL DEFAULT ('watch')`
    );
    for (const column of [
      `"sourceUrl" varchar`,
      `"sourceService" varchar`,
      `"sourceName" varchar`,
      `"sourceUserId" integer`,
      `"sourceReadAt" datetime`,
      `"sourceProblem" varchar`,
    ]) {
      await queryRunner.query(`ALTER TABLE "media_list" ADD COLUMN ${column}`);
    }
    await queryRunner.query(
      `CREATE TABLE "media_list_song" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "listId" integer NOT NULL, "sourceId" varchar NOT NULL, "position" integer NOT NULL DEFAULT (0), "title" varchar NOT NULL, "artistName" varchar NOT NULL, "length" integer, "recordingMbid" varchar, "artistMbid" varchar, "albumMbid" varchar, "state" varchar NOT NULL DEFAULT ('matching'), "problem" varchar, "requestId" integer, "requestForId" integer, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_06803408a636dc38002a3ae4ed9" UNIQUE ("listId", "sourceId"), CONSTRAINT "FK_741caef8be386bc1e7845ec5411" FOREIGN KEY ("listId") REFERENCES "media_list" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_741caef8be386bc1e7845ec541" ON "media_list_song" ("listId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b7b7218377d2b24287b8eb3c54" ON "media_list_song" ("recordingMbid") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_b7b7218377d2b24287b8eb3c54"`);
    await queryRunner.query(`DROP INDEX "IDX_741caef8be386bc1e7845ec541"`);
    await queryRunner.query(`DROP TABLE "media_list_song"`);
    for (const column of [
      'sourceProblem',
      'sourceReadAt',
      'sourceUserId',
      'sourceName',
      'sourceService',
      'sourceUrl',
      'kind',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "media_list" DROP COLUMN "${column}"`
      );
    }
  }
}
