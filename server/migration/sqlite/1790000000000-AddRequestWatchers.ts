import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestWatchers1790000000000 implements MigrationInterface {
  name = 'AddRequestWatchers1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_request_watcher" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "requestId" integer NOT NULL, "userId" integer NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_media_request_watcher" UNIQUE ("requestId", "userId"), CONSTRAINT "FK_media_request_watcher_request" FOREIGN KEY ("requestId") REFERENCES "media_request" ("id") ON DELETE CASCADE, CONSTRAINT "FK_media_request_watcher_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_request_watcher_requestId" ON "media_request_watcher" ("requestId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_request_watcher_userId" ON "media_request_watcher" ("userId")`
    );

    // SQLite cannot alter a UNIQUE constraint in place, so rebuild the table.
    await queryRunner.query(
      `CREATE TABLE "notification_delivery_new" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "requestId" integer NOT NULL, "type" integer NOT NULL, "userId" integer NOT NULL DEFAULT (0), "sentAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_notification_delivery_request_type_user" UNIQUE ("requestId", "type", "userId"))`
    );
    await queryRunner.query(
      `INSERT INTO "notification_delivery_new" ("id", "requestId", "type", "userId", "sentAt") SELECT "id", "requestId", "type", 0, "sentAt" FROM "notification_delivery"`
    );
    await queryRunner.query(`DROP INDEX "IDX_notification_delivery_requestId"`);
    await queryRunner.query(`DROP TABLE "notification_delivery"`);
    await queryRunner.query(
      `ALTER TABLE "notification_delivery_new" RENAME TO "notification_delivery"`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_delivery_requestId" ON "notification_delivery" ("requestId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "notification_delivery_old" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "requestId" integer NOT NULL, "type" integer NOT NULL, "sentAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_notification_delivery_request_type" UNIQUE ("requestId", "type"))`
    );
    await queryRunner.query(
      `INSERT OR IGNORE INTO "notification_delivery_old" ("id", "requestId", "type", "sentAt") SELECT "id", "requestId", "type", "sentAt" FROM "notification_delivery" WHERE "userId" = 0`
    );
    await queryRunner.query(`DROP INDEX "IDX_notification_delivery_requestId"`);
    await queryRunner.query(`DROP TABLE "notification_delivery"`);
    await queryRunner.query(
      `ALTER TABLE "notification_delivery_old" RENAME TO "notification_delivery"`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_delivery_requestId" ON "notification_delivery" ("requestId")`
    );
    await queryRunner.query(`DROP TABLE "media_request_watcher"`);
  }
}
