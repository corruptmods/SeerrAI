import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Songs asked for one at a time: each one version of a song, kept on the
 * music request beside its albums.
 */
export class AddSongRequest1796200000000 implements MigrationInterface {
  name = 'AddSongRequest1796200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "song_request" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "recordingMbid" varchar NOT NULL, "title" varchar NOT NULL, "version" varchar, "length" integer, "albumMbid" varchar, "albumTitle" varchar, "releaseGroups" text NOT NULL DEFAULT (''), "status" integer NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "requestId" integer, CONSTRAINT "FK_016d36d449ceddfcc01bfd2182a" FOREIGN KEY ("requestId") REFERENCES "media_request" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_493582ca7cead1c9d301bc1b38" ON "song_request" ("recordingMbid") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_016d36d449ceddfcc01bfd2182" ON "song_request" ("requestId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_016d36d449ceddfcc01bfd2182"`);
    await queryRunner.query(`DROP INDEX "IDX_493582ca7cead1c9d301bc1b38"`);
    await queryRunner.query(`DROP TABLE "song_request"`);
  }
}
