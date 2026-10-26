import { getRepository } from '@server/datasource';
import { Watchlist } from '@server/entity/Watchlist';
import { seededShuffle } from '@server/utils/shuffle';

/**
 * One page of the watchlist a person keeps here (rather than on Plex), and
 * how many it holds: in the order added, or mixed by `shuffle` so each
 * visit starts somewhere new while its pages follow on.
 */
export const savedWatchlistPage = async (
  userId: number,
  offset: number,
  take: number,
  shuffle?: number
): Promise<[Watchlist[], number]> => {
  const where = { requestedBy: { id: userId } };
  if (shuffle === undefined) {
    return getRepository(Watchlist).findAndCount({ where, take, skip: offset });
  }
  const all = await getRepository(Watchlist).find({
    where,
    order: { id: 'ASC' },
  });
  return [seededShuffle(all, shuffle).slice(offset, offset + take), all.length];
};
