import { getRepository } from '@server/datasource';
import { MediaList } from '@server/entity/MediaList';

/**
 * Lists are private: only the owner and the users the owner has added can see
 * one. Every route resolves access through this, so visibility is enforced in
 * one place rather than per-handler.
 */
export const loadAccessibleList = async (
  listId: number,
  userId: number
): Promise<{ list: MediaList; isOwner: boolean } | null> => {
  const list = await getRepository(MediaList).findOne({
    where: { id: listId },
    relations: { members: true },
  });

  if (!list) {
    return null;
  }

  if (list.ownerId === userId) {
    return { list, isOwner: true };
  }

  const isMember = (list.members ?? []).some(
    (member) => member.userId === userId
  );

  return isMember ? { list, isOwner: false } : null;
};

/** Ids of every list a user can see: their own, plus ones shared with them. */
export const accessibleListIds = async (userId: number): Promise<number[]> => {
  const owned = await getRepository(MediaList).find({
    select: { id: true },
    where: { ownerId: userId },
  });

  const shared = await getRepository(MediaList).find({
    select: { id: true },
    where: { members: { userId } },
  });

  return [...new Set([...owned, ...shared].map((list) => list.id))];
};

export default loadAccessibleList;
