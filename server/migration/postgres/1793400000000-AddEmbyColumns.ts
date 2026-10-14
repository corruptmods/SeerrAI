import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmbyColumns1793400000000 implements MigrationInterface {
  name = 'AddEmbyColumns1793400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media" ADD "embyMediaId" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD "embyMediaId4k" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "embyUsername" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "embyUserId" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "embyDeviceId" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "embyAuthToken" character varying`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "embyAuthToken"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "embyDeviceId"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "embyUserId"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "embyUsername"`);
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "embyMediaId4k"`);
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "embyMediaId"`);
  }
}
