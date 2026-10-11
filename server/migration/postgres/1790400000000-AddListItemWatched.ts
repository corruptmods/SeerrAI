import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListItemWatched1790400000000 implements MigrationInterface {
  name = 'AddListItemWatched1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_item" ADD "watchedAt" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_item" ADD "watchedById" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_item" ADD CONSTRAINT "FK_media_list_item_watched_by" FOREIGN KEY ("watchedById") REFERENCES "user"("id") ON DELETE SET NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_item" DROP CONSTRAINT "FK_media_list_item_watched_by"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_item" DROP COLUMN "watchedById"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_item" DROP COLUMN "watchedAt"`
    );
  }
}
