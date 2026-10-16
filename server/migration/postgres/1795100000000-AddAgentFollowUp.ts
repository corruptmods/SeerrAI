import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A failed Backfill download keeps what became of it (the download that
 * replaced it, or why none did) and which admin agent conversation started
 * it. Admin agent runs say what they are for, so approvals waiting on an
 * admin and followed seasons no longer count as the agent's runs of the
 * day; the ones already there are marked from what they remember.
 */
export class AddAgentFollowUp1795100000000 implements MigrationInterface {
  name = 'AddAgentFollowUp1795100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_job" ADD "agentRunId" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_job" ADD "followUp" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_job" ADD "replacedById" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "agent_run" ADD "purpose" character varying NOT NULL DEFAULT 'work'`
    );
    await queryRunner.query(
      `UPDATE "agent_run" SET "purpose" = 'approval' WHERE "trigger" = 'report' AND "memory" LIKE '%"direct":true%'`
    );
    await queryRunner.query(
      `UPDATE "agent_run" SET "purpose" = 'follow' WHERE "trigger" = 'report' AND "memory" LIKE '%"follow":{%'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_run" DROP COLUMN "purpose"`);
    await queryRunner.query(
      `ALTER TABLE "backfill_job" DROP COLUMN "replacedById"`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_job" DROP COLUMN "followUp"`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_job" DROP COLUMN "agentRunId"`
    );
  }
}
