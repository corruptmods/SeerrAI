import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListItemWatched1790400000000 implements MigrationInterface {
  name = 'AddListItemWatched1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_item" ADD "watchedAt" datetime`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_item" ADD "watchedById" integer REFERENCES "user" ("id") ON DELETE SET NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_item" DROP COLUMN "watchedById"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_item" DROP COLUMN "watchedAt"`
    );
  }
}
