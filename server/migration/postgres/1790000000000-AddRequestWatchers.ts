import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestWatchers1790000000000 implements MigrationInterface {
  name = 'AddRequestWatchers1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_request_watcher" ("id" SERIAL NOT NULL, "requestId" integer NOT NULL, "userId" integer NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_media_request_watcher" UNIQUE ("requestId", "userId"), CONSTRAINT "PK_media_request_watcher" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_request_watcher_requestId" ON "media_request_watcher" ("requestId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_request_watcher_userId" ON "media_request_watcher" ("userId")`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request_watcher" ADD CONSTRAINT "FK_media_request_watcher_request" FOREIGN KEY ("requestId") REFERENCES "media_request"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request_watcher" ADD CONSTRAINT "FK_media_request_watcher_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE`
    );

    // Deliveries become per-recipient: 0 means the original requester.
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" ADD "userId" integer NOT NULL DEFAULT 0`
    );
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" DROP CONSTRAINT "UQ_notification_delivery_request_type"`
    );
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" ADD CONSTRAINT "UQ_notification_delivery_request_type_user" UNIQUE ("requestId", "type", "userId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" DROP CONSTRAINT "UQ_notification_delivery_request_type_user"`
    );
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" ADD CONSTRAINT "UQ_notification_delivery_request_type" UNIQUE ("requestId", "type")`
    );
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" DROP COLUMN "userId"`
    );
    await queryRunner.query(`DROP TABLE "media_request_watcher"`);
  }
}
