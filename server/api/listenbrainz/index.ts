import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import type { LbFreshReleasesResponse, LbSimilarArtist } from './interfaces';

/*
 * ListenBrainz for music Discover rows; no key needed. Responses carry
 * MusicBrainz ids and covers come from the Cover Art Archive, so rows cost
 * no MusicBrainz requests.
 */

export const LISTENBRAINZ_URL = 'https://api.listenbrainz.org/1';

/** Labs API, for datasets not in the main API yet (similar artists). */
export const LISTENBRAINZ_LABS_URL = 'https://labs.api.listenbrainz.org';

/**
 * Similar-artist dataset: artists played in the same sessions over about
 * twenty years. The one ListenBrainz's own site uses.
 */
const SIMILAR_ARTISTS_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

/** Rows change slowly. */
const TTL_SECONDS = 6 * 3600;

const TIMEOUT_MS = 15_000;

/** Cache only non-empty answers, so an empty row isn't stuck for six hours. */
const listed = (list: unknown[] | undefined): boolean =>
  Array.isArray(list) && list.length > 0;

class ListenBrainzAPI extends ExternalAPI {
  constructor(baseUrl = LISTENBRAINZ_URL) {
    super(
      baseUrl,
      {},
      {
        nodeCache: cacheManager.getCache('listenbrainz').data,
        timeout: TIMEOUT_MS,
      }
    );
  }

  /** Albums released in the last `days` days. */
  public getFreshReleases({
    days = 14,
    sort = 'release_date',
  }: {
    days?: number;
    sort?:
      | 'release_date'
      | 'artist_credit_name'
      | 'release_name'
      | 'confidence';
  } = {}): Promise<LbFreshReleasesResponse> {
    return this.get<LbFreshReleasesResponse>(
      '/explore/fresh-releases',
      { params: { days, sort, past: true, future: false } },
      TTL_SECONDS,
      { keep: (data) => listed(data?.payload?.releases) }
    );
  }

  /**
   * Similar artists, most alike first; empty for little-played artists.
   * Labs API only (LISTENBRAINZ_LABS_URL), one artist per call: it refuses
   * several.
   */
  public getSimilarArtists(artistMbid: string): Promise<LbSimilarArtist[]> {
    return this.get<LbSimilarArtist[]>(
      '/similar-artists/json',
      {
        params: {
          artist_mbids: artistMbid,
          algorithm: SIMILAR_ARTISTS_ALGORITHM,
        },
      },
      24 * 3600
    );
  }
}

export default ListenBrainzAPI;
