import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodeDeliveryKey1790100000000 implements MigrationInterface {
  name = 'AddEpisodeDeliveryKey1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" ADD "episodeKey" character varying NOT NULL DEFAULT ''`
    );
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" DROP CONSTRAINT "UQ_notification_delivery_request_type_user"`
    );
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" ADD CONSTRAINT "UQ_notification_delivery_request_type_user_episode" UNIQUE ("requestId", "type", "userId", "episodeKey")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "notification_delivery" WHERE "episodeKey" <> ''`
    );
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" DROP CONSTRAINT "UQ_notification_delivery_request_type_user_episode"`
    );
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" ADD CONSTRAINT "UQ_notification_delivery_request_type_user" UNIQUE ("requestId", "type", "userId")`
    );
    await queryRunner.query(
      `ALTER TABLE "notification_delivery" DROP COLUMN "episodeKey"`
    );
  }
}
