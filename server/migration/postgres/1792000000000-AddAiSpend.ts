import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiSpend1792000000000 implements MigrationInterface {
  name = 'AddAiSpend1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_spend" ("id" SERIAL NOT NULL, "day" character varying(10) NOT NULL, "model" character varying(200) NOT NULL, "requests" integer NOT NULL DEFAULT '0', "inputTokens" integer NOT NULL DEFAULT '0', "outputTokens" integer NOT NULL DEFAULT '0', CONSTRAINT "UQ_ffacb3e3e9cc949f927dbf93f69" UNIQUE ("day", "model"), CONSTRAINT "PK_7fb7a4ef4d152845c219450f338" PRIMARY KEY ("id"))`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_spend"`);
  }
}
