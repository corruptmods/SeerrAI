import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmbyColumns1793400000000 implements MigrationInterface {
  name = 'AddEmbyColumns1793400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media" ADD COLUMN "embyMediaId" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD COLUMN "embyMediaId4k" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "embyUsername" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "embyUserId" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "embyDeviceId" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "embyAuthToken" varchar`
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
