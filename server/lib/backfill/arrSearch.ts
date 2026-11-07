import type { ProwlarrRelease } from '@server/api/prowlarr';
import type { IndexerRef } from '@server/lib/backfill/indexerLimit';
import type {
  ArrSearchRelease,
  SonarrEpisode,
} from '@server/lib/backfill/sonarr';
import { RELEASE_SEARCH_TIMEOUT_MS } from '@server/lib/backfill/sonarr';
import type { BackfillSettings } from '@server/lib/settings';

/*
 * Backfill's search through Sonarr, Radarr and Lidarr: their interactive
 * search for one title, by its own ids, across their indexers. Prowlarr's
 * free-text search finds packs under other names; the *arrs' finds what
 * their ids lead their indexers to. Settings → Backfill chooses either or
 * both.
 */

type SearchWith = Pick<BackfillSettings, 'searchWith'>;

export const prowlarrSetUp = (
  settings: Pick<BackfillSettings, 'prowlarr'>
): boolean => !!(settings.prowlarr.hostname && settings.prowlarr.apiKey);

export const searchesProwlarr = (settings: SearchWith): boolean =>
  settings.searchWith !== 'arrs';

export const searchesArrs = (settings: SearchWith): boolean =>
  settings.searchWith !== 'prowlarr';

/** Whether Prowlarr is searched: chosen, and set up. */
export const prowlarrSearched = (
  settings: Pick<BackfillSettings, 'prowlarr' | 'searchWith'>
): boolean => searchesProwlarr(settings) && prowlarrSetUp(settings);

/**
 * An *arr's search result as Backfill's release, which it opens, judges and
 * downloads like one from Prowlarr. Null for a protocol Backfill can't use.
 * Sonarr's mapping and rejections are left out: Backfill reads each file's
 * name itself, as for every release.
 */
export const arrRelease = (
  release: ArrSearchRelease
): ProwlarrRelease | null => {
  const protocol =
    release.protocol === 'torrent' || release.protocol === 'usenet'
      ? release.protocol
      : null;
  if (!protocol) return null;
  return {
    guid: release.guid,
    title: release.title,
    size: release.size ?? 0,
    indexerId: release.indexerId,
    // Indexers Prowlarr syncs are named "Knaben (Prowlarr)" in the *arrs;
    // the plain name keeps one limit per indexer whichever found it.
    indexer: (release.indexer ?? '').replace(/ \(Prowlarr\)$/, ''),
    protocol,
    seeders: release.seeders,
    downloadUrl: release.downloadUrl,
    magnetUrl: release.magnetUrl,
    infoHash: release.infoHash,
    publishDate: release.publishDate,
  };
};

/**
 * An *arr server as indexer limits know it: its searches spend its
 * indexers' daily searches, and an *arr at a limit is left alone like one.
 */
export const arrIndexer = (
  app: 'Sonarr' | 'Radarr' | 'Lidarr',
  server: { name: string }
): IndexerRef => ({
  name: server.name.toLowerCase().includes(app.toLowerCase())
    ? server.name
    : `${app} ${server.name}`.trim(),
});

/** One of Sonarr's interactive searches for a series. */
export type SeriesSearch =
  | { season: number }
  | { season: number; episode: number; episodeId: number };

/** Seasons missing this many episodes or fewer are searched episode by episode. */
export const EPISODES_ONE_BY_ONE = 2;
/** Sonarr searches per series, each spending a search on every indexer. */
export const MAX_SERIES_SEARCHES = 4;

/**
 * Sonarr's searches for a series' missing episodes, at most
 * MAX_SERIES_SEARCHES. A season missing more than EPISODES_ONE_BY_ONE is
 * searched as a season, which returns its packs; one missing fewer, each
 * missing episode by itself, since a season search finds mostly packs of
 * episodes already there. Specials are always searched one by one. Seasons
 * missing most go first, then specials, then seasons only below the cutoff.
 */
