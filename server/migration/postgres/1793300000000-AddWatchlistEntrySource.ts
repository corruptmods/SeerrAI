import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWatchlistEntrySource1793300000000 implements MigrationInterface {
  name = 'AddWatchlistEntrySource1793300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "watchlist_sync_entry" ADD "watchlistedFrom" varchar`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "watchlist_sync_entry" DROP COLUMN "watchlistedFrom"`
    );
  }
}
