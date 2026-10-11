import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserPasskey1791600000000 implements MigrationInterface {
  name = 'AddUserPasskey1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_passkey" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "credentialId" varchar NOT NULL, "publicKey" text NOT NULL, "counter" bigint NOT NULL DEFAULT (0), "transports" varchar, "backedUp" boolean NOT NULL DEFAULT (0), "name" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "lastUsedAt" datetime, "userId" integer NOT NULL, CONSTRAINT "UQ_d6830efbe0349de85ac277d3f70" UNIQUE ("credentialId"), CONSTRAINT "FK_e34332f6df76720f7208cd5c049" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e34332f6df76720f7208cd5c04" ON "user_passkey" ("userId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_e34332f6df76720f7208cd5c04"`);
    await queryRunner.query(`DROP TABLE "user_passkey"`);
  }
}
