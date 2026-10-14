import { UserType } from '@server/constants/user';
import dataSource from '@server/datasource';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { IsNull, Not } from 'typeorm';

/**
 * Emby used to keep its ids in Jellyfin's columns: the ids of titles on
 * the server, and people's Emby accounts. Emby now has columns of its own,
 * and on a server that was set up with Emby the ids are moved there once,
 * at startup, after the settings say so (settings migration 0010) and
 * before any job runs. Nothing else about the titles or the people changes:
 * avatars, account types and sign-in carry on as before. (The one
 * exception: accounts an old install recorded as Jellyfin ones, from when
 * Emby was told apart only by JELLYFIN_TYPE, are recorded as Emby's.)
 *
 * It is done here rather than as a database migration because those run
 * before the settings are read, and whether the server is Emby is only
 * known from the settings.
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
    // Installs that told Emby apart only by JELLYFIN_TYPE gave their people
    // Jellyfin accounts; on this server those were always Emby accounts.
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
