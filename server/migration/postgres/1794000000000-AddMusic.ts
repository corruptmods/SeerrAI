import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMusic1794000000000 implements MigrationInterface {
  name = 'AddMusic1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "music_album" ("id" SERIAL NOT NULL, "mediaId" integer NOT NULL, "mbId" character varying, "title" character varying NOT NULL, "primaryType" character varying, "secondaryTypes" text NOT NULL DEFAULT '', "releaseDate" character varying, "status" integer NOT NULL DEFAULT '1', "lidarrAlbumId" integer, "trackCount" integer, "trackFileCount" integer, "ratingKey" character varying, "jellyfinItemId" character varying, "embyItemId" character varying, "folder" character varying, "mediaAddedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8b1339d081db9d21cb549944e10" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_29d126dec191c2c2fe4962e00c" ON "music_album" ("mediaId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_530bcb377c30d3ad933446ffee" ON "music_album" ("status") `
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_6188a4cc11d2b2a80fba927b11" ON "music_album" ("mediaId", "mbId") `
    );
    await queryRunner.query(
      `CREATE TABLE "album_request" ("id" SERIAL NOT NULL, "albumMbid" character varying NOT NULL, "title" character varying NOT NULL, "status" integer NOT NULL DEFAULT '1', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "requestId" integer, CONSTRAINT "PK_10a492ae7c143db5f1ad57dce24" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_86b42811dc159826ff26c7d00b" ON "album_request" ("albumMbid") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_feb0fcc666a476d9a658254391" ON "album_request" ("requestId") `
    );
    await queryRunner.query(
      `CREATE TABLE "music_metadata" ("key" character varying(100) NOT NULL, "data" text NOT NULL, "fetchedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expiresAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_58a6a66e0312c332c904c3d5ab3" PRIMARY KEY ("key"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a6da224f8eab08d27caf3cdc57" ON "music_metadata" ("expiresAt") `
    );
    await queryRunner.query(
      `ALTER TABLE "media_event" ADD "foreignId" character varying`
    );
    await queryRunner.query(`ALTER TABLE "user" ADD "musicQuotaLimit" integer`);
    await queryRunner.query(`ALTER TABLE "user" ADD "musicQuotaDays" integer`);
    await queryRunner.query(
      `ALTER TABLE "media" ADD "foreignId" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "metadataProfileId" integer`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c4e680e2d592c32025c40b97d0" ON "media_event" ("foreignId") `
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_40a605bb838a92795d132aacdb" ON "media" ("mediaType", "foreignId") `
    );
    await queryRunner.query(
      `ALTER TABLE "music_album" ADD CONSTRAINT "FK_29d126dec191c2c2fe4962e00c7" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "album_request" ADD CONSTRAINT "FK_feb0fcc666a476d9a6582543911" FOREIGN KEY ("requestId") REFERENCES "media_request"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "album_request" DROP CONSTRAINT "FK_feb0fcc666a476d9a6582543911"`
    );
    await queryRunner.query(
      `ALTER TABLE "music_album" DROP CONSTRAINT "FK_29d126dec191c2c2fe4962e00c7"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_40a605bb838a92795d132aacdb"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_c4e680e2d592c32025c40b97d0"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "metadataProfileId"`
    );
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "foreignId"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "musicQuotaDays"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "musicQuotaLimit"`);
    await queryRunner.query(
      `ALTER TABLE "media_event" DROP COLUMN "foreignId"`
    );
    await queryRunner.query(`DROP TABLE "music_metadata"`);
    await queryRunner.query(`DROP TABLE "album_request"`);
    await queryRunner.query(`DROP TABLE "music_album"`);
  }
}
