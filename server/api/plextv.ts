import type { WatchlistSort } from '@server/constants/watchlistSort';
import type { PlexDevice } from '@server/interfaces/api/plexInterfaces';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { randomUUID } from 'node:crypto';
import xml2js from 'xml2js';
import ExternalAPI from './externalapi';

interface PlexAccountResponse {
  user: PlexUser;
}

interface PlexUser {
  id: number;
  uuid: string;
  email: string;
  joined_at: string;
  username: string;
  title: string;
  thumb: string;
  hasPassword: boolean;
  authToken: string;
  subscription: {
    active: boolean;
    status: string;
    plan: string;
    features: string[];
  };
  roles: {
    roles: string[];
  };
  entitlements: string[];
}

interface ConnectionResponse {
  $: {
    protocol: string;
    address: string;
    port: string;
    uri: string;
    local: string;
  };
}

interface DeviceResponse {
  $: {
    name: string;
    product: string;
    productVersion: string;
    platform: string;
    platformVersion: string;
    device: string;
    clientIdentifier: string;
    createdAt: string;
    lastSeenAt: string;
    provides: string;
    owned: string;
    accessToken?: string;
    publicAddress?: string;
    httpsRequired?: string;
    synced?: string;
    relay?: string;
    dnsRebindingProtection?: string;
    natLoopbackSupported?: string;
    publicAddressMatches?: string;
    presence?: string;
    ownerID?: string;
    home?: string;
    sourceTitle?: string;
  };
  Connection: ConnectionResponse[];
}

interface ServerResponse {
  $: {
    id: string;
    serverId: string;
    machineIdentifier: string;
    name: string;
    lastSeenAt: string;
    numLibraries: string;
    owned: string;
    /** Every library is shared, including new ones. */
    allLibraries?: string;
  };
}

interface UsersResponse {
  MediaContainer: {
    User: {
      $: {
        id: string;
        title: string;
        username: string;
        email: string;
        thumb: string;
      };
      Server: ServerResponse[];
    }[];
  };
}

interface PlexSectionAttrs {
  id: string;
  key: string;
  title?: string;
  type?: string;
  shared?: string;
}

/** A library as plex.tv shares it. */
export interface PlexSharingSection {
  /** plex.tv's id, which shares list. */
  id: string;
  /** The server's own key. */
  key: string;
  title: string;
  /** movie, show, artist or photo. */
  type: string;
  /** Within a share: whether it is shared. */
  shared: boolean;
}

interface WatchlistResponse {
  MediaContainer: {
    totalSize: number;
    Metadata?: {
      ratingKey: string;
      /** Epoch seconds. */
      addedAt?: number;
    }[];
    /** Some replies list items here instead of Metadata. */
    Video?: {
      ratingKey: string;
      addedAt?: number;
    }[];
  };
}

type PlexMetadataItem = {
  ratingKey: string;
  type: 'movie' | 'show';
  title: string;
  Guid?: {
    id: `imdb://tt${number}` | `tmdb://${number}` | `tvdb://${number}`;
  }[];
};
interface MetadataResponse {
  // Missing from some malformed replies; the item is then skipped.
  MediaContainer?: {
    Metadata?: PlexMetadataItem[];
    Video?: PlexMetadataItem[];
  };
}

/** Plex's names for the watchlist orders. */
const PLEX_WATCHLIST_SORTS: Record<WatchlistSort, string> = {
  'added-desc': 'watchlistedAt:desc',
  'added-asc': 'watchlistedAt:asc',
  title: 'titleSort:asc',
};

/**
 * Whether a body is a real watchlist. Discover sometimes answers 200 without
 * a MediaContainer; caching that with its ETag pins it via If-None-Match, so
 * every later request gets a 304 until the cache expires.
 */
const isWatchlistResponse = (data: unknown): data is WatchlistResponse => {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const container = (data as { MediaContainer?: unknown }).MediaContainer;
  return (
    typeof container === 'object' &&
    container !== null &&
    !Array.isArray(container) &&
    typeof (container as { totalSize?: unknown }).totalSize === 'number'
  );
};

