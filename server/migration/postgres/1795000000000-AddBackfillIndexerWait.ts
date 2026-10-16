import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A Backfill download waiting out its indexer's download limit keeps the
 * wait, so it holds across a restart: since when it has waited, and when
 * the indexer is asked again.
 */
export class AddBackfillIndexerWait1795000000000 implements MigrationInterface {
  name = 'AddBackfillIndexerWait1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_job" ADD "indexerWait" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_job" DROP COLUMN "indexerWait"`
    );
  }
}
