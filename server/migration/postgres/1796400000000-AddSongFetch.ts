import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Songs only on an album, taken from it: the album each song asked for is
 * taken from, and each album's download and import.
 */
export class AddSongFetch1796400000000 implements MigrationInterface {
  name = 'AddSongFetch1796400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "song_fetch" ("id" SERIAL NOT NULL, "albumMbid" character varying NOT NULL, "albumTitle" character varying NOT NULL, "artistMbid" character varying NOT NULL, "artistName" character varying NOT NULL, "recordings" text NOT NULL DEFAULT '[]', "status" character varying NOT NULL DEFAULT 'queued', "stage" character varying, "error" character varying, "lidarrId" integer NOT NULL, "lidarrArtistId" integer, "lidarrAlbumId" integer, "release" text, "files" text NOT NULL DEFAULT '[]', "clientId" integer, "downloadId" character varying, "commandId" integer, "tried" text NOT NULL DEFAULT '[]', "startedAt" TIMESTAMP WITH TIME ZONE, "finishedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_03aa506784a2a0ed476939b3cdc" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_720f5418d51bcc756a0ad0801c" ON "song_fetch" ("albumMbid") `
    );
    await queryRunner.query(
      `ALTER TABLE "song_request" ADD "sourceAlbumMbid" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "song_request" ADD "sourceAlbumTitle" character varying`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "song_request" DROP COLUMN "sourceAlbumTitle"`
    );
    await queryRunner.query(
      `ALTER TABLE "song_request" DROP COLUMN "sourceAlbumMbid"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_720f5418d51bcc756a0ad0801c"`
    );
    await queryRunner.query(`DROP TABLE "song_fetch"`);
  }
}
