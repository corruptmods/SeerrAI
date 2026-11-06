import type { WatchlistSort } from '@server/constants/watchlistSort';
import { getRepository } from '@server/datasource';
import { Watchlist } from '@server/entity/Watchlist';
import { In } from 'typeorm';

/** "The Mazewright" files under M, as it does in Plex. */
const titleKey = (title: string) => title.trim().replace(/^(the|a|an)\s+/i, '');

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

/**
 * One page of a user's Seerr-side (not Plex) watchlist, plus its total. In
 * added order (oldest first) unless another order is asked for.
 */
export const savedWatchlistPage = async (
  userId: number,
  offset: number,
  take: number,
  sort?: WatchlistSort
): Promise<[Watchlist[], number]> => {
  const repository = getRepository(Watchlist);
  const where = { requestedBy: { id: userId } };

  if (sort !== 'title') {
    return repository.findAndCount({
      where,
      order: { id: sort === 'added-desc' ? 'DESC' : 'ASC' },
      take,
      skip: offset,
    });
  }

  // The database can't file titles as Plex does, so the order comes from
  // every title's name, then only the page's titles are loaded.
  const names = await repository.find({
    where,
    select: { id: true, title: true },
    loadEagerRelations: false,
  });
  const ids = names
    .sort(
      (a, b) =>
        collator.compare(titleKey(a.title), titleKey(b.title)) || a.id - b.id
    )
    .slice(offset, offset + take)
    .map((item) => item.id);
  const rows = ids.length
    ? await repository.find({ where: { id: In(ids) } })
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  return [ids.flatMap((id) => byId.get(id) ?? []), names.length];
};
