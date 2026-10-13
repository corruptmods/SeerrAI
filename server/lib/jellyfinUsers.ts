import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';

/**
 * The accounts already linked to these Jellyfin or Emby users, keyed by the
 * user's id in its plain form (no dashes, lower case). Accounts made by older
 * imports, or from Emby, can hold the same id with dashes or capitals, so the
 * comparison is made on the plain form of both.
 */
export const linkedJellyfinUsers = async (
  jellyfinUserIds: string[]
): Promise<Map<string, User>> => {
  const ids = [
    ...new Set(
      jellyfinUserIds
        .map((id) => normalizeJellyfinGuid(id))
        .filter((id): id is string => !!id)
    ),
  ];

  if (!ids.length) {
    return new Map();
  }

  const users = await getRepository(User)
    .createQueryBuilder('user')
    .where("LOWER(REPLACE(user.jellyfinUserId, '-', '')) IN (:...ids)", {
      ids,
    })
    .getMany();

  return new Map(
    users.map((user) => [normalizeJellyfinGuid(user.jellyfinUserId)!, user])
  );
};
