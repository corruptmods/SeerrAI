import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Resolutions and HDR formats each source saw, filled in by scans. */
export class AddMediaQuality1797930000000 implements MigrationInterface {
  name = 'AddMediaQuality1797930000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "media" ADD "quality" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "quality"`);
  }
}
