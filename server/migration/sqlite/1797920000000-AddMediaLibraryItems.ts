import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which library on each media server holds a title, for showing people only
 * what their libraries hold. Filled in by the scans.
 */
export class AddMediaLibraryItems1797920000000 implements MigrationInterface {
  name = 'AddMediaLibraryItems1797920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_library_item" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaId" integer NOT NULL, "server" varchar NOT NULL, "libraryId" varchar NOT NULL, "is4k" boolean NOT NULL DEFAULT (0), "itemId" varchar NOT NULL, CONSTRAINT "FK_de4aae4160ca540b9ad8e04186a" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_de4aae4160ca540b9ad8e04186" ON "media_library_item" ("mediaId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_33f1ca133e0689376590685a09" ON "media_library_item" ("server", "libraryId") `
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_b92e1f5c6db4dac871a6fa6983" ON "media_library_item" ("mediaId", "server", "libraryId", "is4k") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_b92e1f5c6db4dac871a6fa6983"`);
    await queryRunner.query(`DROP INDEX "IDX_33f1ca133e0689376590685a09"`);
    await queryRunner.query(`DROP INDEX "IDX_de4aae4160ca540b9ad8e04186"`);
    await queryRunner.query(`DROP TABLE "media_library_item"`);
  }
}
