import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Titles an admin chose to follow in Backfill, rather than a scan. */
export class AddBackfillByHand1796700000000 implements MigrationInterface {
  name = 'AddBackfillByHand1796700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_series" ADD COLUMN "byHand" boolean NOT NULL DEFAULT (0)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_series" DROP COLUMN "byHand"`
    );
  }
}
