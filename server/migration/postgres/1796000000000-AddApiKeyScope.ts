import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What a personal API key may do: everything its owner may (empty), or
 * only Siri's reports ('siri'). Every key made before is the first kind.
 */
export class AddApiKeyScope1796000000000 implements MigrationInterface {
  name = 'AddApiKeyScope1796000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_api_key" ADD "scope" varchar`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_api_key" DROP COLUMN "scope"`);
  }
}
