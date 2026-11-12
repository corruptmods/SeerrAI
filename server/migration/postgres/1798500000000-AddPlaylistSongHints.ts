import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A song added one at a time: its album and its media server's ids. */
export class AddPlaylistSongHints1798500000000 implements MigrationInterface {
  name = 'AddPlaylistSongHints1798500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_song" ADD "albumTitle" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_song" ADD "sourceMbids" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_song" DROP COLUMN "sourceMbids"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_song" DROP COLUMN "albumTitle"`
    );
  }
}
