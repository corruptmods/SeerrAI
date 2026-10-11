import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaEvent1791200000000 implements MigrationInterface {
  name = 'AddMediaEvent1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_event" (
        "id" SERIAL NOT NULL,
        "tmdbId" integer NOT NULL,
        "mediaType" character varying NOT NULL,
        "type" character varying NOT NULL,
        "is4k" boolean NOT NULL DEFAULT false,
        "userId" integer,
        "detail" character varying,
        "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_media_event" PRIMARY KEY ("id")
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_event_title" ON "media_event" ("mediaType", "tmdbId")`
    );
    await AddMediaEvent1791200000000.backfill(queryRunner);
  }

  /**
   * Existing titles start with what is known exactly: when each was
   * requested and by whom, blocklisted and why, and added to the library.
   * Approvals are left out: a request records only its latest change, so
   * their dates cannot be known.
   */
  public static async backfill(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "media_event" ("tmdbId", "mediaType", "type", "is4k", "userId", "occurredAt")
       SELECT m."tmdbId", m."mediaType", 'requested', r."is4k", r."requestedById", r."createdAt"
       FROM "media_request" r JOIN "media" m ON m."id" = r."mediaId"`
    );
    await queryRunner.query(
      `INSERT INTO "media_event" ("tmdbId", "mediaType", "type", "is4k", "userId", "detail", "occurredAt")
       SELECT b."tmdbId", b."mediaType", 'blocklisted', false, b."userId", b."reason", b."createdAt"
       FROM "blocklist" b`
    );
    await queryRunner.query(
      `INSERT INTO "media_event" ("tmdbId", "mediaType", "type", "is4k", "occurredAt")
       SELECT m."tmdbId", m."mediaType", 'added', false, m."mediaAddedAt"
       FROM "media" m WHERE m."mediaAddedAt" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_media_event_title"`);
    await queryRunner.query(`DROP TABLE "media_event"`);
  }
}
