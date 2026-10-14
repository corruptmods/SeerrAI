import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMusic1794000000000 implements MigrationInterface {
  name = 'AddMusic1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "music_album" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaId" integer NOT NULL, "mbId" varchar, "title" varchar NOT NULL, "primaryType" varchar, "secondaryTypes" text NOT NULL DEFAULT (''), "releaseDate" varchar, "status" integer NOT NULL DEFAULT (1), "lidarrAlbumId" integer, "trackCount" integer, "trackFileCount" integer, "ratingKey" varchar, "jellyfinItemId" varchar, "embyItemId" varchar, "folder" varchar, "mediaAddedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "FK_29d126dec191c2c2fe4962e00c7" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
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
      `CREATE TABLE "album_request" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "albumMbid" varchar NOT NULL, "title" varchar NOT NULL, "status" integer NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "requestId" integer, CONSTRAINT "FK_feb0fcc666a476d9a6582543911" FOREIGN KEY ("requestId") REFERENCES "media_request" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_86b42811dc159826ff26c7d00b" ON "album_request" ("albumMbid") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_feb0fcc666a476d9a658254391" ON "album_request" ("requestId") `
    );
    await queryRunner.query(
      `CREATE TABLE "music_metadata" ("key" varchar(100) PRIMARY KEY NOT NULL, "data" text NOT NULL, "fetchedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "expiresAt" datetime)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a6da224f8eab08d27caf3cdc57" ON "music_metadata" ("expiresAt") `
    );
    await queryRunner.query(
      `ALTER TABLE "media_event" ADD COLUMN "foreignId" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "musicQuotaLimit" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "musicQuotaDays" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD COLUMN "foreignId" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "metadataProfileId" integer`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c4e680e2d592c32025c40b97d0" ON "media_event" ("foreignId") `
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_40a605bb838a92795d132aacdb" ON "media" ("mediaType", "foreignId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_40a605bb838a92795d132aacdb"`);
    await queryRunner.query(`DROP INDEX "IDX_c4e680e2d592c32025c40b97d0"`);
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
