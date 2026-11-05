/*
 * Watch list sort orders. Each section (to watch, unavailable, watched) is
 * sorted separately, so availability isn't offered as a sort.
 */

export const LIST_SORTS = [
  'added-desc',
  'added-asc',
  'title',
  'release-desc',
  'release-asc',
] as const;

export type ListSort = (typeof LIST_SORTS)[number];

export const DEFAULT_LIST_SORT: ListSort = 'added-desc';

export const isListSort = (value: unknown): value is ListSort =>
  LIST_SORTS.includes(value as ListSort);

interface Sortable {
  id: number;
  title?: string;
  releaseDate?: string;
  createdAt?: string;
}

/** "The Mazewright" files under M, as it does in Plex. */
const sortTitle = (title: string | undefined) =>
  (title ?? '').trim().replace(/^(the|a|an)\s+/i, '');

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

/** Epoch ms, or undefined for a blank or unparseable date. */
const time = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** Sorts by a date, with undated titles last in either direction. */
const byDate =
  <T extends Sortable>(pick: (item: T) => string | undefined, dir: 1 | -1) =>
  (a: T, b: T) => {
    const ta = time(pick(a));
    const tb = time(pick(b));
    if (ta === undefined || tb === undefined) {
      return ta === tb ? 0 : ta === undefined ? 1 : -1;
    }
    return (ta - tb) * dir;
  };

/** A sorted copy. Ties break by date added (newest first), then id, so the order is stable. */
export const sortListItems = <T extends Sortable>(
  items: T[],
  sort: ListSort
): T[] => {
  const newestAdded = byDate<T>((item) => item.createdAt, -1);
  const tiebreak = (a: T, b: T) => newestAdded(a, b) || b.id - a.id;

  const compare: (a: T, b: T) => number =
    sort === 'added-asc'
      ? (a, b) => byDate<T>((item) => item.createdAt, 1)(a, b) || a.id - b.id
      : sort === 'title'
        ? (a, b) =>
            collator.compare(sortTitle(a.title), sortTitle(b.title)) ||
            tiebreak(a, b)
        : sort === 'release-desc'
          ? (a, b) =>
              byDate<T>((item) => item.releaseDate, -1)(a, b) || tiebreak(a, b)
          : sort === 'release-asc'
            ? (a, b) =>
                byDate<T>((item) => item.releaseDate, 1)(a, b) || tiebreak(a, b)
            : tiebreak;

  return [...items].sort(compare);
};
