import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentRuns1792600000000 implements MigrationInterface {
  name = 'AddAgentRuns1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "agent_run" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "trigger" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('queued'), "ask" text, "kind" varchar, "serverId" integer, "arrId" integer, "title" varchar, "summary" text, "steps" text NOT NULL DEFAULT ('[]'), "actions" text NOT NULL DEFAULT ('[]'), "error" text, "question" text, "conversation" text NOT NULL DEFAULT ('[]'), "memory" text NOT NULL DEFAULT ('{}'), "requestedById" integer, "requestedByName" varchar, "inputTokens" integer NOT NULL DEFAULT (0), "outputTokens" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "startedAt" datetime, "finishedAt" datetime)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_429d06fd12be7b9f94e7dacda1" ON "agent_run" ("status") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a2995b9082f3008d7ca6603839" ON "agent_run" ("arrId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_231d020036fd4570ca8fa8860f" ON "agent_run" ("createdAt") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_231d020036fd4570ca8fa8860f"`);
    await queryRunner.query(`DROP INDEX "IDX_a2995b9082f3008d7ca6603839"`);
    await queryRunner.query(`DROP INDEX "IDX_429d06fd12be7b9f94e7dacda1"`);
    await queryRunner.query(`DROP TABLE "agent_run"`);
  }
}
