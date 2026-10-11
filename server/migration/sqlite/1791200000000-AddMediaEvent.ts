import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaEvent1791200000000 implements MigrationInterface {
  name = 'AddMediaEvent1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_event" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "tmdbId" integer NOT NULL,
        "mediaType" varchar NOT NULL,
        "type" varchar NOT NULL,
        "is4k" boolean NOT NULL DEFAULT (0),
        "userId" integer,
        "detail" varchar,
        "occurredAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_event_title" ON "media_event" ("mediaType", "tmdbId")`
    );
    await AddMediaEvent1791200000000.backfill(queryRunner);
  }

  /** See the Postgres migration. */
  public static async backfill(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "media_event" ("tmdbId", "mediaType", "type", "is4k", "userId", "occurredAt")
       SELECT m."tmdbId", m."mediaType", 'requested', r."is4k", r."requestedById", r."createdAt"
       FROM "media_request" r JOIN "media" m ON m."id" = r."mediaId"`
    );
    await queryRunner.query(
      `INSERT INTO "media_event" ("tmdbId", "mediaType", "type", "is4k", "userId", "detail", "occurredAt")
       SELECT b."tmdbId", b."mediaType", 'blocklisted', 0, b."userId", b."reason", b."createdAt"
       FROM "blocklist" b`
    );
    await queryRunner.query(
      `INSERT INTO "media_event" ("tmdbId", "mediaType", "type", "is4k", "occurredAt")
       SELECT m."tmdbId", m."mediaType", 'added', 0, m."mediaAddedAt"
       FROM "media" m WHERE m."mediaAddedAt" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_media_event_title"`);
    await queryRunner.query(`DROP TABLE "media_event"`);
  }
}
