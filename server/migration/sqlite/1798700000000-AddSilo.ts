import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Silo as a fourth media server: its ids on users and titles, its episodes as
 * the scans last listed them, and a local copy of its playback history.
 */
export class AddSilo1798700000000 implements MigrationInterface {
  name = 'AddSilo1798700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "siloUsername" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "siloUserId" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "siloProfileId" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD COLUMN "siloMediaId" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD COLUMN "siloMediaId4k" varchar`
    );
    await queryRunner.query(
      `CREATE TABLE "silo_episode" ("contentId" varchar PRIMARY KEY NOT NULL, "seriesId" varchar NOT NULL, "libraryIds" text NOT NULL, "season" integer NOT NULL, "episode" integer NOT NULL, "standard" boolean NOT NULL DEFAULT (1), "uhd" boolean NOT NULL DEFAULT (0), "quality" text, "seenAt" bigint NOT NULL DEFAULT (0))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e84c8bab1a4e8305ebb853320d" ON "silo_episode" ("seriesId") `
    );
    await queryRunner.query(
      `CREATE TABLE "silo_play" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "sessionId" varchar NOT NULL, "userId" varchar NOT NULL, "profileId" varchar, "itemId" varchar NOT NULL, "titleId" varchar, "kind" varchar NOT NULL, "season" integer, "episode" integer, "endedAt" datetime NOT NULL, "completed" boolean NOT NULL DEFAULT (0), "percent" integer NOT NULL DEFAULT (0), "title" varchar NOT NULL DEFAULT (''), CONSTRAINT "UQ_5707d411159aa75bdbdb2621d1c" UNIQUE ("sessionId"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1211a06b3453c55a497809d161" ON "silo_play" ("endedAt") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_84e33930fec57bc9097dfd5a27" ON "silo_play" ("userId", "endedAt") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_84e33930fec57bc9097dfd5a27"`);
    await queryRunner.query(`DROP INDEX "IDX_1211a06b3453c55a497809d161"`);
    await queryRunner.query(`DROP TABLE "silo_play"`);
    await queryRunner.query(`DROP INDEX "IDX_e84c8bab1a4e8305ebb853320d"`);
    await queryRunner.query(`DROP TABLE "silo_episode"`);
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "siloMediaId4k"`);
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "siloMediaId"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "siloProfileId"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "siloUserId"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "siloUsername"`);
  }
}
