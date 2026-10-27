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

interface WatchlistResponse {
  MediaContainer: {
    totalSize: number;
    Metadata?: {
      ratingKey: string;
      /** Epoch seconds. Plex sends this; it was simply not read before. */
      addedAt?: number;
    }[];
    /** Where Plex puts the items in some replies, in place of Metadata. */
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
  // Missing from the odd malformed reply; the item is then skipped.
  MediaContainer?: {
    Metadata?: PlexMetadataItem[];
    Video?: PlexMetadataItem[];
  };
}

/**
 * Whether a watchlist reply is one. Discover sometimes answers 200 with a
 * body that is not (no MediaContainer); kept with its ETag, that body was
 * then pinned by If-None-Match, every later request got a 304 for it, and
 * the user's watchlist failed until the cache expired.
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

// Plex returns seconds, so fall back to a millisecond value if that ever changes.
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
   * When the user added this to their watchlist. Undefined if Plex did not
   * send it, in which case callers must not assume anything about age.
   */
  addedAt?: Date;
}

export interface PlexWatchlistCache {
  /** Missing when Plex sent none; the next request then asks afresh. */
  etag?: string;
  response: WatchlistResponse;
}

/** Longest to wait for when a title went on someone's watchlist. */
const USER_STATE_TIMEOUT_MS = 8000;
/** How long that is kept, in seconds. */
const USER_STATE_TTL_S = 15 * 60;

/** Longest to wait on a plex.tv request before giving up its slot. */
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
         * Watchlist sync fetches metadata for every item on every user's
         * watchlist. Bounding the concurrency stopped the flood, but without
         * a timeout one request that never answers holds its slot and stalls
         * the whole sync behind it (seerr-team/seerr#3235).
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
  }: { offset?: number; size?: number } = {}): Promise<{
    offset: number;
    size: number;
    totalSize: number;
    items: PlexWatchlistItem[];
    /**
     * Plex rejected the token. The caller needs to know this apart from an
     * empty watchlist: the user has to sign in again, and nothing else will
     * fix it.
     */
    authFailed?: boolean;
    /**
     * The watchlist could not be read for some other reason (Plex down, a
     * timeout). Says nothing about the token either way.
     */
    failed?: boolean;
  }> {
    try {
      // Each page of the watchlist kept apart: one page's tag says nothing
      // of another's, and a 304 for one must not answer with another.
      const cacheKey = `${this.authToken}:${offset}:${size}`;
      const watchlistCache = cacheManager.getCache('plexwatchlist');
      let cachedWatchlist =
        watchlistCache.data.get<PlexWatchlistCache>(cacheKey);

      const response = await this.axios.get<WatchlistResponse>(
        '/library/sections/watchlist/all',
        {
          params: {
            'X-Plex-Container-Start': offset,
            'X-Plex-Container-Size': size,
          },
          headers: cachedWatchlist?.etag
            ? { 'If-None-Match': cachedWatchlist.etag }
            : undefined,
          baseURL: 'https://discover.provider.plex.tv',
          validateStatus: (status) => status < 400, // Allow HTTP 304 to return without error
        }
      );

      // Anything but a 304 is a new watchlist, to keep in place of the
      // cached one, unless it is not a watchlist at all: that is never kept,
      // so it cannot be pinned, and the last good one (if any) is used.
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

      // One metadata request per watchlist item. Firing them all at once
      // times out against discover.provider.plex.tv on large watchlists, so
      // keep a small number in flight (seerr-team/seerr#3235).
      // Upstream #3406: some replies list the items under Video instead.
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
             * A timeout or a Plex-side error used to abort the whole sync,
             * so one unlucky item cost every other user their watchlist run.
             * Skip the item and carry on; the next sync picks it up.
             *
             * An auth failure is different — the token is wrong and every
             * remaining request will fail too, so that still stops the run.
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
            // This should always be set? But I guess it also cannot be?
            // We will filter out the 0's afterwards
            tmdbId: tmdbString ? Number(tmdbString.id.split('//')[1]) : 0,
            tvdbId: tvdbString
              ? Number(tvdbString.id.split('//')[1])
              : undefined,
            title: metadata.title,
            type: metadata.type,
            // Plex sends epoch seconds on the watchlist entry, not on the
            // metadata, so it comes from the item we looked up from.
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
       * A 401 means this user's Plex token is no longer valid — they need to
       * sign in again. It is not a fault anyone can fix from the server. It
       * is said once, as a warning, when first noticed (lib/plexReauth);
       * every later try only repeats it.
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
   * When the user put this title on their watchlist, in Unix seconds. Removing
   * it and adding it back gives a new time, which is how watchlist sync tells
   * a deliberate re-add from the entry it already acted on.
   *
   * Deliberately not this.get(): ExternalAPI's cache key omits the auth
   * token and would serve one user's watchlist state to another.
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
          // A small answer: one that has not come in this long is not
          // coming, and every title waiting on it holds up the sync.
          timeout: USER_STATE_TIMEOUT_MS,
        }
      );

      const watchlistedAt = normalizeWatchlistedAt(
        response.data.MediaContainer.UserState?.[0]?.watchlistedAt
      );

      // Kept longer than the watchlist itself: it only changes when the
      // title is taken off the watchlist and added back, which this then
      // notices within a quarter of an hour.
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
