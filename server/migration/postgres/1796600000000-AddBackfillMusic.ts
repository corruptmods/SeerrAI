import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Albums in Backfill: the album's MusicBrainz id and its artist. */
export class AddBackfillMusic1796600000000 implements MigrationInterface {
  name = 'AddBackfillMusic1796600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_series" ADD "foreignId" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_series" ADD "artistName" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_series" ADD "artistArrId" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backfill_series" DROP COLUMN "artistArrId"`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_series" DROP COLUMN "artistName"`
    );
    await queryRunner.query(
      `ALTER TABLE "backfill_series" DROP COLUMN "foreignId"`
    );
  }
}
