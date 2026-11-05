import { UserType } from '@server/constants/user';
import dataSource from '@server/datasource';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { IsNull, Not } from 'typeorm';

/**
 * On an Emby server, moves Emby's title and account ids out of Jellyfin's
 * columns into Emby's own. Runs once at startup when settings migration 0010
 * flags it, before any job. Accounts recorded as Jellyfin (from when Emby was
 * told apart only by JELLYFIN_TYPE) become Emby accounts; nothing else changes.
 *
 * Not a database migration: those run before settings are read, and only the
 * settings say whether the server is Emby.
 */
export const splitEmbyData = async (): Promise<void> => {
  const settings = getSettings();
  if (!settings.pendingEmbySplit) {
    return;
  }

  await dataSource.transaction(async (manager) => {
    await manager.query(
      `UPDATE "media" SET "embyMediaId" = "jellyfinMediaId", "embyMediaId4k" = "jellyfinMediaId4k", "jellyfinMediaId" = NULL, "jellyfinMediaId4k" = NULL WHERE "jellyfinMediaId" IS NOT NULL OR "jellyfinMediaId4k" IS NOT NULL`
    );
    // JELLYFIN_TYPE-only installs made these Jellyfin accounts; here they are
    // Emby's.
    await manager.update(
      User,
      { userType: UserType.JELLYFIN, jellyfinUserId: Not(IsNull()) },
      { userType: UserType.EMBY }
    );
    await manager.query(
      `UPDATE "user" SET "embyUserId" = "jellyfinUserId", "embyUsername" = "jellyfinUsername", "embyDeviceId" = "jellyfinDeviceId", "embyAuthToken" = "jellyfinAuthToken", "jellyfinUserId" = NULL, "jellyfinUsername" = NULL, "jellyfinDeviceId" = NULL, "jellyfinAuthToken" = NULL WHERE "jellyfinUserId" IS NOT NULL`
    );
  });

  settings.pendingEmbySplit = false;
  await settings.save();

  logger.info("Moved Emby's ids on titles and people to Emby's own columns", {
    label: 'Settings',
  });
};
