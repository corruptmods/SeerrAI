import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSeriesTypeChoices1792100000000 implements MigrationInterface {
  name = 'AddSeriesTypeChoices1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD "seriesType" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "seriesType" varchar`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "seriesType"`
    );
    await queryRunner.query(
      `ALTER TABLE "override_rule" DROP COLUMN "seriesType"`
    );
  }
}
