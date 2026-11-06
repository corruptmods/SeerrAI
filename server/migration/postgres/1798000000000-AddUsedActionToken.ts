import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notification buttons' one-time tokens once used, so a button can't act
 * twice; each kept until it would have expired.
 */
export class AddUsedActionToken1798000000000 implements MigrationInterface {
  name = 'AddUsedActionToken1798000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "used_action_token" ("id" character varying NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_1857ec11dc456f0173ad065a7ff" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1d3dbeb6fd43b7f79f3587b35e" ON "used_action_token" ("expiresAt") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1d3dbeb6fd43b7f79f3587b35e"`
    );
    await queryRunner.query(`DROP TABLE "used_action_token"`);
  }
}
