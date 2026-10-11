import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationDelivery1789900000000 implements MigrationInterface {
  name = 'AddNotificationDelivery1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "notification_delivery" ("id" SERIAL NOT NULL, "requestId" integer NOT NULL, "type" integer NOT NULL, "sentAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_notification_delivery_request_type" UNIQUE ("requestId", "type"), CONSTRAINT "PK_notification_delivery" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_delivery_requestId" ON "notification_delivery" ("requestId")`
    );

    // Treat every pre-existing completed or failed request as already
    // notified, so enabling the reconciler does not replay historic
    // notifications to users.
    await queryRunner.query(
      `INSERT INTO "notification_delivery" ("requestId", "type") SELECT "id", 8 FROM "media_request" WHERE "status" = 5`
    );
    await queryRunner.query(
      `INSERT INTO "notification_delivery" ("requestId", "type") SELECT "id", 16 FROM "media_request" WHERE "status" = 4`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_notification_delivery_requestId"`);
    await queryRunner.query(`DROP TABLE "notification_delivery"`);
  }
}
