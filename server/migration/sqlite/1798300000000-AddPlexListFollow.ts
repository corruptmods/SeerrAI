import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plex lists with auto-request on, by person, and the titles on each already
 * dealt with.
 */
export class AddPlexListFollow1798300000000 implements MigrationInterface {
  name = 'AddPlexListFollow1798300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "plex_list_follow" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" integer NOT NULL, "plexListId" varchar NOT NULL, "owner" varchar NOT NULL, "slug" varchar NOT NULL, "handled" text NOT NULL, "checkedAt" datetime, "problem" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_719e70064bfa804634b3172b0c5" UNIQUE ("userId", "plexListId"), CONSTRAINT "FK_5af4350b2e97731578aa4382c7f" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5af4350b2e97731578aa4382c7" ON "plex_list_follow" ("userId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_5af4350b2e97731578aa4382c7"`);
    await queryRunner.query(`DROP TABLE "plex_list_follow"`);
  }
}
