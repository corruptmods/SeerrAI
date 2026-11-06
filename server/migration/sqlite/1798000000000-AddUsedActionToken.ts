import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notification buttons' one-time tokens once used, so a button can't act
 * twice; each kept until it would have expired.
 */
export class AddUsedActionToken1798000000000 implements MigrationInterface {
  name = 'AddUsedActionToken1798000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "used_action_token" ("id" varchar PRIMARY KEY NOT NULL, "expiresAt" datetime NOT NULL)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1d3dbeb6fd43b7f79f3587b35e" ON "used_action_token" ("expiresAt") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_1d3dbeb6fd43b7f79f3587b35e"`);
    await queryRunner.query(`DROP TABLE "used_action_token"`);
  }
}
