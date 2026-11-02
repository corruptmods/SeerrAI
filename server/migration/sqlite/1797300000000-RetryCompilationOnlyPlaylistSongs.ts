import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Playlist songs matched to a version only on others' compilations
 * couldn't be requested, though the artist's own album or single had the
 * song. Matching now picks a version that can be requested; those songs
 * are matched again.
 */
export class RetryCompilationOnlyPlaylistSongs1797300000000 implements MigrationInterface {
  name = 'RetryCompilationOnlyPlaylistSongs1797300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "media_list_song" SET "state" = 'matching', "problem" = NULL WHERE "state" = 'failed' AND "problem" LIKE '%only on compilations%'`
    );
  }

  public async down(): Promise<void> {
    // Nothing to put back: they are matched again.
  }
}
