import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodeRequests1790200000000 implements MigrationInterface {
  name = 'AddEpisodeRequests1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "episode_request" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "episodeNumber" integer NOT NULL, "seasonRequestId" integer, CONSTRAINT "UQ_episode_request_season_episode" UNIQUE ("seasonRequestId", "episodeNumber"), CONSTRAINT "FK_episode_request_season_request" FOREIGN KEY ("seasonRequestId") REFERENCES "season_request" ("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_episode_request_seasonRequestId" ON "episode_request" ("seasonRequestId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_episode_request_seasonRequestId"`);
    await queryRunner.query(`DROP TABLE "episode_request"`);
  }
}
