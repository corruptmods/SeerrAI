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
      `CREATE TABLE "quality_apply" ("id" SERIAL NOT NULL, "serverKind" character varying NOT NULL, "serverId" integer NOT NULL, "userId" integer, "summary" text NOT NULL, "befores" text NOT NULL, "moved" text NOT NULL DEFAULT '[]', "undoneAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e030a12f9ca14db0314f1955027" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fc690c1bad0c08ba24931f8cd5" ON "quality_apply" ("serverKind")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7829c431cd8a897c050e195cc0" ON "quality_apply" ("serverId")`
    );
    await queryRunner.query(
      `CREATE TABLE "quality_grab_note" ("id" SERIAL NOT NULL, "serverKind" character varying NOT NULL, "serverId" integer NOT NULL, "title" character varying NOT NULL, "protocol" character varying, "wonTie" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_59723bcb5c27ec0b4e2e543cc44" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e009f937d11ba187b10e2d1388" ON "quality_grab_note" ("title")`
    );
    await queryRunner.query(
      `CREATE TABLE "quality_managed" ("id" SERIAL NOT NULL, "serverKind" character varying NOT NULL, "serverId" integer NOT NULL, "itemKind" character varying NOT NULL, "key" character varying NOT NULL, "arrId" integer NOT NULL, "fingerprint" character varying NOT NULL, "keptAsEdited" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UNIQUE_QUALITY_MANAGED" UNIQUE ("serverKind", "serverId", "itemKind", "key"), CONSTRAINT "PK_ae601ac91e8fba78e455edca407" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d93edaed20db413e854c22b671" ON "quality_managed" ("serverId")`
    );
    await queryRunner.query(
      `CREATE TABLE "quality_step_down" ("id" SERIAL NOT NULL, "serverKind" character varying NOT NULL, "serverId" integer NOT NULL, "arrId" integer NOT NULL, "title" character varying NOT NULL, "fromProfileId" integer NOT NULL, "toProfileId" integer NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UNIQUE_QUALITY_STEP_DOWN" UNIQUE ("serverKind", "serverId", "arrId"), CONSTRAINT "PK_bc04ffcecbcee875de8dcf06f64" PRIMARY KEY ("id"))`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_d93edaed20db413e854c22b671"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e009f937d11ba187b10e2d1388"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7829c431cd8a897c050e195cc0"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_fc690c1bad0c08ba24931f8cd5"`
    );
    await queryRunner.query(`DROP TABLE "quality_step_down"`);
    await queryRunner.query(`DROP TABLE "quality_managed"`);
    await queryRunner.query(`DROP TABLE "quality_grab_note"`);
    await queryRunner.query(`DROP TABLE "quality_apply"`);
  }
}
