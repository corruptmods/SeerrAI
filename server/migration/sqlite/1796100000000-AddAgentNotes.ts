import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the admin agent tried for each title: its searches, the releases it
 * started, and those that failed or were turned down and why, so the next
 * conversation about it starts where the last left off.
 */
export class AddAgentNotes1796100000000 implements MigrationInterface {
  name = 'AddAgentNotes1796100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_series" ADD COLUMN "agentNotes" text NOT NULL DEFAULT ('[]')`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_series" DROP COLUMN "agentNotes"`
    );
  }
}
