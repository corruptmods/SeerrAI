import type { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS = `"id", "serverId", "tvdbId", "tmdbId", "title", "year", "seriesType", "poster", "status", "missing", "belowCutoff", "searchTerms", "lastSearchedAt", "searchError", "createdAt", "updatedAt"`;

export class BackfillMovies1792500000000 implements MigrationInterface {
  name = 'BackfillMovies1792500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_10276285eb5c13a0403d4fa5c4"`);
    await queryRunner.query(`DROP INDEX "IDX_2add2fa335e706edbe4822860a"`);
    await queryRunner.query(
      `CREATE TABLE "temporary_backfill_series" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "kind" varchar NOT NULL DEFAULT ('series'), "serverId" integer NOT NULL, "arrId" integer NOT NULL, "tvdbId" integer, "tmdbId" integer, "title" varchar NOT NULL, "year" integer, "seriesType" varchar NOT NULL DEFAULT ('standard'), "poster" varchar, "status" varchar NOT NULL DEFAULT ('stuck'), "missing" integer NOT NULL DEFAULT (0), "belowCutoff" integer NOT NULL DEFAULT (0), "searchTerms" text NOT NULL DEFAULT ('[]'), "lastArrSearchAt" datetime, "lastSearchedAt" datetime, "searchError" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_1fd3ef0eb10423c6f6aeb24ff49" UNIQUE ("kind", "serverId", "arrId"))`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_backfill_series"(${COLUMNS}, "arrId", "lastArrSearchAt") SELECT ${COLUMNS}, "sonarrSeriesId", "lastSonarrSearchAt" FROM "backfill_series"`
    );
    await queryRunner.query(`DROP TABLE "backfill_series"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_backfill_series" RENAME TO "backfill_series"`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ff816dd03293157852acffd9df" ON "backfill_series" ("arrId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2add2fa335e706edbe4822860a" ON "backfill_series" ("status")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Inside the migration's transaction foreign keys stay on, so dropping
    // the table would take every job and candidate with it: the series'
    // ones are kept aside and put back.
    for (const table of ['backfill_job', 'backfill_candidate']) {
      await queryRunner.query(
        `CREATE TEMPORARY TABLE "kept_${table}" AS SELECT * FROM "${table}" WHERE "seriesId" IN (SELECT "id" FROM "backfill_series" WHERE "kind" = 'series')`
      );
    }
    await queryRunner.query(`DROP INDEX "IDX_ff816dd03293157852acffd9df"`);
    await queryRunner.query(`DROP INDEX "IDX_2add2fa335e706edbe4822860a"`);
    await queryRunner.query(
      `CREATE TABLE "temporary_backfill_series" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "serverId" integer NOT NULL, "sonarrSeriesId" integer NOT NULL, "tvdbId" integer, "tmdbId" integer, "title" varchar NOT NULL, "year" integer, "seriesType" varchar NOT NULL DEFAULT ('standard'), "poster" varchar, "status" varchar NOT NULL DEFAULT ('stuck'), "missing" integer NOT NULL DEFAULT (0), "belowCutoff" integer NOT NULL DEFAULT (0), "searchTerms" text NOT NULL DEFAULT ('[]'), "lastSonarrSearchAt" datetime, "lastSearchedAt" datetime, "searchError" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_6b14297daa3a5e0161dc08768ad" UNIQUE ("serverId", "sonarrSeriesId"))`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_backfill_series"(${COLUMNS}, "sonarrSeriesId", "lastSonarrSearchAt") SELECT ${COLUMNS}, "arrId", "lastArrSearchAt" FROM "backfill_series" WHERE "kind" = 'series'`
    );
    await queryRunner.query(`DROP TABLE "backfill_series"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_backfill_series" RENAME TO "backfill_series"`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_10276285eb5c13a0403d4fa5c4" ON "backfill_series" ("sonarrSeriesId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2add2fa335e706edbe4822860a" ON "backfill_series" ("status")`
    );
    for (const table of ['backfill_job', 'backfill_candidate']) {
      await queryRunner.query(`DELETE FROM "${table}"`);
      await queryRunner.query(
        `INSERT INTO "${table}" SELECT * FROM "kept_${table}"`
      );
      await queryRunner.query(`DROP TABLE "kept_${table}"`);
    }
  }
}
