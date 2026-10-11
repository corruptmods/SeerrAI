import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListWatchSync1790600000000 implements MigrationInterface {
  name = 'AddListWatchSync1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD "watchedSync" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list" ADD "lastWatchCheck" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(
      `CREATE TABLE "media_list_watch_suggestion" ("id" SERIAL NOT NULL, "listId" integer NOT NULL, "itemId" integer NOT NULL, "dismissedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_media_list_watch_suggestion_item" UNIQUE ("itemId"), CONSTRAINT "PK_media_list_watch_suggestion" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_list_watch_suggestion_listId" ON "media_list_watch_suggestion" ("listId")`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_watch_suggestion" ADD CONSTRAINT "FK_mlws_list" FOREIGN KEY ("listId") REFERENCES "media_list"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list_watch_suggestion" ADD CONSTRAINT "FK_mlws_item" FOREIGN KEY ("itemId") REFERENCES "media_list_item"("id") ON DELETE CASCADE`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "media_list_watch_suggestion"`);
    await queryRunner.query(
      `ALTER TABLE "media_list" DROP COLUMN "lastWatchCheck"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_list" DROP COLUMN "watchedSync"`
    );
  }
}
