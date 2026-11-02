import type { MigrationInterface, QueryRunner } from 'typeorm';

/** How often an album's songs found nothing, and when to look again. */
export class AddSongFetchSearchAgain1797200000000 implements MigrationInterface {
  name = 'AddSongFetchSearchAgain1797200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "song_fetch" ADD COLUMN "searches" integer NOT NULL DEFAULT (0)`
    );
    await queryRunner.query(
      `ALTER TABLE "song_fetch" ADD COLUMN "searchAgainAt" datetime`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "song_fetch" DROP COLUMN "searchAgainAt"`
    );
    await queryRunner.query(`ALTER TABLE "song_fetch" DROP COLUMN "searches"`);
  }
}
