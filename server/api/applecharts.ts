import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';

/*
 * A country's most-played songs and albums from Apple's keyless marketing
 * feeds. Entries have no MusicBrainz ids; lib/music/charts matches them.
 */

export const APPLE_CHARTS_URL = 'https://rss.marketingtools.apple.com/api/v2';

/** Entries read per chart. */
export const CHART_SIZE = 50;

/** Charts move daily. */
const TTL_SECONDS = 6 * 3600;

const TIMEOUT_MS = 15_000;

export type AppleChartKind = 'songs' | 'albums';

/** One song or album on a chart. */
export interface AppleChartEntry {
  /** Apple's id. */
  id: string;
  name: string;
  /** All credited artists joined: "A & B", "A, B & C". */
  artistName: string;
  /** Apple's id for the first credited artist. */
  artistId?: string;
  /** YYYY-MM-DD. */
  releaseDate?: string;
}

interface AppleChartResponse {
  feed?: { results?: unknown[] };
}

const isEntry = (value: unknown): value is AppleChartEntry => {
  const entry = value as Partial<AppleChartEntry> | null;
  return (
    !!entry &&
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    !!entry.name.trim() &&
    typeof entry.artistName === 'string' &&
    !!entry.artistName.trim()
  );
};

class AppleChartsAPI extends ExternalAPI {
  constructor(baseUrl = APPLE_CHARTS_URL) {
    super(
      baseUrl,
      {},
      {
        nodeCache: cacheManager.getCache('applecharts').data,
        timeout: TIMEOUT_MS,
      }
    );
  }

  /** A country's chart ("us", "gb"), most played first. */
  public async mostPlayed(
    country: string,
    kind: AppleChartKind
  ): Promise<AppleChartEntry[]> {
    const data = await this.get<AppleChartResponse>(
      `/${country}/music/most-played/${CHART_SIZE}/${kind}.json`,
      {},
      TTL_SECONDS,
      // Don't cache an empty chart, or its rows stay empty for hours.
      {
        keep: (answer) =>
          Array.isArray(answer?.feed?.results) &&
          answer.feed.results.length > 0,
      }
    );
    return (data?.feed?.results ?? []).filter(isEntry).map((entry) => ({
      id: entry.id,
      name: entry.name.trim(),
      artistName: entry.artistName.trim(),
      ...(typeof entry.artistId === 'string'
        ? { artistId: entry.artistId }
        : {}),
      ...(typeof entry.releaseDate === 'string'
        ? { releaseDate: entry.releaseDate }
        : {}),
    }));
  }
}

export default AppleChartsAPI;
