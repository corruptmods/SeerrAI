import { getRepository } from '@server/datasource';
import { Watchlist } from '@server/entity/Watchlist';

/**
 * One page of the watchlist a person keeps here (rather than on Plex), and
 * how many it holds, in the order added.
 */
export const savedWatchlistPage = (
  userId: number,
  offset: number,
  take: number
): Promise<[Watchlist[], number]> =>
  getRepository(Watchlist).findAndCount({
    where: { requestedBy: { id: userId } },
    order: { id: 'ASC' },
    take,
    skip: offset,
  });
