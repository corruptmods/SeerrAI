import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserPasskey1791600000000 implements MigrationInterface {
  name = 'AddUserPasskey1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_passkey" ("id" SERIAL NOT NULL, "credentialId" character varying NOT NULL, "publicKey" text NOT NULL, "counter" bigint NOT NULL DEFAULT '0', "transports" character varying, "backedUp" boolean NOT NULL DEFAULT false, "name" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lastUsedAt" TIMESTAMP WITH TIME ZONE, "userId" integer NOT NULL, CONSTRAINT "UQ_d6830efbe0349de85ac277d3f70" UNIQUE ("credentialId"), CONSTRAINT "PK_85011ddb1f9d68d5123a51d9851" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e34332f6df76720f7208cd5c04" ON "user_passkey" ("userId") `
    );
    await queryRunner.query(
      `ALTER TABLE "user_passkey" ADD CONSTRAINT "FK_e34332f6df76720f7208cd5c049" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_passkey" DROP CONSTRAINT "FK_e34332f6df76720f7208cd5c049"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e34332f6df76720f7208cd5c04"`
    );
    await queryRunner.query(`DROP TABLE "user_passkey"`);
  }
}
