import type {
  MbArtist,
  MbReleaseGroup,
} from '@server/api/musicbrainz/interfaces';
import logger from '@server/logger';

/*
 * Ranks music search results. MusicBrainz scores every exact match 100 in
 * no useful order, so a search for "Moonlurker" can bury Marcus Delray's
 * album under obscure ones. The search over-fetches and ranks here using
 * only fields in the response, with no per-result requests.
 */

/** Album, then EP, then single, then anything else. */
const TYPE_ORDER = ['album', 'ep', 'single'];

const typeRank = (group: MbReleaseGroup): number => {
  const rank = TYPE_ORDER.indexOf((group['primary-type'] ?? '').toLowerCase());
  return rank === -1 ? TYPE_ORDER.length : rank;
};

/**
 * Number of releases (pressings, editions, countries): the best popularity
 * signal in a search response.
 */
const releaseCount = (group: MbReleaseGroup): number =>
  group.count ?? group.releases?.length ?? 0;

/** True when every release is a bootleg. */
const onlyBootlegs = (group: MbReleaseGroup): boolean => {
  const releases = group.releases ?? [];
  return (
    releases.length > 0 &&
    releases.every((release) => release.status === 'Bootleg')
  );
};

/** Sorts by each key in turn; ties keep MusicBrainz's order. */
const rankBy = <T>(
  list: T[],
  keys: ((item: T) => number)[],
  limit: number
): T[] =>
  list
    .map((item) => ({ item, values: keys.map((key) => key(item)) }))
    .sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        if (a.values[i] !== b.values[i]) {
          return a.values[i] - b.values[i];
        }
      }
      return 0;
    })
    .slice(0, limit)
    .map(({ item }) => item);

/**
 * Albums best first: by score, release count, type, then non-bootlegs
 * before bootlegs.
 */
export const rankAlbums = (
  groups: MbReleaseGroup[],
  limit: number
): MbReleaseGroup[] =>
  rankBy(
    groups,
    [
      (group) => -(group.score ?? 0),
      (group) => -releaseCount(group),
      typeRank,
      (group) => Number(onlyBootlegs(group)),
    ],
    limit
  );

/**
 * Artists best first: by score, then position of their first shown album,
 * then total tag count. Puts a band ahead of others with the same name.
 */
export const rankArtists = (
  artists: MbArtist[],
  shownAlbums: MbReleaseGroup[],
  limit: number
): MbArtist[] => {
  const firstAlbum = new Map<string, number>();
  shownAlbums.forEach((group, position) => {
    for (const credit of group['artist-credit'] ?? []) {
      if (!firstAlbum.has(credit.artist.id)) {
        firstAlbum.set(credit.artist.id, position);
      }
    }
  });
  return rankBy(
    artists,
    [
      (artist) => -(artist.score ?? 0),
      (artist) => firstAlbum.get(artist.id) ?? shownAlbums.length,
      (artist) =>
        -(artist.tags ?? []).reduce((sum, tag) => sum + (tag.count ?? 0), 0),
    ],
    limit
  );
};

/** One page of a MusicBrainz search, with the total count. */
export interface SearchPage<T> {
  count: number;
  items: T[];
}

/**
 * Search results, fetching further pages while the last result still has
 * the top score, up to `maxPages`: the intended match can be on any page of
 * ties ("Moonlurker" has a hundred exact matches before Marcus Delray's).
 * A failed extra page returns what was found so far.
 */
export const searchWhileTied = async <T extends { id: string; score?: number }>(
  page: (offset: number) => Promise<SearchPage<T>>,
  { pageSize, maxPages }: { pageSize: number; maxPages: number }
): Promise<T[]> => {
  const first = await page(0);
  const found = new Map(first.items.map((item) => [item.id, item]));
  const top = Math.max(0, ...first.items.map((item) => item.score ?? 0));
  let last = first;
  for (let n = 1; n < maxPages; n++) {
    const offset = n * pageSize;
    const tied = (last.items[last.items.length - 1]?.score ?? 0) >= top;
    if (!tied || last.items.length < pageSize || offset >= last.count) {
      break;
    }
    try {
      last = await page(offset);
    } catch (e) {
      logger.debug('Could not look further in a music search', {
        label: 'Music',
        offset,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      break;
    }
    for (const item of last.items) {
      if (!found.has(item.id)) {
        found.set(item.id, item);
      }
    }
  }
  return [...found.values()];
};
