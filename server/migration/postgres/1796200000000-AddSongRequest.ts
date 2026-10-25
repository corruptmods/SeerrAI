import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Songs asked for one at a time: each one version of a song, kept on the
 * music request beside its albums.
 */
export class AddSongRequest1796200000000 implements MigrationInterface {
  name = 'AddSongRequest1796200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "song_request" ("id" SERIAL NOT NULL, "recordingMbid" character varying NOT NULL, "title" character varying NOT NULL, "version" character varying, "length" integer, "albumMbid" character varying, "albumTitle" character varying, "releaseGroups" text NOT NULL DEFAULT '', "status" integer NOT NULL DEFAULT '1', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "requestId" integer, CONSTRAINT "PK_c2b53ff7f5fc5bf370a3f32ebf8" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_493582ca7cead1c9d301bc1b38" ON "song_request" ("recordingMbid") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_016d36d449ceddfcc01bfd2182" ON "song_request" ("requestId") `
    );
    await queryRunner.query(
      `ALTER TABLE "song_request" ADD CONSTRAINT "FK_016d36d449ceddfcc01bfd2182a" FOREIGN KEY ("requestId") REFERENCES "media_request"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "song_request" DROP CONSTRAINT "FK_016d36d449ceddfcc01bfd2182a"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_016d36d449ceddfcc01bfd2182"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_493582ca7cead1c9d301bc1b38"`
    );
    await queryRunner.query(`DROP TABLE "song_request"`);
  }
}