// Plex returns seconds; also accept milliseconds in case that changes.
const normalizeWatchlistedAt = (value: number | undefined): number | null => {
  if (value === undefined || value <= 0) {
    return null;
  }

  return value > 1e11 ? Math.floor(value / 1000) : value;
};

interface UserStateResponse {
  MediaContainer: {
    UserState?: {
      watchlistedAt?: number;
    }[];
  };
}

export interface PlexWatchlistItem {
  ratingKey: string;
  tmdbId: number;
  tvdbId?: number;
  type: 'movie' | 'show';
  title: string;
  /**
   * When the user watchlisted this. Undefined if Plex did not send it;
   * callers must not assume anything about age then.
   */
  addedAt?: Date;
}

export interface PlexWatchlistCache {
  /** Missing when Plex sent none; the next request then fetches fresh. */
  etag?: string;
  response: WatchlistResponse;
}

const USER_STATE_TIMEOUT_MS = 8000;
/** Cache TTL for watchlistedAt, in seconds. */
const USER_STATE_TTL_S = 15 * 60;

const PLEX_TV_TIMEOUT_MS = 20000;

class PlexTvAPI extends ExternalAPI {
  private authToken: string;

  constructor(authToken: string) {
    super(
      'https://plex.tv',
      {},
      {
        headers: {
          'X-Plex-Token': authToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        nodeCache: cacheManager.getCache('plextv').data,
        /*
         * Watchlist sync fetches metadata for every item of every user's
         * watchlist with bounded concurrency; without a timeout one hung
         * request holds its slot and stalls the sync (seerr-team/seerr#3235).
         */
        timeout: PLEX_TV_TIMEOUT_MS,
      }
    );

    this.authToken = authToken;
  }

  public async getDevices(): Promise<PlexDevice[]> {
    try {
      const devicesResp = await this.axios.get(
        '/api/resources?includeHttps=1',
        {
          transformResponse: [],
          responseType: 'text',
        }
      );
      const parsedXml = await xml2js.parseStringPromise(
        devicesResp.data as DeviceResponse
      );
      return parsedXml?.MediaContainer?.Device?.map((pxml: DeviceResponse) => ({
        name: pxml.$.name,
        product: pxml.$.product,
        productVersion: pxml.$.productVersion,
        platform: pxml.$?.platform,
        platformVersion: pxml.$?.platformVersion,
        device: pxml.$?.device,
        clientIdentifier: pxml.$.clientIdentifier,
        createdAt: new Date(parseInt(pxml.$?.createdAt, 10) * 1000),
        lastSeenAt: new Date(parseInt(pxml.$?.lastSeenAt, 10) * 1000),
        provides: pxml.$.provides.split(','),
        owned: pxml.$.owned == '1' ? true : false,
        accessToken: pxml.$?.accessToken,
        publicAddress: pxml.$?.publicAddress,
        publicAddressMatches:
          pxml.$?.publicAddressMatches == '1' ? true : false,
        httpsRequired: pxml.$?.httpsRequired == '1' ? true : false,
        synced: pxml.$?.synced == '1' ? true : false,
        relay: pxml.$?.relay == '1' ? true : false,
        dnsRebindingProtection:
          pxml.$?.dnsRebindingProtection == '1' ? true : false,
        natLoopbackSupported:
          pxml.$?.natLoopbackSupported == '1' ? true : false,
        presence: pxml.$?.presence == '1' ? true : false,
        ownerID: pxml.$?.ownerID,
        home: pxml.$?.home == '1' ? true : false,
        sourceTitle: pxml.$?.sourceTitle,
        connection: pxml?.Connection?.map((conn: ConnectionResponse) => ({
          protocol: conn.$.protocol,
          address: conn.$.address,
          port: parseInt(conn.$.port, 10),
          uri: conn.$.uri,
          local: conn.$.local == '1' ? true : false,
        })),
      }));
    } catch (e) {
      logger.error('Something went wrong getting the devices from plex.tv', {
        label: 'Plex.tv API',
        errorMessage: e.message,
      });
      throw new Error('Invalid auth token', { cause: e });
    }
  }

  /**
   * Whether this account owns the Plex server with this id, or (unless
   * ownedOnly) has it shared with them. False when plex.tv can't say.
   */
  public async reachesServer(
    machineId: string,
    { ownedOnly = false }: { ownedOnly?: boolean } = {}
  ): Promise<boolean> {
    try {
      const devices = await this.getDevices();
      return !!devices?.some(
        (device) =>
          device.clientIdentifier === machineId &&
          device.provides.includes('server') &&
          (!ownedOnly || device.owned)
      );
    } catch {
      return false;
    }
  }

  public async getUser(): Promise<PlexUser> {
    try {
      const account = await this.axios.get<PlexAccountResponse>(
        '/users/account.json'
      );

      return account.data.user;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the account from plex.tv: ${e.message}`,
        { label: 'Plex.tv API' }
      );
      throw new Error('Invalid auth token', { cause: e });
    }
  }

  public async checkUserAccess(userId: number): Promise<boolean> {
    const settings = getSettings();

    try {
      if (!settings.plex.machineId) {
        throw new Error('Plex is not configured!');
      }

      const usersResponse = await this.getUsers();

      const users = usersResponse.MediaContainer.User;

      const user = users.find((u) => parseInt(u.$.id) === userId);

      if (!user) {
        throw new Error(
          "This user does not exist on the main Plex account's shared list"
        );
      }

      return !!user.Server?.find(
        (server) => server.$.machineIdentifier === settings.plex.machineId
      );
    } catch (e) {
      logger.error(`Error checking user access: ${e.message}`);
      return false;
    }
  }

  public async getUsers(): Promise<UsersResponse> {
    const response = await this.axios.get('/api/users', {
      transformResponse: [],
      responseType: 'text',
    });

    const parsedXml = (await xml2js.parseStringPromise(
      response.data
    )) as UsersResponse;
    return parsedXml;
  }

  public async getWatchlist({
    offset = 0,
    size = 20,
    sort,
  }: {
    offset?: number;
    size?: number;
    /** Plex's own order when none is given. */
    sort?: WatchlistSort;
  } = {}): Promise<{
    offset: number;
    size: number;
    totalSize: number;
    items: PlexWatchlistItem[];
    /**
     * Plex rejected the token. Distinct from an empty watchlist: only
     * signing in again fixes it.
     */
    authFailed?: boolean;
    /**
     * The watchlist could not be read for another reason (Plex down,
     * timeout). Says nothing about the token.
     */
    failed?: boolean;
  }> {
    try {
      // Cache per page: one page's ETag says nothing of another's, and a 304
      // for one must not serve another.
      const cacheKey = `${this.authToken}:${offset}:${size}${
        sort ? `:${sort}` : ''
      }`;
      const watchlistCache = cacheManager.getCache('plexwatchlist');
      let cachedWatchlist =
        watchlistCache.data.get<PlexWatchlistCache>(cacheKey);

      const response = await this.axios.get<WatchlistResponse>(
        '/library/sections/watchlist/all',
        {
          params: {
            'X-Plex-Container-Start': offset,
            'X-Plex-Container-Size': size,
            ...(sort && { sort: PLEX_WATCHLIST_SORTS[sort] }),
          },
          headers: cachedWatchlist?.etag
            ? { 'If-None-Match': cachedWatchlist.etag }
            : undefined,
          baseURL: 'https://discover.provider.plex.tv',
          validateStatus: (status) => status < 400, // Allow HTTP 304 to return without error
        }
      );

      // A 2xx replaces the cached watchlist, unless the body is not a
      // watchlist: that is never cached, so it cannot be pinned, and the last
      // good one (if any) is used.
      if (response.status >= 200 && response.status <= 299) {
        if (isWatchlistResponse(response.data)) {
          cachedWatchlist = {
            etag: response.headers.etag,
            response: response.data,
          };

          watchlistCache.data.set<PlexWatchlistCache>(
            cacheKey,
            cachedWatchlist
          );
        } else {
          logger.warn(
            'Plex sent a watchlist reply with no watchlist in it; using the last one it sent, if any',
            {
              label: 'Plex.TV Metadata API',
              status: response.status,
              hasCachedWatchlist: !!cachedWatchlist,
            }
          );
        }
      }

      // One metadata request per item. Firing all at once times out against
      // discover.provider.plex.tv on large watchlists, so keep few in flight
      // (seerr-team/seerr#3235). Upstream #3406: some replies use Video.
      const listed = cachedWatchlist?.response.MediaContainer;
      const watchlistItems = Array.isArray(listed?.Metadata)
        ? listed.Metadata
        : Array.isArray(listed?.Video)
          ? listed.Video
          : [];
      const watchlistDetails = await mapWithConcurrency(
        watchlistItems,
        5,
        async (watchlistItem) => {
          let detailedResponse: MetadataResponse;
          try {
            detailedResponse = await this.getRolling<MetadataResponse>(
              `/library/metadata/${watchlistItem.ratingKey}`,
              {
                baseURL: 'https://discover.provider.plex.tv',
              }
            );
          } catch (e) {
            if (e.response?.status === 404) {
              logger.warn(
                `Item with ratingKey ${watchlistItem.ratingKey} not found, it may have been removed from the server.`,
                { label: 'Plex.TV Metadata API' }
              );
              return null;
            }

            /*
             * Skip an item on a timeout or Plex-side error so it doesn't abort
             * every user's sync; the next sync retries it. An auth failure
             * stops the run, since every remaining request would fail too.
             */
            const status = e.response?.status;
            const isAuthFailure = status === 401 || status === 403;

            if (!isAuthFailure) {
              logger.warn(
                `Could not read metadata for ratingKey ${watchlistItem.ratingKey}; skipping it this run.`,
                {
                  label: 'Plex.TV Metadata API',
                  errorMessage: e instanceof Error ? e.message : String(e),
                  status,
                }
              );

              return null;
            }

            throw e;
          }

          const metadata =
            detailedResponse.MediaContainer?.Metadata?.[0] ??
            detailedResponse.MediaContainer?.Video?.[0];

          if (!metadata) {
            logger.warn(
              `Item with ratingKey ${watchlistItem.ratingKey} returned no metadata, skipping.`,
              { label: 'Plex.TV Metadata API' }
            );
            return null;
          }

          const tmdbString = metadata.Guid?.find((guid) =>
            guid.id.startsWith('tmdb')
          );
          const tvdbString = metadata.Guid?.find((guid) =>
            guid.id.startsWith('tvdb')
          );

          return {
            ratingKey: metadata.ratingKey,
            // Can be missing; 0s are filtered out afterwards.
            tmdbId: tmdbString ? Number(tmdbString.id.split('//')[1]) : 0,
            tvdbId: tvdbString
              ? Number(tvdbString.id.split('//')[1])
              : undefined,
            title: metadata.title,
            type: metadata.type,
            // Plex sends epoch seconds on the watchlist entry, not the
            // metadata.
            addedAt: watchlistItem.addedAt
              ? new Date(watchlistItem.addedAt * 1000)
              : undefined,
          };
        }
      );

      const filteredList = watchlistDetails.filter(
        (detail) => detail?.tmdbId
      ) as PlexWatchlistItem[];

      return {
        offset,
        size,
        totalSize: cachedWatchlist?.response.MediaContainer.totalSize ?? 0,
        items: filteredList,
      };
    } catch (e) {
      const status = e.response?.status;

      /*
       * The user's Plex token is invalid; only signing in again fixes it.
       * lib/plexReauth warns once when first noticed, so log at debug here.
       */
      if (status === 401 || status === 403) {
        logger.debug(
          "Plex rejected this user's token; their watchlist will not sync until they sign in again",
          {
            label: 'Plex.TV Metadata API',
            status,
          }
        );
      } else {
        logger.error('Failed to retrieve watchlist items', {
          label: 'Plex.TV Metadata API',
          errorMessage: e.message,
          status,
        });
      }

      return {
        offset,
        size,
        totalSize: 0,
        items: [],
        authFailed: status === 401 || status === 403,
        failed: status !== 401 && status !== 403,
      };
    }
  }

  /**
   * When the user watchlisted this title, in Unix seconds. A re-add gets a
   * new time, which lets watchlist sync tell it from an entry it already
   * acted on.
   *
   * Not this.get(): ExternalAPI's cache key omits the auth token and would
   * serve one user's watchlist state to another.
   */
  public async getWatchlistedAt(ratingKey: string): Promise<number | null> {
    const watchlistCache = cacheManager.getCache('plexwatchlist');
    const cacheKey = `userstate:${this.authToken}:${ratingKey}`;
    const cached = watchlistCache.data.get<number | null>(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    try {
      const response = await this.axios.get<UserStateResponse>(
        `/library/metadata/${ratingKey}/userState`,
        {
          baseURL: 'https://discover.provider.plex.tv',
          // A slow answer holds up every title waiting on it in the sync.
          timeout: USER_STATE_TIMEOUT_MS,
        }
      );

      const watchlistedAt = normalizeWatchlistedAt(
        response.data.MediaContainer.UserState?.[0]?.watchlistedAt
      );

      // Cached longer than the watchlist: it only changes on a re-add, which
      // this then notices within 15 minutes.
      watchlistCache.data.set(cacheKey, watchlistedAt, USER_STATE_TTL_S);

      return watchlistedAt;
    } catch (e) {
      logger.warn('Failed to retrieve watchlist state for item', {
        label: 'Plex.TV Metadata API',
        ratingKey,
        errorMessage: e.message,
      });

      return null;
    }
  }

  /** Fetches and parses a plex.tv XML reply, uncached. */
  private async getXml<T>(path: string): Promise<T> {
    const response = await this.axios.get(path, {
      transformResponse: [],
      responseType: 'text',
    });
    return (await xml2js.parseStringPromise(response.data)) as T;
  }

  /**
   * A server's libraries with plex.tv's sharing ids, which shares list
   * instead of the server's own keys.
   */
  public async getSharingSections(
    machineId: string
  ): Promise<PlexSharingSection[]> {
    const parsed = await this.getXml<{
      MediaContainer?: { Server?: { Section?: { $: PlexSectionAttrs }[] }[] };
    }>(`/api/servers/${encodeURIComponent(machineId)}`);
    return (parsed.MediaContainer?.Server?.[0]?.Section ?? []).map(({ $ }) => ({
      id: $.id,
      key: $.key,
      title: $.title ?? '',
      type: $.type ?? '',
      shared: $.shared === '1',
    }));
  }

  /** A share's libraries, each marked shared or not. */
  public async getShareSections(
    machineId: string,
    shareId: string
  ): Promise<PlexSharingSection[]> {
    const parsed = await this.getXml<{
      MediaContainer?: {
        SharedServer?: { Section?: { $: PlexSectionAttrs }[] }[];
      };
    }>(
      `/api/servers/${encodeURIComponent(machineId)}/shared_servers/${encodeURIComponent(shareId)}`
    );
    return (parsed.MediaContainer?.SharedServer?.[0]?.Section ?? []).map(
      ({ $ }) => ({
        id: $.id,
        key: $.key,
        title: $.title ?? '',
        type: $.type ?? '',
        shared: $.shared === '1',
      })
    );
  }

  /**
   * Shares exactly these libraries (plex.tv section ids) with someone the
   * server is already shared with.
   */
  public async setShareSections(
    machineId: string,
    shareId: string,
    sectionIds: string[]
  ): Promise<void> {
    await this.axios.put(
      `/api/servers/${encodeURIComponent(machineId)}/shared_servers/${encodeURIComponent(shareId)}`,
      {
        server_id: machineId,
        shared_server: {
          library_section_ids: sectionIds.map((id) => Number(id)),
        },
      },
      {
        headers: {
          'X-Plex-Client-Identifier': getSettings().clientId,
          'X-Plex-Product': 'Seerr AI',
        },
      }
    );
  }

  public async pingToken() {
    try {
      const response = await this.axios.get('/api/v2/ping', {
        headers: {
          'X-Plex-Client-Identifier': randomUUID(),
        },
      });
      if (!response?.data?.pong) {
        throw new Error('No pong response');
      }
    } catch (e) {
      logger.error('Failed to ping token', {
        label: 'Plex Refresh Token',
        errorMessage: e.message,
      });
    }
  }
}

export default PlexTvAPI;
