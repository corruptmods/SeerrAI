import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A playlist song's ISRC and its listing on Deezer. Songs MusicBrainz
 * didn't know are looked up again now, by their ISRC where MusicBrainz
 * has it, rather than in up to a week.
 */
export class AddPlaylistSongCatalog1797500000000 implements MigrationInterface {
  name = 'AddPlaylistSongCatalog1797500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_song" ADD COLUMN "isrc" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_song" ADD COLUMN "catalog" text`
    );
    await queryRunner.query(
      `UPDATE "media_list_song" SET "state" = 'matching' WHERE "state" = 'unmatched'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_song" DROP COLUMN "catalog"`
    );
    await queryRunner.query(`ALTER TABLE "media_list_song" DROP COLUMN "isrc"`);
  }
}
