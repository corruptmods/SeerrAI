import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Silo as a fourth media server: its ids on users and titles, its episodes as
 * the scans last listed them, and a local copy of its playback history.
 */
export class AddSilo1798700000000 implements MigrationInterface {
  name = 'AddSilo1798700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD "siloUsername" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "siloUserId" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "siloProfileId" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD "siloMediaId" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD "siloMediaId4k" character varying`
    );
    await queryRunner.query(
      `CREATE TABLE "silo_episode" ("contentId" character varying NOT NULL, "seriesId" character varying NOT NULL, "libraryIds" text NOT NULL, "season" integer NOT NULL, "episode" integer NOT NULL, "standard" boolean NOT NULL DEFAULT true, "uhd" boolean NOT NULL DEFAULT false, "quality" text, "seenAt" bigint NOT NULL DEFAULT '0', CONSTRAINT "PK_040c61364792b5ba62549dce7bd" PRIMARY KEY ("contentId"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e84c8bab1a4e8305ebb853320d" ON "silo_episode" ("seriesId") `
    );
    await queryRunner.query(
      `CREATE TABLE "silo_play" ("id" SERIAL NOT NULL, "sessionId" character varying NOT NULL, "userId" character varying NOT NULL, "profileId" character varying, "itemId" character varying NOT NULL, "titleId" character varying, "kind" character varying NOT NULL, "season" integer, "episode" integer, "endedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "completed" boolean NOT NULL DEFAULT false, "percent" integer NOT NULL DEFAULT '0', "title" character varying NOT NULL DEFAULT '', "viewerName" character varying NOT NULL DEFAULT '', CONSTRAINT "UQ_5707d411159aa75bdbdb2621d1c" UNIQUE ("sessionId"), CONSTRAINT "PK_f4e97f779ae1d6b5c1f90f6481e" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1211a06b3453c55a497809d161" ON "silo_play" ("endedAt") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_84e33930fec57bc9097dfd5a27" ON "silo_play" ("userId", "endedAt") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_84e33930fec57bc9097dfd5a27"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1211a06b3453c55a497809d161"`
    );
    await queryRunner.query(`DROP TABLE "silo_play"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e84c8bab1a4e8305ebb853320d"`
    );
    await queryRunner.query(`DROP TABLE "silo_episode"`);
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "siloMediaId4k"`);
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "siloMediaId"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "siloProfileId"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "siloUserId"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "siloUsername"`);
  }
}
