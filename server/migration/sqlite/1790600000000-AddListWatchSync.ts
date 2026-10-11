import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListWatchSync1790600000000 implements MigrationInterface {
  name = 'AddListWatchSync1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD "watchedSync" boolean NOT NULL DEFAULT (0)`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD "lastWatchCheck" datetime`
    );
    await queryRunner.query(
      `CREATE TABLE "media_list_watch_suggestion" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "listId" integer NOT NULL, "itemId" integer NOT NULL, "dismissedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_media_list_watch_suggestion_item" UNIQUE ("itemId"), CONSTRAINT "FK_mlws_list" FOREIGN KEY ("listId") REFERENCES "media_list" ("id") ON DELETE CASCADE, CONSTRAINT "FK_mlws_item" FOREIGN KEY ("itemId") REFERENCES "media_list_item" ("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_list_watch_suggestion_listId" ON "media_list_watch_suggestion" ("listId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "media_list_watch_suggestion"`);
    await queryRunner.query(
      `ALTER TABLE "media_list" DROP COLUMN "lastWatchCheck"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list" DROP COLUMN "watchedSync"`
    );
  }
}
