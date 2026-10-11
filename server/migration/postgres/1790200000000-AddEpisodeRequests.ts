import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodeRequests1790200000000 implements MigrationInterface {
  name = 'AddEpisodeRequests1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "episode_request" ("id" SERIAL NOT NULL, "episodeNumber" integer NOT NULL, "seasonRequestId" integer, CONSTRAINT "UQ_episode_request_season_episode" UNIQUE ("seasonRequestId", "episodeNumber"), CONSTRAINT "PK_episode_request" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_episode_request_seasonRequestId" ON "episode_request" ("seasonRequestId")`
    );
    await queryRunner.query(
      `ALTER TABLE "episode_request" ADD CONSTRAINT "FK_episode_request_season_request" FOREIGN KEY ("seasonRequestId") REFERENCES "season_request"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "episode_request" DROP CONSTRAINT "FK_episode_request_season_request"`
    );
    await queryRunner.query(`DROP INDEX "IDX_episode_request_seasonRequestId"`);
    await queryRunner.query(`DROP TABLE "episode_request"`);
  }
}
