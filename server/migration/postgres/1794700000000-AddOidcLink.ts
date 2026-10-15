import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOidcLink1794700000000 implements MigrationInterface {
  name = 'AddOidcLink1794700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "oidc_link" ("id" SERIAL NOT NULL, "provider" character varying NOT NULL, "sub" character varying NOT NULL, "username" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "userId" integer NOT NULL, CONSTRAINT "PK_3843f277872989abed9bc74626f" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_oidc_link_user_provider" ON "oidc_link" ("userId", "provider") `
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_oidc_link_provider_sub" ON "oidc_link" ("provider", "sub") `
    );
    await queryRunner.query(
      `ALTER TABLE "oidc_link" ADD CONSTRAINT "FK_5a3864f3c243afe4d29f7a8ff43" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "oidc_link" DROP CONSTRAINT "FK_5a3864f3c243afe4d29f7a8ff43"`
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_oidc_link_provider_sub"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_oidc_link_user_provider"`
    );
    await queryRunner.query(`DROP TABLE "oidc_link"`);
  }
}
