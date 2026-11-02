import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Changes made from Seerr AI to who sees which library on a media server,
 * for their history and Undo.
 */
export class AddLibraryAccessChanges1797000000000 implements MigrationInterface {
  name = 'AddLibraryAccessChanges1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "library_access_change" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "serverKind" varchar NOT NULL, "action" varchar NOT NULL, "libraryId" varchar, "libraryTitle" varchar, "userId" integer, "entries" text NOT NULL, "undoneAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_69cb1ee4413f40a228769301f6" ON "library_access_change" ("serverKind")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_69cb1ee4413f40a228769301f6"`);
    await queryRunner.query(`DROP TABLE "library_access_change"`);
  }
}
