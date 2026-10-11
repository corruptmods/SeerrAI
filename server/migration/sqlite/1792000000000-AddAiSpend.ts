import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiSpend1792000000000 implements MigrationInterface {
  name = 'AddAiSpend1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_spend" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "day" varchar(10) NOT NULL, "model" varchar(200) NOT NULL, "requests" integer NOT NULL DEFAULT (0), "inputTokens" integer NOT NULL DEFAULT (0), "outputTokens" integer NOT NULL DEFAULT (0), CONSTRAINT "UQ_ffacb3e3e9cc949f927dbf93f69" UNIQUE ("day", "model"))`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_spend"`);
  }
}
