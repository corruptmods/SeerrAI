import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBlocklistReason1791100000000 implements MigrationInterface {
  name = 'AddBlocklistReason1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "blocklist" ADD "reason" varchar`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "blocklist" DROP COLUMN "reason"`);
  }
}
