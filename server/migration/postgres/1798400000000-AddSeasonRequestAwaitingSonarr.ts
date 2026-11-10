import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A requested season sent before Sonarr listed it. */
export class AddSeasonRequestAwaitingSonarr1798400000000 implements MigrationInterface {
  name = 'AddSeasonRequestAwaitingSonarr1798400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "season_request" ADD "awaitingSonarr" boolean NOT NULL DEFAULT false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "season_request" DROP COLUMN "awaitingSonarr"`
    );
  }
}
