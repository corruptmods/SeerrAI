import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Personal API keys: each one a hash of the key, its visible id and name,
 * when it expires and when it was last used. They go with their owner.
 */
export class AddUserApiKey1795700000000 implements MigrationInterface {
  name = 'AddUserApiKey1795700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_api_key" ("id" SERIAL NOT NULL, "userId" integer NOT NULL, "publicId" character varying NOT NULL, "secretHash" character varying NOT NULL, "name" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expiresAt" TIMESTAMP WITH TIME ZONE, "lastUsedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_f8f725300f2070b9b442478d996" UNIQUE ("publicId"), CONSTRAINT "PK_9180f9a158e8cda6864358cd462" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c6316cc59f67b45ed31310bce5" ON "user_api_key" ("userId") `
    );
    await queryRunner.query(
      `ALTER TABLE "user_api_key" ADD CONSTRAINT "FK_c6316cc59f67b45ed31310bce53" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_api_key" DROP CONSTRAINT "FK_c6316cc59f67b45ed31310bce53"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_c6316cc59f67b45ed31310bce5"`
    );
    await queryRunner.query(`DROP TABLE "user_api_key"`);
  }
}
