import type { JellyfinFamilyKind } from '@server/constants/server';
import { USER_ID } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';

/**
 * Accounts linked to these Jellyfin or Emby user ids, keyed by plain id (no
 * dashes, lower case). Older imports and Emby store ids with dashes or
 * capitals, so both sides are compared in plain form.
 */
export const linkedJellyfinUsers = async (
  jellyfinUserIds: string[],
  kind: JellyfinFamilyKind = 'jellyfin'
): Promise<Map<string, User>> => {
  const column = USER_ID[kind];
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
    .where(`LOWER(REPLACE(user.${column}, '-', '')) IN (:...ids)`, {
      ids,
    })
    .getMany();

  return new Map(
    users.map((user) => [normalizeJellyfinGuid(user[column])!, user])
  );
};
