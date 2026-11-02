import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Changes made from Seerr AI to who sees which library on a media server,
 * for their history and Undo.
 */
export class AddLibraryAccessChanges1797000000000 implements MigrationInterface {
  name = 'AddLibraryAccessChanges1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "library_access_change" ("id" SERIAL NOT NULL, "serverKind" character varying NOT NULL, "action" character varying NOT NULL, "libraryId" character varying, "libraryTitle" character varying, "userId" integer, "entries" text NOT NULL, "undoneAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_dd4704b373bed130f45ecfd9373" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_69cb1ee4413f40a228769301f6" ON "library_access_change" ("serverKind")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_69cb1ee4413f40a228769301f6"`
    );
    await queryRunner.query(`DROP TABLE "library_access_change"`);
  }
}
