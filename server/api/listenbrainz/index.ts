import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import type { LbFreshReleasesResponse, LbSimilarArtist } from './interfaces';

/*
 * ListenBrainz, for music's Discover rows: new releases and what people
 * are listening to most, across everyone who uses it. No key is needed.
 * Each answer carries MusicBrainz ids, and covers come from the Cover Art
 * Archive by the ids it gives, so a row costs no MusicBrainz requests.
 */

export const LISTENBRAINZ_URL = 'https://api.listenbrainz.org/1';

/** ListenBrainz's datasets that are not in its main API yet: similar artists. */
export const LISTENBRAINZ_LABS_URL = 'https://labs.api.listenbrainz.org';

/**
 * Which of ListenBrainz's similar-artist datasets: artists listened to in
 * the same sittings, over about twenty years of listens. Its own site uses
 * this one.
 */
const SIMILAR_ARTISTS_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

/** Rows change slowly: six hours. */
const TTL_SECONDS = 6 * 3600;

const TIMEOUT_MS = 15_000;

/**
 * Kept only with something in it: an empty answer kept would leave its row
 * empty for six hours, where asking again may well fill it.
 */
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
   * Artists listened to alongside this one, most alike first; none for an
   * artist too little listened to. Asked of the labs address
   * (LISTENBRAINZ_LABS_URL), one artist at a time: it refuses several.
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
