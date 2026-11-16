import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Whether a user may import Spotify and Apple Music playlists. */
export class AddUserPlaylistLink1798600000000 implements MigrationInterface {
  name = 'AddUserPlaylistLink1798600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "playlistLink" boolean NOT NULL DEFAULT (1)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "playlistLink"`);
  }
}
