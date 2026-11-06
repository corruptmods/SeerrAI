import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Requests made over the requester's quota; none so far. */
export class AddRequestOverQuota1797900000001 implements MigrationInterface {
  name = 'AddRequestOverQuota1797900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "overQuota" boolean NOT NULL DEFAULT (0)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "overQuota"`
    );
  }
}
