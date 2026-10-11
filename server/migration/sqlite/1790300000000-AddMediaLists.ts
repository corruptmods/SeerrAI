import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaLists1790300000000 implements MigrationInterface {
  name = 'AddMediaLists1790300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_list" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "name" varchar NOT NULL, "ownerId" integer NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_media_list_owner" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_list_ownerId" ON "media_list" ("ownerId")`
    );
    await queryRunner.query(
      `CREATE TABLE "media_list_item" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "listId" integer NOT NULL, "tmdbId" integer NOT NULL, "mediaType" varchar NOT NULL, "addedById" integer, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_media_list_item" UNIQUE ("listId", "tmdbId", "mediaType"), CONSTRAINT "FK_media_list_item_list" FOREIGN KEY ("listId") REFERENCES "media_list" ("id") ON DELETE CASCADE, CONSTRAINT "FK_media_list_item_user" FOREIGN KEY ("addedById") REFERENCES "user" ("id") ON DELETE SET NULL)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_list_item_listId" ON "media_list_item" ("listId")`
    );
    await queryRunner.query(
      `CREATE TABLE "media_list_member" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "listId" integer NOT NULL, "userId" integer NOT NULL, CONSTRAINT "UQ_media_list_member" UNIQUE ("listId", "userId"), CONSTRAINT "FK_media_list_member_list" FOREIGN KEY ("listId") REFERENCES "media_list" ("id") ON DELETE CASCADE, CONSTRAINT "FK_media_list_member_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_list_member_listId" ON "media_list_member" ("listId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_list_member_userId" ON "media_list_member" ("userId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "media_list_member"`);
    await queryRunner.query(`DROP TABLE "media_list_item"`);
    await queryRunner.query(`DROP TABLE "media_list"`);
  }
}
