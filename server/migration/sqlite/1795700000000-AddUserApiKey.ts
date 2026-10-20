import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Personal API keys: each one a hash of the key, its visible id and name,
 * when it expires and when it was last used. They go with their owner.
 */
export class AddUserApiKey1795700000000 implements MigrationInterface {
  name = 'AddUserApiKey1795700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_api_key" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" integer NOT NULL, "publicId" varchar NOT NULL, "secretHash" varchar NOT NULL, "name" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "expiresAt" datetime, "lastUsedAt" datetime, CONSTRAINT "UQ_f8f725300f2070b9b442478d996" UNIQUE ("publicId"), CONSTRAINT "FK_c6316cc59f67b45ed31310bce53" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c6316cc59f67b45ed31310bce5" ON "user_api_key" ("userId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_c6316cc59f67b45ed31310bce5"`);
    await queryRunner.query(`DROP TABLE "user_api_key"`);
  }
}
