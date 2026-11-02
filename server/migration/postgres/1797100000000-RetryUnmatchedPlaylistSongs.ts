import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Playlist songs whose title had a part in brackets ("Song (Tide Me Over)",
 * "Song [Remix]") were never matched, however well MusicBrainz knew them.
 * Matching now reads such titles; those songs are looked for again.
 */
export class RetryUnmatchedPlaylistSongs1797100000000 implements MigrationInterface {
  name = 'RetryUnmatchedPlaylistSongs1797100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "media_list_song" SET "state" = 'matching' WHERE "state" = 'unmatched'`
    );
  }

  public async down(): Promise<void> {
    // Nothing to put back: they are matched or found unknown again.
  }
}
