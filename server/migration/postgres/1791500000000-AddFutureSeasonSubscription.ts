import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFutureSeasonSubscription1791500000000 implements MigrationInterface {
  name = 'AddFutureSeasonSubscription1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "future_season_subscription" ("id" SERIAL NOT NULL, "tmdbId" integer NOT NULL, "fromSeason" integer NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "userId" integer NOT NULL, CONSTRAINT "UNIQUE_FUTURE_SEASON_SUBSCRIPTION" UNIQUE ("userId", "tmdbId"), CONSTRAINT "PK_1ab50ffbcd88f671b0b4e8420eb" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_03ee0b8d246701c8f0d2d0e01b" ON "future_season_subscription" ("userId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7d85a204c6e31cba2f18339654" ON "future_season_subscription" ("tmdbId") `
    );
    await queryRunner.query(
      `ALTER TABLE "future_season_subscription" ADD CONSTRAINT "FK_03ee0b8d246701c8f0d2d0e01bd" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "future_season_subscription" DROP CONSTRAINT "FK_03ee0b8d246701c8f0d2d0e01bd"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7d85a204c6e31cba2f18339654"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_03ee0b8d246701c8f0d2d0e01b"`
    );
    await queryRunner.query(`DROP TABLE "future_season_subscription"`);
  }
}
