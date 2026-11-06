import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Production countries as an override rule condition; none on existing rules. */
export class AddOverrideRuleCountry1797900000000 implements MigrationInterface {
  name = 'AddOverrideRuleCountry1797900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD "country" character varying`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" DROP COLUMN "country"`
    );
  }
}
