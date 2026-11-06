import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Discord bot's Approve and Decline messages, by request, so their
 * buttons can be taken away once the request is dealt with elsewhere.
 */
export class AddDiscordApprovalMessage1798100000000 implements MigrationInterface {
  name = 'AddDiscordApprovalMessage1798100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "discord_approval_message" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "requestId" integer NOT NULL, "channelId" varchar NOT NULL, "messageId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_dcedbc1269ddff5360a82ebae8a" FOREIGN KEY ("requestId") REFERENCES "media_request" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dcedbc1269ddff5360a82ebae8" ON "discord_approval_message" ("requestId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_dcedbc1269ddff5360a82ebae8"`);
    await queryRunner.query(`DROP TABLE "discord_approval_message"`);
  }
}
