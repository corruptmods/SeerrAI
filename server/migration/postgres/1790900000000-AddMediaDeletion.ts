import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaDeletion1790900000000 implements MigrationInterface {
  name = 'AddMediaDeletion1790900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_deletion" (
        "id" SERIAL NOT NULL,
        "tmdbId" integer NOT NULL,
        "mediaType" character varying NOT NULL,
        "deletedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_media_deletion" PRIMARY KEY ("id"),
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
