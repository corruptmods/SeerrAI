import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestDeclineReason1793500000000 implements MigrationInterface {
  name = 'AddRequestDeclineReason1793500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "declineReason" character varying`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "declineReason"`
    );
  }
}
