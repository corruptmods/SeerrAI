import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The single or EP a song asked for is fetched through, when it has one. */
export class AddSongSingle1796300000000 implements MigrationInterface {
  name = 'AddSongSingle1796300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "song_request" ADD "singleMbid" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "song_request" ADD "singleTitle" character varying`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "song_request" DROP COLUMN "singleTitle"`
    );
    await queryRunner.query(
      `ALTER TABLE "song_request" DROP COLUMN "singleMbid"`
    );
  }
}
