import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Auto-fix's daily allowances and recent fixes, kept across restarts. */
export class AddAutoFixMarks1797800000006 implements MigrationInterface {
  name = 'AddAutoFixMarks1797800000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "auto_fix_mark" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "key" varchar NOT NULL, "count" integer NOT NULL DEFAULT (0), "at" datetime NOT NULL, CONSTRAINT "UQ_32db498b299904e7762165b7d33" UNIQUE ("key"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_47e69c2e43d069b3b9c9fbdc47" ON "auto_fix_mark" ("at") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_47e69c2e43d069b3b9c9fbdc47"`);
    await queryRunner.query(`DROP TABLE "auto_fix_mark"`);
  }
}
