import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListMemberAccepted1793200000000 implements MigrationInterface {
  name = 'AddListMemberAccepted1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_member" ADD "acceptedAt" TIMESTAMP WITH TIME ZONE`
    );
    // People already on a list keep everything working as it did: they are
    // counted as having accepted it. Only lists shared from now on wait.
    await queryRunner.query(
      `UPDATE "media_list_member" SET "acceptedAt" = now()`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_member" DROP COLUMN "acceptedAt"`
    );
  }
}
