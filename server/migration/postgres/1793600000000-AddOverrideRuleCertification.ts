import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOverrideRuleCertification1793600000000 implements MigrationInterface {
  name = 'AddOverrideRuleCertification1793600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD "certification" character varying`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" DROP COLUMN "certification"`
    );
  }
}