export const seriesSearches = (
  missing: SonarrEpisode[],
  belowCutoffSeasons: number[] = []
): SeriesSearch[] => {
  const bySeason = new Map<number, SonarrEpisode[]>();
  for (const ep of missing) {
    bySeason.set(ep.seasonNumber, [
      ...(bySeason.get(ep.seasonNumber) ?? []),
      ep,
    ]);
  }
  const byEpisode = (episodes: SonarrEpisode[]): SeriesSearch[] =>
    [...episodes]
      .sort((a, b) => a.episodeNumber - b.episodeNumber)
      .map((ep) => ({
        season: ep.seasonNumber,
        episode: ep.episodeNumber,
        episodeId: ep.id,
      }));
  const seasons = [...bySeason.entries()]
    .filter(([season]) => season > 0)
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  const searches: SeriesSearch[] = [
    ...seasons.flatMap(([season, episodes]) =>
      episodes.length > EPISODES_ONE_BY_ONE ? [{ season }] : byEpisode(episodes)
    ),
    ...byEpisode(bySeason.get(0) ?? []),
    ...[...new Set(belowCutoffSeasons)]
      .filter((season) => season > 0 && !bySeason.has(season))
      .sort((a, b) => a - b)
      .map((season) => ({ season })),
  ];
  return searches.slice(0, MAX_SERIES_SEARCHES);
};

/** How a search is named in problems: "S03", "S03E04". */
export const seriesSearchLabel = (search: SeriesSearch): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return 'episode' in search
    ? `S${pad(search.season)}E${pad(search.episode)}`
    : `S${pad(search.season)}`;
};

/**
 * Backfill's own *arr searches for a title (or the admin agent's), from the
 * first asked to the last answered. Each interactive search sets the *arr's
 * last search time of what it covered, by the *arr's clock once its
 * indexers have answered, as its own searches do; a stamp in this window is
 * Backfill's, not the *arr's. `to` is null while the searches run.
 */
export interface OwnArrSearch {
  from: string;
  to: string | null;
  /** How many searches it makes, to bound a window still open. */
  searches: number;
}

/** Windows kept per title: stamps older than these are the *arr's again. */
export const MAX_OWN_SEARCHES = 5;

/** Clock difference allowed between Seerr and the *arr. */
export const CLOCK_SKEW_MS = 60_000;

/**
 * Leeway after the last answer: a search Backfill stopped waiting for runs
 * on in the *arr, which stamps it when it ends.
 */
export const OWN_SEARCH_GRACE_MS = 5 * 60_000;

/** Whether an *arr's last search time is from Backfill's own searches. */
export const isOwnArrSearch = (
  own: OwnArrSearch[] | null | undefined,
  searched: string | Date | null | undefined,
  now = Date.now()
): boolean => {
  if (!own?.length || !searched) return false;
  const at = new Date(searched).getTime();
  if (Number.isNaN(at)) return false;
  return own.some((window) => {
    const from = new Date(window.from).getTime();
    // Still running (or Seerr stopped mid-search): open as long as its
    // searches could take.
    const to = window.to
      ? new Date(window.to).getTime()
      : Math.min(
          now,
          from + Math.max(1, window.searches) * RELEASE_SEARCH_TIMEOUT_MS
        );
    return (
      at >= from - CLOCK_SKEW_MS &&
      at <= to + CLOCK_SKEW_MS + OWN_SEARCH_GRACE_MS
    );
  });
};

/** Windows with a search opened, the oldest dropped past the cap. */
export const openOwnSearch = (
  own: OwnArrSearch[] | null | undefined,
  window: OwnArrSearch
): OwnArrSearch[] => [...(own ?? []), window].slice(-MAX_OWN_SEARCHES);

/** Windows with the one opened at `from` closed at `to`. */
export const closeOwnSearch = (
  own: OwnArrSearch[] | null | undefined,
  from: string,
  to: string
): OwnArrSearch[] =>
  (own ?? []).map((window) =>
    window.from === from ? { ...window, to } : window
  );
