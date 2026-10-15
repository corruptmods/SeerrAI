import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOidcLink1794700000000 implements MigrationInterface {
  name = 'AddOidcLink1794700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "oidc_link" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "provider" varchar NOT NULL, "sub" varchar NOT NULL, "username" varchar, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "userId" integer NOT NULL, CONSTRAINT "FK_5a3864f3c243afe4d29f7a8ff43" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_oidc_link_user_provider" ON "oidc_link" ("userId", "provider") `
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_oidc_link_provider_sub" ON "oidc_link" ("provider", "sub") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_oidc_link_provider_sub"`);
    await queryRunner.query(`DROP INDEX "IDX_oidc_link_user_provider"`);
    await queryRunner.query(`DROP TABLE "oidc_link"`);
  }
}
