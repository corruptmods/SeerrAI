import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Songs only on an album, taken from it: the album each song asked for is
 * taken from, and each album's download and import.
 */
export class AddSongFetch1796400000000 implements MigrationInterface {
  name = 'AddSongFetch1796400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "song_fetch" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "albumMbid" varchar NOT NULL, "albumTitle" varchar NOT NULL, "artistMbid" varchar NOT NULL, "artistName" varchar NOT NULL, "recordings" text NOT NULL DEFAULT ('[]'), "status" varchar NOT NULL DEFAULT ('queued'), "stage" varchar, "error" varchar, "lidarrId" integer NOT NULL, "lidarrArtistId" integer, "lidarrAlbumId" integer, "release" text, "files" text NOT NULL DEFAULT ('[]'), "clientId" integer, "downloadId" varchar, "commandId" integer, "tried" text NOT NULL DEFAULT ('[]'), "startedAt" datetime, "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_720f5418d51bcc756a0ad0801c" ON "song_fetch" ("albumMbid") `
    );
    await queryRunner.query(
      `ALTER TABLE "song_request" ADD COLUMN "sourceAlbumMbid" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "song_request" ADD COLUMN "sourceAlbumTitle" varchar`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "song_request" DROP COLUMN "sourceAlbumTitle"`
    );
    await queryRunner.query(
      `ALTER TABLE "song_request" DROP COLUMN "sourceAlbumMbid"`
    );
    await queryRunner.query(`DROP INDEX "IDX_720f5418d51bcc756a0ad0801c"`);
    await queryRunner.query(`DROP TABLE "song_fetch"`);
  }
}
