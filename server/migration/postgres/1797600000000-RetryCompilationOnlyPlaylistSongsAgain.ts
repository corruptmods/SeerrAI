import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Playlist songs matched by their ISRC to a recording MusicBrainz has only
 * on others' compilations couldn't be requested, though the artist's own
 * single or album had the song. Matching now takes the artist's own
 * recording, as long as the playlist's, in its place; those songs are
 * matched again.
 */
export class RetryCompilationOnlyPlaylistSongsAgain1797600000000 implements MigrationInterface {
  name = 'RetryCompilationOnlyPlaylistSongsAgain1797600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "media_list_song" SET "state" = 'matching', "problem" = NULL WHERE "state" = 'failed' AND "problem" LIKE '%only on compilations%'`
    );
  }

  public async down(): Promise<void> {
    // Nothing to put back: they are matched again.
  }
}
