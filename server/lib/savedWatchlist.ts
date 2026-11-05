import { getRepository } from '@server/datasource';
import { Watchlist } from '@server/entity/Watchlist';

/**
 * One page of a user's Seerr-side (not Plex) watchlist in added order, plus its
 * total.
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
