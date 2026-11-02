import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Taking songs from albums now tries Usenet before torrents nobody shares,
 * so albums waiting to be searched again are searched now.
 */
export class SearchWaitingSongFetchesAgain1797400000000 implements MigrationInterface {
  name = 'SearchWaitingSongFetchesAgain1797400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "song_fetch" SET "searchAgainAt" = NULL WHERE "status" = 'searching' AND "searchAgainAt" IS NOT NULL`
    );
  }

  public async down(): Promise<void> {
    // Nothing to put back: they are searched again.
  }
}
