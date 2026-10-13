import type { HealthItem } from '@server/lib/health';

/*
 * A key for each item in a check's list, from what the item is rather than
 * where it sits. Keyed by position, a "Search now" already pressed stayed
 * pressed on whichever title moved into its place, on the next page or
 * after Check Again. The same item twice gets a number after the first.
 */
export const itemKeys = (items: HealthItem[]): string[] => {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = item.searchable
      ? `search:${item.searchable.mediaId}:${item.searchable.is4k}`
      : `item:${item.href ?? ''}:${item.title}:${item.detail ?? ''}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}:${count}` : base;
  });
};
