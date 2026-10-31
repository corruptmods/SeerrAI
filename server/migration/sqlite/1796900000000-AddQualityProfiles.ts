import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quality profiles (Settings → Quality): what Seerr AI created in each
 * Radarr and Sonarr, each apply for History and Undo, notes on grabs Seerr
 * AI made itself, and titles Backfill's step-down moved.
 */
export class AddQualityProfiles1796900000000 implements MigrationInterface {
  name = 'AddQualityProfiles1796900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "quality_apply" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "serverKind" varchar NOT NULL, "serverId" integer NOT NULL, "userId" integer, "summary" text NOT NULL, "befores" text NOT NULL, "moved" text NOT NULL DEFAULT ('[]'), "undoneAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fc690c1bad0c08ba24931f8cd5" ON "quality_apply" ("serverKind")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7829c431cd8a897c050e195cc0" ON "quality_apply" ("serverId")`
    );
    await queryRunner.query(
      `CREATE TABLE "quality_grab_note" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "serverKind" varchar NOT NULL, "serverId" integer NOT NULL, "title" varchar NOT NULL, "protocol" varchar, "wonTie" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e009f937d11ba187b10e2d1388" ON "quality_grab_note" ("title")`
    );
    await queryRunner.query(
      `CREATE TABLE "quality_managed" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "serverKind" varchar NOT NULL, "serverId" integer NOT NULL, "itemKind" varchar NOT NULL, "key" varchar NOT NULL, "arrId" integer NOT NULL, "fingerprint" varchar NOT NULL, "keptAsEdited" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UNIQUE_QUALITY_MANAGED" UNIQUE ("serverKind", "serverId", "itemKind", "key"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d93edaed20db413e854c22b671" ON "quality_managed" ("serverId")`
    );
    await queryRunner.query(
      `CREATE TABLE "quality_step_down" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "serverKind" varchar NOT NULL, "serverId" integer NOT NULL, "arrId" integer NOT NULL, "title" varchar NOT NULL, "fromProfileId" integer NOT NULL, "toProfileId" integer NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UNIQUE_QUALITY_STEP_DOWN" UNIQUE ("serverKind", "serverId", "arrId"))`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_d93edaed20db413e854c22b671"`);
    await queryRunner.query(`DROP INDEX "IDX_e009f937d11ba187b10e2d1388"`);
    await queryRunner.query(`DROP INDEX "IDX_7829c431cd8a897c050e195cc0"`);
    await queryRunner.query(`DROP INDEX "IDX_fc690c1bad0c08ba24931f8cd5"`);
    await queryRunner.query(`DROP TABLE "quality_step_down"`);
    await queryRunner.query(`DROP TABLE "quality_managed"`);
    await queryRunner.query(`DROP TABLE "quality_grab_note"`);
    await queryRunner.query(`DROP TABLE "quality_apply"`);
  }
}
