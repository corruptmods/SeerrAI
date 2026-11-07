import type { MigrationInterface, QueryRunner } from 'typeorm';

/** When Backfill's own search last went through the title's *arr. */
export class AddBackfillOwnArrSearch1798200000000 implements MigrationInterface {
  name = 'AddBackfillOwnArrSearch1798200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_series" ADD "ownArrSearch" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_series" DROP COLUMN "ownArrSearch"`
    );
  }
}
