import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaForeignTitle1794500000000 implements MigrationInterface {
  name = 'AddMediaForeignTitle1794500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media" ADD COLUMN "foreignTitle" varchar`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "foreignTitle"`);
  }
}
