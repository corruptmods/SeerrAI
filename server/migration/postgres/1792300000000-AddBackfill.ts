import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBackfill1792300000000 implements MigrationInterface {
  name = 'AddBackfill1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "backfill_job" ("id" SERIAL NOT NULL, "seriesId" integer NOT NULL, "candidateId" integer, "title" text NOT NULL, "status" character varying NOT NULL DEFAULT 'queued', "mode" character varying NOT NULL DEFAULT 'missing', "protocol" character varying NOT NULL, "clientId" integer NOT NULL, "stage" character varying, "downloadId" character varying, "files" text NOT NULL DEFAULT '[]', "progress" integer NOT NULL DEFAULT '0', "size" bigint NOT NULL DEFAULT '0', "sizeLeft" bigint NOT NULL DEFAULT '0', "speed" integer NOT NULL DEFAULT '0', "secondsLeft" integer, "imported" integer NOT NULL DEFAULT '0', "replaced" integer NOT NULL DEFAULT '0', "rejected" integer NOT NULL DEFAULT '0', "commandIds" text NOT NULL DEFAULT '[]', "log" text NOT NULL DEFAULT '[]', "error" text, "approvedById" integer, "approvedByName" character varying, "startedAt" TIMESTAMP WITH TIME ZONE, "finishedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_decb91d71ea643de5a03bc3af40" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_15e5d105cd67464167e02ea78c" ON "backfill_job" ("seriesId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_88a3aa9f3ce1768161f8133071" ON "backfill_job" ("status")`
    );
    await queryRunner.query(
      `CREATE TABLE "backfill_series" ("id" SERIAL NOT NULL, "serverId" integer NOT NULL, "sonarrSeriesId" integer NOT NULL, "tvdbId" integer, "tmdbId" integer, "title" character varying NOT NULL, "year" integer, "seriesType" character varying NOT NULL DEFAULT 'standard', "poster" character varying, "status" character varying NOT NULL DEFAULT 'stuck', "missing" integer NOT NULL DEFAULT '0', "belowCutoff" integer NOT NULL DEFAULT '0', "searchTerms" text NOT NULL DEFAULT '[]', "lastSonarrSearchAt" TIMESTAMP WITH TIME ZONE, "lastSearchedAt" TIMESTAMP WITH TIME ZONE, "searchError" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_6b14297daa3a5e0161dc08768ad" UNIQUE ("serverId", "sonarrSeriesId"), CONSTRAINT "PK_30cc7bdc4e5da23b752d09111a4" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_10276285eb5c13a0403d4fa5c4" ON "backfill_series" ("sonarrSeriesId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2add2fa335e706edbe4822860a" ON "backfill_series" ("status")`
    );
    await queryRunner.query(
      `CREATE TABLE "backfill_candidate" ("id" SERIAL NOT NULL, "seriesId" integer NOT NULL, "guid" text NOT NULL, "title" text NOT NULL, "indexer" character varying NOT NULL, "indexerId" integer NOT NULL DEFAULT '0', "protocol" character varying NOT NULL, "size" bigint NOT NULL DEFAULT '0', "seeders" integer, "publishDate" character varying, "downloadUrl" text, "magnetUrl" text, "infoHash" character varying, "status" character varying NOT NULL DEFAULT 'ready', "reason" character varying, "plan" text NOT NULL DEFAULT '[]', "summary" text, "notifiedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_3a1348e448173c58b8d7084a9a7" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_45af82d2bfedc37a90bab92b9f" ON "backfill_candidate" ("seriesId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_de5eab1fe39ad5461548df8116" ON "backfill_candidate" ("status")`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_job" ADD CONSTRAINT "FK_15e5d105cd67464167e02ea78ce" FOREIGN KEY ("seriesId") REFERENCES "backfill_series"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_candidate" ADD CONSTRAINT "FK_45af82d2bfedc37a90bab92b9fc" FOREIGN KEY ("seriesId") REFERENCES "backfill_series"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_candidate" DROP CONSTRAINT "FK_45af82d2bfedc37a90bab92b9fc"`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_job" DROP CONSTRAINT "FK_15e5d105cd67464167e02ea78ce"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_de5eab1fe39ad5461548df8116"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_45af82d2bfedc37a90bab92b9f"`
    );
    await queryRunner.query(`DROP TABLE "backfill_candidate"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_2add2fa335e706edbe4822860a"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_10276285eb5c13a0403d4fa5c4"`
    );
    await queryRunner.query(`DROP TABLE "backfill_series"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_88a3aa9f3ce1768161f8133071"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_15e5d105cd67464167e02ea78c"`
    );
    await queryRunner.query(`DROP TABLE "backfill_job"`);
  }
}
