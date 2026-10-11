import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPlexTokenExpiredAt1791000000000 implements MigrationInterface {
  name = 'AddPlexTokenExpiredAt1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD "plexTokenExpiredAt" datetime`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "plexTokenExpiredAt"`
    );
  }
}
