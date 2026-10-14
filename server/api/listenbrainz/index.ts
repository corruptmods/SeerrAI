import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import type {
  LbFreshReleasesResponse,
  LbTopArtistsResponse,
  LbTopReleaseGroupsResponse,
} from './interfaces';

/*
 * ListenBrainz, for music's Discover rows: new releases and what people
 * are listening to most, across everyone who uses it. No key is needed.
 * Each answer carries MusicBrainz ids, and covers come from the Cover Art
 * Archive by the ids it gives, so a row costs no MusicBrainz requests.
 */

export const LISTENBRAINZ_URL = 'https://api.listenbrainz.org/1';

/** Rows change slowly: six hours. */
const TTL_SECONDS = 6 * 3600;

const TIMEOUT_MS = 15_000;

export type LbRange = 'week' | 'month' | 'quarter' | 'year' | 'all_time';

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
      TTL_SECONDS
    );
  }

  /** The albums listened to most over the range. */
  public getTopReleaseGroups({
    range = 'week',
    count = 50,
    offset = 0,
  }: {
    range?: LbRange;
    count?: number;
    offset?: number;
  } = {}): Promise<LbTopReleaseGroupsResponse> {
    return this.get<LbTopReleaseGroupsResponse>(
      '/stats/sitewide/release-groups',
      { params: { range, count, offset } },
      TTL_SECONDS
    );
  }

  /** The artists listened to most over the range. */
  public getTopArtists({
    range = 'week',
    count = 50,
    offset = 0,
  }: {
    range?: LbRange;
    count?: number;
    offset?: number;
  } = {}): Promise<LbTopArtistsResponse> {
    return this.get<LbTopArtistsResponse>(
      '/stats/sitewide/artists',
      { params: { range, count, offset } },
      TTL_SECONDS
    );
  }
}

export default ListenBrainzAPI;
