import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodeDeliveryKey1790100000000 implements MigrationInterface {
  name = 'AddEpisodeDeliveryKey1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // SQLite cannot alter a UNIQUE constraint in place, so rebuild the table.
    await queryRunner.query(
      `CREATE TABLE "notification_delivery_new" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "requestId" integer NOT NULL, "type" integer NOT NULL, "userId" integer NOT NULL DEFAULT (0), "episodeKey" varchar NOT NULL DEFAULT (''), "sentAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_notification_delivery_request_type_user_episode" UNIQUE ("requestId", "type", "userId", "episodeKey"))`
    );
    await queryRunner.query(
      `INSERT INTO "notification_delivery_new" ("id", "requestId", "type", "userId", "episodeKey", "sentAt") SELECT "id", "requestId", "type", "userId", '', "sentAt" FROM "notification_delivery"`
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
      `CREATE TABLE "notification_delivery_old" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "requestId" integer NOT NULL, "type" integer NOT NULL, "userId" integer NOT NULL DEFAULT (0), "sentAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_notification_delivery_request_type_user" UNIQUE ("requestId", "type", "userId"))`
    );
    await queryRunner.query(
      `INSERT OR IGNORE INTO "notification_delivery_old" ("id", "requestId", "type", "userId", "sentAt") SELECT "id", "requestId", "type", "userId", "sentAt" FROM "notification_delivery" WHERE "episodeKey" = ''`
    );
    await queryRunner.query(`DROP INDEX "IDX_notification_delivery_requestId"`);
    await queryRunner.query(`DROP TABLE "notification_delivery"`);
    await queryRunner.query(
      `ALTER TABLE "notification_delivery_old" RENAME TO "notification_delivery"`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_delivery_requestId" ON "notification_delivery" ("requestId")`
    );
  }
}
