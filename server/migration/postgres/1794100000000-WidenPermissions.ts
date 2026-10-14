import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Permissions past 2^31 (Auto-Approve Music is 2^31 itself) do not fit an
 * integer. Changed in place, so every account keeps its permissions.
 */
export class WidenPermissions1794100000000 implements MigrationInterface {
  name = 'WidenPermissions1794100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ALTER COLUMN "permissions" TYPE bigint`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Bits past an integer cannot come back with it: they are dropped.
    await queryRunner.query(
      `UPDATE "user" SET "permissions" = "permissions" % 2147483648`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ALTER COLUMN "permissions" TYPE integer`
    );
  }
}
