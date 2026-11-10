import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plex lists with auto-request on, by person, and the titles on each already
 * dealt with.
 */
export class AddPlexListFollow1798300000000 implements MigrationInterface {
  name = 'AddPlexListFollow1798300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "plex_list_follow" ("id" SERIAL NOT NULL, "userId" integer NOT NULL, "plexListId" character varying NOT NULL, "owner" character varying NOT NULL, "slug" character varying NOT NULL, "handled" text NOT NULL, "checkedAt" TIMESTAMP WITH TIME ZONE, "problem" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_719e70064bfa804634b3172b0c5" UNIQUE ("userId", "plexListId"), CONSTRAINT "PK_247af3e317ed7facfb60631498c" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5af4350b2e97731578aa4382c7" ON "plex_list_follow" ("userId") `
    );
    await queryRunner.query(
      `ALTER TABLE "plex_list_follow" ADD CONSTRAINT "FK_5af4350b2e97731578aa4382c7f" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "plex_list_follow" DROP CONSTRAINT "FK_5af4350b2e97731578aa4382c7f"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5af4350b2e97731578aa4382c7"`
    );
    await queryRunner.query(`DROP TABLE "plex_list_follow"`);
  }
}
