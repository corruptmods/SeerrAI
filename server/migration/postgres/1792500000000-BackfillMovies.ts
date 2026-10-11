import type { MigrationInterface, QueryRunner } from 'typeorm';

export class BackfillMovies1792500000000 implements MigrationInterface {
  name = 'BackfillMovies1792500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_series" DROP CONSTRAINT "UQ_6b14297daa3a5e0161dc08768ad"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_10276285eb5c13a0403d4fa5c4"`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_series" RENAME COLUMN "sonarrSeriesId" TO "arrId"`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_series" RENAME COLUMN "lastSonarrSearchAt" TO "lastArrSearchAt"`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_series" ADD "kind" character varying NOT NULL DEFAULT 'series'`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ff816dd03293157852acffd9df" ON "backfill_series" ("arrId") `
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_series" ADD CONSTRAINT "UQ_1fd3ef0eb10423c6f6aeb24ff49" UNIQUE ("kind", "serverId", "arrId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "backfill_series" WHERE "kind" = 'movie'`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_series" DROP CONSTRAINT "UQ_1fd3ef0eb10423c6f6aeb24ff49"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ff816dd03293157852acffd9df"`
    );
    await queryRunner.query(`ALTER TABLE "backfill_series" DROP COLUMN "kind"`);
    await queryRunner.query(
      `ALTER TABLE "backfill_series" RENAME COLUMN "lastArrSearchAt" TO "lastSonarrSearchAt"`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_series" RENAME COLUMN "arrId" TO "sonarrSeriesId"`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_10276285eb5c13a0403d4fa5c4" ON "backfill_series" ("sonarrSeriesId") `
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_series" ADD CONSTRAINT "UQ_6b14297daa3a5e0161dc08768ad" UNIQUE ("serverId", "sonarrSeriesId")`
    );
  }
}
