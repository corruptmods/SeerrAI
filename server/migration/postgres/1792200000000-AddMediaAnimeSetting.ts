import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaAnimeSetting1792200000000 implements MigrationInterface {
  name = 'AddMediaAnimeSetting1792200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "media" ADD "animeSetting" boolean`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "animeSetting"`);
  }
}
