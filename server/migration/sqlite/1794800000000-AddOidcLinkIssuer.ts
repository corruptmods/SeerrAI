import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The issuer each single sign-on link was made at. Existing links start
 * without one and take the provider's issuer the next time they are used,
 * or the old one if an admin changes the issuer first.
 */
export class AddOidcLinkIssuer1794800000000 implements MigrationInterface {
  name = 'AddOidcLinkIssuer1794800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "oidc_link" ADD COLUMN "issuer" varchar`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "oidc_link" DROP COLUMN "issuer"`);
  }
}
