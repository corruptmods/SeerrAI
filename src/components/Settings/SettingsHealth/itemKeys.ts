import type { HealthItem } from '@server/lib/health';

/*
 * A key per check item from what it is, not where it sits: keyed by position,
 * a pressed "Search now" would carry over to whichever title moves into its
 * place (next page, Check Again). A repeated item gets a number after the
 * first.
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
