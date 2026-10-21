import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Download Check's findings: each download it found something wrong with,
 * before it came down or once its import got stuck, and what it did.
 */
export class AddDownloadCheck1795900000000 implements MigrationInterface {
  name = 'AddDownloadCheck1795900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "download_check" ("id" SERIAL NOT NULL, "app" character varying NOT NULL, "serverId" integer NOT NULL, "downloadKey" character varying NOT NULL, "stage" character varying NOT NULL, "title" character varying NOT NULL, "itemId" integer NOT NULL, "itemTitle" character varying NOT NULL, "episodes" character varying NOT NULL DEFAULT '', "poster" character varying, "finding" character varying NOT NULL, "action" character varying NOT NULL, "status" character varying NOT NULL, "params" text NOT NULL DEFAULT '{}', "detail" text NOT NULL DEFAULT '', "error" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_ca57edcb3aa6f1deda0b5c4b4e0" UNIQUE ("app", "serverId", "downloadKey", "stage"), CONSTRAINT "PK_5f449d73fa750892dcd2bae1710" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_abe7134edf67f04e3172c823a6" ON "download_check" ("status") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_19268be6bd0ccb66f2814bb36e" ON "download_check" ("createdAt") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_19268be6bd0ccb66f2814bb36e"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_abe7134edf67f04e3172c823a6"`
    );
    await queryRunner.query(`DROP TABLE "download_check"`);
  }
}
