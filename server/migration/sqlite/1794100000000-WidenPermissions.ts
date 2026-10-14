import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Permissions past 2^31 (Auto-Approve Music is 2^31 itself) need a bigint.
 * SQLite keeps 64-bit integers either way; the column is declared bigint so
 * the schema matches. The table is rebuilt with every account's values.
 */
export class WidenPermissions1794100000000 implements MigrationInterface {
  name = 'WidenPermissions1794100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "temporary_user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "email" varchar NOT NULL, "username" varchar, "plexId" integer, "plexToken" varchar, "permissions" bigint NOT NULL DEFAULT (0), "avatar" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "password" varchar, "userType" integer NOT NULL DEFAULT (1), "plexUsername" varchar, "resetPasswordGuid" varchar, "recoveryLinkExpirationDate" datetime, "movieQuotaLimit" integer, "movieQuotaDays" integer, "tvQuotaLimit" integer, "tvQuotaDays" integer, "jellyfinUsername" varchar, "jellyfinAuthToken" varchar, "jellyfinUserId" varchar, "jellyfinDeviceId" varchar, "avatarETag" varchar, "avatarVersion" varchar, "plexTokenExpiredAt" datetime, "embyUsername" varchar, "embyUserId" varchar, "embyDeviceId" varchar, "embyAuthToken" varchar, "musicQuotaLimit" integer, "musicQuotaDays" integer, CONSTRAINT "UQ_e12875dfb3b1d92d7d7c5377e22" UNIQUE ("email"))`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_user"("id", "email", "username", "plexId", "plexToken", "permissions", "avatar", "createdAt", "updatedAt", "password", "userType", "plexUsername", "resetPasswordGuid", "recoveryLinkExpirationDate", "movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays", "jellyfinUsername", "jellyfinAuthToken", "jellyfinUserId", "jellyfinDeviceId", "avatarETag", "avatarVersion", "plexTokenExpiredAt", "embyUsername", "embyUserId", "embyDeviceId", "embyAuthToken", "musicQuotaLimit", "musicQuotaDays") SELECT "id", "email", "username", "plexId", "plexToken", "permissions", "avatar", "createdAt", "updatedAt", "password", "userType", "plexUsername", "resetPasswordGuid", "recoveryLinkExpirationDate", "movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays", "jellyfinUsername", "jellyfinAuthToken", "jellyfinUserId", "jellyfinDeviceId", "avatarETag", "avatarVersion", "plexTokenExpiredAt", "embyUsername", "embyUserId", "embyDeviceId", "embyAuthToken", "musicQuotaLimit", "musicQuotaDays" FROM "user"`
    );
    await queryRunner.query(`DROP TABLE "user"`);
    await queryRunner.query(`ALTER TABLE "temporary_user" RENAME TO "user"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "user" SET "permissions" = "permissions" % 2147483648`
    );
    await queryRunner.query(
      `CREATE TABLE "temporary_user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "email" varchar NOT NULL, "username" varchar, "plexId" integer, "plexToken" varchar, "permissions" integer NOT NULL DEFAULT (0), "avatar" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "password" varchar, "userType" integer NOT NULL DEFAULT (1), "plexUsername" varchar, "resetPasswordGuid" varchar, "recoveryLinkExpirationDate" datetime, "movieQuotaLimit" integer, "movieQuotaDays" integer, "tvQuotaLimit" integer, "tvQuotaDays" integer, "jellyfinUsername" varchar, "jellyfinAuthToken" varchar, "jellyfinUserId" varchar, "jellyfinDeviceId" varchar, "avatarETag" varchar, "avatarVersion" varchar, "plexTokenExpiredAt" datetime, "embyUsername" varchar, "embyUserId" varchar, "embyDeviceId" varchar, "embyAuthToken" varchar, "musicQuotaLimit" integer, "musicQuotaDays" integer, CONSTRAINT "UQ_e12875dfb3b1d92d7d7c5377e22" UNIQUE ("email"))`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_user"("id", "email", "username", "plexId", "plexToken", "permissions", "avatar", "createdAt", "updatedAt", "password", "userType", "plexUsername", "resetPasswordGuid", "recoveryLinkExpirationDate", "movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays", "jellyfinUsername", "jellyfinAuthToken", "jellyfinUserId", "jellyfinDeviceId", "avatarETag", "avatarVersion", "plexTokenExpiredAt", "embyUsername", "embyUserId", "embyDeviceId", "embyAuthToken", "musicQuotaLimit", "musicQuotaDays") SELECT "id", "email", "username", "plexId", "plexToken", "permissions", "avatar", "createdAt", "updatedAt", "password", "userType", "plexUsername", "resetPasswordGuid", "recoveryLinkExpirationDate", "movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays", "jellyfinUsername", "jellyfinAuthToken", "jellyfinUserId", "jellyfinDeviceId", "avatarETag", "avatarVersion", "plexTokenExpiredAt", "embyUsername", "embyUserId", "embyDeviceId", "embyAuthToken", "musicQuotaLimit", "musicQuotaDays" FROM "user"`
    );
    await queryRunner.query(`DROP TABLE "user"`);
    await queryRunner.query(`ALTER TABLE "temporary_user" RENAME TO "user"`);
  }
}
