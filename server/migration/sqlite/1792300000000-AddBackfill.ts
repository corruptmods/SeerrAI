import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBackfill1792300000000 implements MigrationInterface {
  name = 'AddBackfill1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "backfill_series" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "serverId" integer NOT NULL, "sonarrSeriesId" integer NOT NULL, "tvdbId" integer, "tmdbId" integer, "title" varchar NOT NULL, "year" integer, "seriesType" varchar NOT NULL DEFAULT ('standard'), "poster" varchar, "status" varchar NOT NULL DEFAULT ('stuck'), "missing" integer NOT NULL DEFAULT (0), "belowCutoff" integer NOT NULL DEFAULT (0), "searchTerms" text NOT NULL DEFAULT ('[]'), "lastSonarrSearchAt" datetime, "lastSearchedAt" datetime, "searchError" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_6b14297daa3a5e0161dc08768ad" UNIQUE ("serverId", "sonarrSeriesId"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_10276285eb5c13a0403d4fa5c4" ON "backfill_series" ("sonarrSeriesId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2add2fa335e706edbe4822860a" ON "backfill_series" ("status")`
    );
    await queryRunner.query(
      `CREATE TABLE "backfill_job" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "seriesId" integer NOT NULL, "candidateId" integer, "title" text NOT NULL, "status" varchar NOT NULL DEFAULT ('queued'), "mode" varchar NOT NULL DEFAULT ('missing'), "protocol" varchar NOT NULL, "clientId" integer NOT NULL, "stage" varchar, "downloadId" varchar, "files" text NOT NULL DEFAULT ('[]'), "progress" integer NOT NULL DEFAULT (0), "size" bigint NOT NULL DEFAULT (0), "sizeLeft" bigint NOT NULL DEFAULT (0), "speed" integer NOT NULL DEFAULT (0), "secondsLeft" integer, "imported" integer NOT NULL DEFAULT (0), "replaced" integer NOT NULL DEFAULT (0), "rejected" integer NOT NULL DEFAULT (0), "commandIds" text NOT NULL DEFAULT ('[]'), "log" text NOT NULL DEFAULT ('[]'), "error" text, "approvedById" integer, "approvedByName" varchar, "startedAt" datetime, "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_15e5d105cd67464167e02ea78ce" FOREIGN KEY ("seriesId") REFERENCES "backfill_series" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_15e5d105cd67464167e02ea78c" ON "backfill_job" ("seriesId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_88a3aa9f3ce1768161f8133071" ON "backfill_job" ("status")`
    );
    await queryRunner.query(
      `CREATE TABLE "backfill_candidate" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "seriesId" integer NOT NULL, "guid" text NOT NULL, "title" text NOT NULL, "indexer" varchar NOT NULL, "indexerId" integer NOT NULL DEFAULT (0), "protocol" varchar NOT NULL, "size" bigint NOT NULL DEFAULT (0), "seeders" integer, "publishDate" varchar, "downloadUrl" text, "magnetUrl" text, "infoHash" varchar, "status" varchar NOT NULL DEFAULT ('ready'), "reason" varchar, "plan" text NOT NULL DEFAULT ('[]'), "summary" text, "notifiedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_45af82d2bfedc37a90bab92b9fc" FOREIGN KEY ("seriesId") REFERENCES "backfill_series" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_45af82d2bfedc37a90bab92b9f" ON "backfill_candidate" ("seriesId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_de5eab1fe39ad5461548df8116" ON "backfill_candidate" ("status")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_45af82d2bfedc37a90bab92b9f"`);
    await queryRunner.query(`DROP INDEX "IDX_de5eab1fe39ad5461548df8116"`);
    await queryRunner.query(`DROP TABLE "backfill_candidate"`);
    await queryRunner.query(`DROP INDEX "IDX_15e5d105cd67464167e02ea78c"`);
    await queryRunner.query(`DROP INDEX "IDX_88a3aa9f3ce1768161f8133071"`);
    await queryRunner.query(`DROP TABLE "backfill_job"`);
    await queryRunner.query(`DROP INDEX "IDX_10276285eb5c13a0403d4fa5c4"`);
    await queryRunner.query(`DROP INDEX "IDX_2add2fa335e706edbe4822860a"`);
    await queryRunner.query(`DROP TABLE "backfill_series"`);
  }
}
