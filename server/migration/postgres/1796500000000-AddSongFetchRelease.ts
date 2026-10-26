import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The release of the album songs are taken into. */
export class AddSongFetchRelease1796500000000 implements MigrationInterface {
  name = 'AddSongFetchRelease1796500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "song_fetch" ADD "lidarrReleaseId" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "song_fetch" DROP COLUMN "lidarrReleaseId"`
    );
  }
}
