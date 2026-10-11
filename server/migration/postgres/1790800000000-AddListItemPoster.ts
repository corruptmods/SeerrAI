import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListItemPoster1790800000000 implements MigrationInterface {
  name = 'AddListItemPoster1790800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_item" ADD "posterPath" varchar`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list_item" DROP COLUMN "posterPath"`
    );
  }
}
