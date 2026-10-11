import type { User } from '@server/entity/User';
import type { TautulliSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { uniqWith } from 'lodash';

export interface TautulliHistoryRecord {
  date: number;
  duration: number;
  friendly_name: string;
  full_title: string;
  grandparent_rating_key: number;
  grandparent_title: string;
  original_title: string;
  group_count: number;
  group_ids?: string;
  guid: string;
  ip_address: string;
  live: number;
  machine_id: string;
  media_index: number;
  media_type: string;
  originally_available_at: string;
  parent_media_index: number;
  parent_rating_key: number;
  parent_title: string;
  paused_counter: number;
  percent_complete: number;
  platform: string;
  product: string;
  player: string;
  rating_key: number;
  reference_id?: number;
  row_id?: number;
  session_key?: string;
  started: number;
  state?: string;
  stopped: number;
  thumb: string;
  title: string;
  transcode_decision: string;
  user: string;
  user_id: number;
  watched_status: number;
  year: number;
}

interface TautulliHistoryResponse {
  response: {
    result: string;
    message?: string;
    data: {
      draw: number;
      recordsTotal: number;
      recordsFiltered: number;
      total_duration: string;
      filter_duration: string;
      data: TautulliHistoryRecord[];
    };
  };
}

interface TautulliWatchStats {
  query_days: number;
  total_time: number;
  total_plays: number;
}

interface TautulliWatchStatsResponse {
  response: {
    result: string;
    message?: string;
    data: TautulliWatchStats[];
  };
}

interface TautulliWatchUser {
  friendly_name: string;
  user_id: number;
  user_thumb: string;
  username: string;
  total_plays: number;
  total_time: number;
}

interface TautulliWatchUsersResponse {
  response: {
    result: string;
    message?: string;
    data: TautulliWatchUser[];
  };
}

interface TautulliInfo {
  tautulli_install_type: string;
  tautulli_version: string;
  tautulli_branch: string;
  tautulli_commit: string;
  tautulli_platform: string;
  tautulli_platform_release: string;
  tautulli_platform_version: string;
  tautulli_platform_linux_distro: string;
  tautulli_platform_device_name: string;
  tautulli_python_version: string;
}

interface TautulliInfoResponse {
  response: {
    result: string;
    message?: string;
    data: TautulliInfo;
  };
}

/** Longest to wait on Tautulli before giving up. */
const TAUTULLI_TIMEOUT_MS = 15000;

class TautulliAPI {
  private axios: AxiosInstance;

  constructor(settings: TautulliSettings) {
    this.axios = axios.create({
      baseURL: `${settings.useSsl ? 'https' : 'http'}://${settings.hostname}:${
        settings.port
      }${settings.urlBase ?? ''}`,
      params: { apikey: settings.apiKey },
      /*
       * Watch-list suggestions are checked while the user waits, so a
       * Tautulli that is down or unreachable must fail rather than leave the
       * request hanging indefinitely.
       */
      timeout: TAUTULLI_TIMEOUT_MS,
    });
    this.axios.interceptors.request.use(proxyRequestInterceptor);
    this.axios.interceptors.request.use(userAgentRequestInterceptor);
  }

  public async getInfo(): Promise<TautulliInfo> {
    try {
      return (
        await this.axios.get<TautulliInfoResponse>('/api/v2', {
          params: { cmd: 'get_tautulli_info' },
        })
      ).data.response.data;
    } catch (e) {
      logger.error('Something went wrong fetching Tautulli server info', {
        label: 'Tautulli API',
        errorMessage: e.message,
      });
      throw new Error(
        `[Tautulli] Failed to fetch Tautulli server info: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async getMediaWatchStats(
    ratingKey: string
  ): Promise<TautulliWatchStats[]> {
    try {
      return (
        await this.axios.get<TautulliWatchStatsResponse>('/api/v2', {
          params: {
            cmd: 'get_item_watch_time_stats',
            rating_key: ratingKey,
            grouping: 1,
          },
        })
      ).data.response.data;
    } catch (e) {
      logger.error(
        'Something went wrong fetching media watch stats from Tautulli',
        {
          label: 'Tautulli API',
          errorMessage: e.message,
          ratingKey,
        }
      );
      throw new Error(
        `[Tautulli] Failed to fetch media watch stats: ${e.message}`,
        { cause: e }
      );
    }
  }

  /**
   * Every play of one title, newest first: a film by its own rating key, a
   * series by the show's, which covers all of its episodes.
   */
  public async getTitleHistory(
    ratingKey: string,
    isShow: boolean
  ): Promise<TautulliHistoryRecord[]> {
    const response = await this.axios.get<TautulliHistoryResponse>('/api/v2', {
      params: {
        cmd: 'get_history',
        [isShow ? 'grandparent_rating_key' : 'rating_key']: ratingKey,
        order_column: 'date',
        order_dir: 'desc',
        length: 5000,
      },
    });
    return response.data.response.data.data ?? [];
  }

  /**
   * A user's plays, newest first: films and episodes, up to `length` of
   * them. One call, for the few features that need the whole picture of what
   * someone has watched rather than a handful of recent titles.
   */
  public async getUserHistory(
    user: User,
    length = 3000
  ): Promise<TautulliHistoryRecord[]> {
    if (!user.plexId) {
      return [];
    }
    const response = await this.axios.get<TautulliHistoryResponse>('/api/v2', {
      params: {
        cmd: 'get_history',
        user_id: user.plexId,
        media_type: 'movie,episode',
        order_column: 'date',
        order_dir: 'desc',
        length,
      },
    });
    return response.data.response.data.data ?? [];
  }

  public async getMediaWatchUsers(
    ratingKey: string
  ): Promise<TautulliWatchUser[]> {
    try {
      return (
        await this.axios.get<TautulliWatchUsersResponse>('/api/v2', {
          params: {
            cmd: 'get_item_user_stats',
            rating_key: ratingKey,
            grouping: 1,
          },
        })
      ).data.response.data;
    } catch (e) {
      logger.error(
        'Something went wrong fetching media watch users from Tautulli',
        {
          label: 'Tautulli API',
          errorMessage: e.message,
          ratingKey,
        }
      );
      throw new Error(
        `[Tautulli] Failed to fetch media watch users: ${e.message}`,
        { cause: e }
      );
    }
  }

  /**
   * Every play this user completed for one library item since a given time.
   *
   * getUserWatchHistory is capped and de-duplicated for the "recently
   * watched" display; this asks a narrow question instead — did this person
   * finish this title after a given moment — so it can be answered per item
   * without pulling their whole history.
   */
  public async getUserPlaysSince(
    user: User,
    {
      ratingKey,
      grandparentRatingKey,
      after,
      strict = false,
    }: {
      ratingKey?: string;
      grandparentRatingKey?: string;
      after: Date;
      /**
       * Throw instead of returning an empty list when Tautulli fails. An
       * empty list reads as "never watched", which is wrong when the truth is
       * "could not ask".
       */
      strict?: boolean;
    }
  ): Promise<TautulliHistoryRecord[]> {
    if (!user.plexId) {
      return [];
    }

    if (!ratingKey && !grandparentRatingKey) {
      return [];
    }

    const results: TautulliHistoryRecord[] = [];
    const take = 200;
    let start = 0;

    try {
      // Tautulli's `after` is a date, not a timestamp, so the exact cutoff is
      // applied below against each record's own date.
      const afterDate = new Date(after);
      const afterParam = `${afterDate.getFullYear()}-${String(
        afterDate.getMonth() + 1
      ).padStart(2, '0')}-${String(afterDate.getDate()).padStart(2, '0')}`;

      for (;;) {
        const page = (
          await this.axios.get<TautulliHistoryResponse>('/api/v2', {
            params: {
              cmd: 'get_history',
              grouping: 0,
              order_column: 'date',
              order_dir: 'desc',
              user_id: user.plexId,
              after: afterParam,
              length: take,
              start,
              ...(grandparentRatingKey
                ? { grandparent_rating_key: grandparentRatingKey }
                : { rating_key: ratingKey }),
            },
          })
        ).data.response.data.data;

        if (!page.length) {
          break;
        }

        results.push(...page);
        start += take;

        if (page.length < take) {
          break;
        }
      }

      const cutoff = Math.floor(after.getTime() / 1000);

      return results.filter((record) => record.date > cutoff);
    } catch (e) {
      logger.error('Failed to fetch plays from Tautulli', {
        label: 'Tautulli API',
        errorMessage: e.message,
        userId: user.id,
      });

      if (strict) {
        throw e;
      }

      return [];
    }
  }

  public async getUserWatchStats(user: User): Promise<TautulliWatchStats> {
    try {
      if (!user.plexId) {
        throw new Error('User does not have an associated Plex ID');
      }

      return (
        await this.axios.get<TautulliWatchStatsResponse>('/api/v2', {
          params: {
            cmd: 'get_user_watch_time_stats',
            user_id: user.plexId,
            query_days: 0,
            grouping: 1,
          },
        })
      ).data.response.data[0];
    } catch (e) {
      logger.error(
        'Something went wrong fetching user watch stats from Tautulli',
        {
          label: 'Tautulli API',
          errorMessage: e.message,
          user: user.displayName,
        }
      );
      throw new Error(
        `[Tautulli] Failed to fetch user watch stats: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async getUserWatchHistory(
    user: User
  ): Promise<TautulliHistoryRecord[]> {
    let results: TautulliHistoryRecord[] = [];

    try {
      if (!user.plexId) {
        throw new Error('User does not have an associated Plex ID');
      }

      const take = 100;
      let start = 0;

      while (results.length < 20) {
        const tautulliData = (
          await this.axios.get<TautulliHistoryResponse>('/api/v2', {
            params: {
              cmd: 'get_history',
              grouping: 1,
              order_column: 'date',
              order_dir: 'desc',
              user_id: user.plexId,
              media_type: 'movie,episode',
              length: take,
              start,
            },
          })
        ).data.response.data.data;

        if (!tautulliData.length) {
          return results;
        }

        results = uniqWith(results.concat(tautulliData), (recordA, recordB) =>
          recordA.grandparent_rating_key && recordB.grandparent_rating_key
            ? recordA.grandparent_rating_key === recordB.grandparent_rating_key
            : recordA.parent_rating_key && recordB.parent_rating_key
              ? recordA.parent_rating_key === recordB.parent_rating_key
              : recordA.rating_key === recordB.rating_key
        );

        start += take;
      }

      return results.slice(0, 20);
    } catch (e) {
      logger.error(
        'Something went wrong fetching user watch history from Tautulli',
        {
          label: 'Tautulli API',
          errorMessage: e.message,
          user: user.displayName,
        }
      );
      throw new Error(
        `[Tautulli] Failed to fetch user watch history: ${e.message}`,
        { cause: e }
      );
    }
  }
}

export default TautulliAPI;
