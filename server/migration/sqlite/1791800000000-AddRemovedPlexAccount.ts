import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRemovedPlexAccount1791800000000 implements MigrationInterface {
  name = 'AddRemovedPlexAccount1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "removed_plex_account" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "plexId" integer NOT NULL, "removedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_dd5d0d46d158d2959e1bffa15b3" UNIQUE ("plexId"))`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "removed_plex_account"`);
  }
}
