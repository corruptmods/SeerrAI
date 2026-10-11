import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AgentAutoRun1792700000000 implements MigrationInterface {
  name = 'AgentAutoRun1792700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_series" ADD COLUMN "agentAutoRunAt" datetime`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_series" DROP COLUMN "agentAutoRunAt"`
    );
  }
}
