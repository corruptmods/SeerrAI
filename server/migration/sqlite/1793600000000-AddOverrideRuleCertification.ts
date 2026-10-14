import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * A plain added column: the table keeps every other column, the fork's
 * seriesType among them, as it is.
 */
export class AddOverrideRuleCertification1793600000000 implements MigrationInterface {
  name = 'AddOverrideRuleCertification1793600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD COLUMN "certification" varchar`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" DROP COLUMN "certification"`
    );
  }
}
