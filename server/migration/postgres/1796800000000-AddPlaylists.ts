import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Playlists: a list is a watch list or a playlist, a playlist may be
 * linked to a Spotify or Apple Music playlist, and holds songs.
 */
export class AddPlaylists1796800000000 implements MigrationInterface {
  name = 'AddPlaylists1796800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD "kind" character varying NOT NULL DEFAULT 'watch'`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD "sourceUrl" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD "sourceService" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD "sourceName" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD "sourceUserId" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD "sourceReadAt" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD "sourceProblem" character varying`
    );
    await queryRunner.query(
      `CREATE TABLE "media_list_song" ("id" SERIAL NOT NULL, "listId" integer NOT NULL, "sourceId" character varying NOT NULL, "position" integer NOT NULL DEFAULT '0', "title" character varying NOT NULL, "artistName" character varying NOT NULL, "length" integer, "recordingMbid" character varying, "artistMbid" character varying, "albumMbid" character varying, "state" character varying NOT NULL DEFAULT 'matching', "problem" character varying, "requestId" integer, "requestForId" integer, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_06803408a636dc38002a3ae4ed9" UNIQUE ("listId", "sourceId"), CONSTRAINT "PK_54c237629e7156bc0a98a2e7fab" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_741caef8be386bc1e7845ec541" ON "media_list_song" ("listId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b7b7218377d2b24287b8eb3c54" ON "media_list_song" ("recordingMbid") `
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_song" ADD CONSTRAINT "FK_741caef8be386bc1e7845ec5411" FOREIGN KEY ("listId") REFERENCES "media_list"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_song" DROP CONSTRAINT "FK_741caef8be386bc1e7845ec5411"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b7b7218377d2b24287b8eb3c54"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_741caef8be386bc1e7845ec541"`
    );
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
