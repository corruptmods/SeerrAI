import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Download Check's findings: each download it found something wrong with,
 * before it came down or once its import got stuck, and what it did.
 */
export class AddDownloadCheck1795900000000 implements MigrationInterface {
  name = 'AddDownloadCheck1795900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "download_check" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "app" varchar NOT NULL, "serverId" integer NOT NULL, "downloadKey" varchar NOT NULL, "stage" varchar NOT NULL, "title" varchar NOT NULL, "itemId" integer NOT NULL, "itemTitle" varchar NOT NULL, "episodes" varchar NOT NULL DEFAULT (''), "poster" varchar, "finding" varchar NOT NULL, "action" varchar NOT NULL, "status" varchar NOT NULL, "params" text NOT NULL DEFAULT ('{}'), "detail" text NOT NULL DEFAULT (''), "error" text, "createdAt" datetime NOT NULL, "updatedAt" datetime NOT NULL, CONSTRAINT "UQ_ca57edcb3aa6f1deda0b5c4b4e0" UNIQUE ("app", "serverId", "downloadKey", "stage"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_abe7134edf67f04e3172c823a6" ON "download_check" ("status") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_19268be6bd0ccb66f2814bb36e" ON "download_check" ("createdAt") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_19268be6bd0ccb66f2814bb36e"`);
    await queryRunner.query(`DROP INDEX "IDX_abe7134edf67f04e3172c823a6"`);
    await queryRunner.query(`DROP TABLE "download_check"`);
  }
}
