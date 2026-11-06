import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Whether a user's email is confirmed; every existing email counts as such. */
export class AddEmailVerified1797850000000 implements MigrationInterface {
  name = 'AddEmailVerified1797850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD "emailVerified" boolean NOT NULL DEFAULT (1)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "emailVerified"`);
  }
}
