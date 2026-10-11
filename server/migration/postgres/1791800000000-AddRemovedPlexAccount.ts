import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRemovedPlexAccount1791800000000 implements MigrationInterface {
  name = 'AddRemovedPlexAccount1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "removed_plex_account" ("id" SERIAL NOT NULL, "plexId" integer NOT NULL, "removedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_dd5d0d46d158d2959e1bffa15b3" UNIQUE ("plexId"), CONSTRAINT "PK_ebfaa50081e50ae58b5a002851c" PRIMARY KEY ("id"))`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "removed_plex_account"`);
  }
}
