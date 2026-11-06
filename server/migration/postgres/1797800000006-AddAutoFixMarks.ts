import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Auto-fix's daily allowances and recent fixes, kept across restarts. */
export class AddAutoFixMarks1797800000006 implements MigrationInterface {
  name = 'AddAutoFixMarks1797800000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "auto_fix_mark" ("id" SERIAL NOT NULL, "key" character varying NOT NULL, "count" integer NOT NULL DEFAULT '0', "at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_32db498b299904e7762165b7d33" UNIQUE ("key"), CONSTRAINT "PK_a06f5cfc92e0e06d4398d0e5f4f" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_47e69c2e43d069b3b9c9fbdc47" ON "auto_fix_mark" ("at") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_47e69c2e43d069b3b9c9fbdc47"`
    );
    await queryRunner.query(`DROP TABLE "auto_fix_mark"`);
  }
}
