import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Discord bot's Approve and Decline messages, by request, so their
 * buttons can be taken away once the request is dealt with elsewhere.
 */
export class AddDiscordApprovalMessage1798100000000 implements MigrationInterface {
  name = 'AddDiscordApprovalMessage1798100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "discord_approval_message" ("id" SERIAL NOT NULL, "requestId" integer NOT NULL, "channelId" character varying NOT NULL, "messageId" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_de61afe1bc2b59e8f7e19789cca" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dcedbc1269ddff5360a82ebae8" ON "discord_approval_message" ("requestId") `
    );
    await queryRunner.query(
      `ALTER TABLE "discord_approval_message" ADD CONSTRAINT "FK_dcedbc1269ddff5360a82ebae8a" FOREIGN KEY ("requestId") REFERENCES "media_request"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "discord_approval_message" DROP CONSTRAINT "FK_dcedbc1269ddff5360a82ebae8a"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_dcedbc1269ddff5360a82ebae8"`
    );
    await queryRunner.query(`DROP TABLE "discord_approval_message"`);
  }
}
