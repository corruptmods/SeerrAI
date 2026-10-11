import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiUsage1791900000000 implements MigrationInterface {
  name = 'AddAiUsage1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_usage" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" integer NOT NULL, "day" varchar(10) NOT NULL, "uses" integer NOT NULL DEFAULT (0), CONSTRAINT "UQ_2e488dc3b6949af3d5b2eeb820e" UNIQUE ("userId", "day"))`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_usage"`);
  }
}
