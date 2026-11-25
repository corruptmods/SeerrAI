import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Until when an account a different Silo's reset unlinked may be linked
 * again by its Silo name (lib/siloConnect's relinkableBySiloName).
 */
export class AddSiloRelinkUntil1798800000000 implements MigrationInterface {
  name = 'AddSiloRelinkUntil1798800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD "siloRelinkUntil" datetime`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "siloRelinkUntil"`);
  }
}
