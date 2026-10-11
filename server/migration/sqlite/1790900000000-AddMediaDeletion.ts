import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaDeletion1790900000000 implements MigrationInterface {
  name = 'AddMediaDeletion1790900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_deletion" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "tmdbId" integer NOT NULL,
        "mediaType" varchar NOT NULL,
        "deletedAt" datetime NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "UQ_media_deletion_tmdb_type" UNIQUE ("tmdbId", "mediaType")
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_deletion_tmdbId" ON "media_deletion" ("tmdbId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_media_deletion_tmdbId"`);
    await queryRunner.query(`DROP TABLE "media_deletion"`);
  }
}
