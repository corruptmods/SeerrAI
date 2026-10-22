import type {
  MbArtist,
  MbReleaseGroup,
} from '@server/api/musicbrainz/interfaces';
import logger from '@server/logger';

/*
 * Which albums and artists a music search shows first.
 *
 * MusicBrainz scores every exact match the same (100) and lists those in no
 * useful order, so a search for "Moonlurker" can fill the page with obscure
 * albums of that name and leave out Marcus Delray's. The search asks for
 * many more than it shows and ranks them here, using only what the search
 * answer already carries: no extra request per result.
 */

/** Album before EP before single before anything else. */
const TYPE_ORDER = ['album', 'ep', 'single'];

const typeRank = (group: MbReleaseGroup): number => {
  const rank = TYPE_ORDER.indexOf((group['primary-type'] ?? '').toLowerCase());
  return rank === -1 ? TYPE_ORDER.length : rank;
};

/**
 * How many releases (pressings, editions, countries) an album has: the
 * best sign in a search answer of how widely it is known.
 */
const releaseCount = (group: MbReleaseGroup): number =>
  group.count ?? group.releases?.length ?? 0;

/** Only ever released as bootlegs: shown after the rest. */
const onlyBootlegs = (group: MbReleaseGroup): boolean => {
  const releases = group.releases ?? [];
  return (
    releases.length > 0 &&
    releases.every((release) => release.status === 'Bootleg')
  );
};

/**
 * Sorted by each key in turn; ties keep the order MusicBrainz gave (the
 * sort is stable).
 */
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
 * The albums to show, best first: by how well they matched, then by how
 * many releases they have, then albums before EPs and singles, then
 * anything officially released before bootlegs.
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
 * The artists to show, best first: by how well they matched, then the
 * artists of the albums shown (the first album's before the second's), then
 * the ones MusicBrainz's users have tagged most. Searching a band's name
 * then puts the band itself ahead of others with the same name.
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

/** One page of a MusicBrainz search: the total there is, and this page. */
export interface SearchPage<T> {
  count: number;
  items: T[];
}

/**
 * A search's results, looking further while they are still tied.
 *
 * When every result on a page has the top score, the one people mean can
 * be on the next page as easily as this one (a search for "Moonlurker" has
 * a hundred exact matches before Marcus Delray's). So while a page ends
 * on the top score and there are more, the next page is asked for too, up
 * to `maxPages`. Only searches like that cost the extra requests.
 *
 * Extra pages are a nicety: if one fails (MusicBrainz busy), what was
 * found so far is used.
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
