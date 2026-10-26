/* eslint-disable @typescript-eslint/no-explicit-any */
import ExternalAPI from '@server/api/externalapi';
import { ApiErrorCode } from '@server/constants/error';
import type { JellyfinFamilyKind } from '@server/constants/server';
import { MediaServerType } from '@server/constants/server';
import availabilitySync from '@server/lib/availabilitySync';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { ApiError } from '@server/types/error';
import { getAppVersion } from '@server/utils/appVersion';

export interface JellyfinUserResponse {
  Name: string;
  ServerId: string;
  ServerName: string;
  Id: string;
  Configuration: {
    GroupedFolders: string[];
  };
  Policy: {
    IsAdministrator: boolean;
    IsDisabled?: boolean;
  };
  PrimaryImageTag?: string;
}

export interface JellyfinDevice {
  Id: string;
  Name: string;
  LastUserName: string;
  AppName: string;
  AppVersion: string;
  LastUserId: string;
  DateLastActivity: string;
  Capabilities: Record<string, unknown>;
}

export interface JellyfinDevicesResponse {
  Items: JellyfinDevice[];
  TotalRecordCount: number;
  StartIndex: number;
}

export interface JellyfinLoginResponse {
  User: JellyfinUserResponse;
  AccessToken: string;
}

export interface QuickConnectInitiateResponse {
  Secret: string;
  Code: string;
  DateAdded: string;
}

export interface QuickConnectStatusResponse {
  Authenticated: boolean;
  Secret: string;
  Code: string;
  DeviceId: string;
  DeviceName: string;
  AppName: string;
  AppVersion: string;
  DateAdded: string;
}

export interface JellyfinUserListResponse {
  users: JellyfinUserResponse[];
}

interface JellyfinMediaFolder {
  Name: string;
  Id: string;
  Type: string;
  CollectionType: string;
}

export interface JellyfinLibrary {
  /** 'music' only from getAllLibraries, apart from the others. */
  type: 'show' | 'movie' | 'music';
  key: string;
  title: string;
  agent: string;
}

export interface JellyfinLibraryItem {
  Name: string;
  Id: string;
  HasSubtitles: boolean;
  Type: 'Movie' | 'Episode' | 'Season' | 'Series';
  LocationType: 'FileSystem' | 'Offline' | 'Remote' | 'Virtual';
  /** The year, as the server has it; it names the title in the log. */
  ProductionYear?: number;
  SeriesName?: string;
  SeriesId?: string;
  SeasonId?: string;
  SeasonName?: string;
  IndexNumber?: number;
  IndexNumberEnd?: number;
  ParentIndexNumber?: number;
  MediaType: string;
}

export interface JellyfinMediaStream {
  Codec: string;
  Type: 'Video' | 'Audio' | 'Subtitle';
  Height?: number;
  Width?: number;
  AverageFrameRate?: number;
  RealFrameRate?: number;
  Language?: string;
  DisplayTitle: string;
}

export interface JellyfinMediaSource {
  Protocol: string;
  Id: string;
  Path: string;
  Type: string;
  VideoType: string;
  MediaStreams: JellyfinMediaStream[];
}

export interface JellyfinLibraryItemExtended extends JellyfinLibraryItem {
  ProviderIds: {
    Tmdb?: string;
    TheMovieDb?: string;
    Imdb?: string;
    Tvdb?: string;
    AniDB?: string;
  };
  MediaSources?: JellyfinMediaSource[];
  Width?: number;
  Height?: number;
  IsHD?: boolean;
  DateCreated?: string;
}

type EpisodeReturn<T> = T extends { includeMediaInfo: true }
  ? JellyfinLibraryItemExtended[]
  : JellyfinLibraryItem[];

/**
 * An album or artist in a music library. Its MusicBrainz ids come from the
 * files' tags: MusicBrainzReleaseGroup is the album's, MusicBrainzAlbum one
 * release's, MusicBrainzAlbumArtist and MusicBrainzArtist the artist's.
 */
export interface JellyfinMusicItem {
  Id: string;
  Name: string;
  Type: 'MusicAlbum' | 'MusicArtist';
  ProviderIds?: Record<string, string | undefined>;
  /** The album's or artist's folder. */
  Path?: string;
  DateCreated?: string;
  ProductionYear?: number;
  AlbumArtist?: string;
  AlbumArtists?: { Name: string; Id: string }[];
  /** An album's tracks, when the server gives them. */
  ChildCount?: number;
}

export interface JellyfinItemsReponse {
  Items: JellyfinLibraryItemExtended[];
  TotalRecordCount: number;
  StartIndex: number;
}

/**
 * Longest to wait on the server for watch history: asked while someone
 * waits on a page, so a server that is down must fail rather than hang.
 */
const WATCH_TIMEOUT_MS = 15_000;

/** What a person has done with an item: played, how far, and when last. */
export interface JellyfinUserData {
  Played?: boolean;
  PlayCount?: number;
  PlayedPercentage?: number | null;
  PlaybackPositionTicks?: number;
  LastPlayedDate?: string | null;
}

/** An item as one person sees it, with their own play state. */
export interface JellyfinUserItem extends JellyfinLibraryItem {
  ProductionYear?: number;
  UserData?: JellyfinUserData;
  ProviderIds?: JellyfinLibraryItemExtended['ProviderIds'];
  Path?: string;
  /** How long it runs, in ticks of a ten-millionth of a second. */
  RunTimeTicks?: number;
}

/** A movie, series, episode or album, as the check of a match reads it. */
export type JellyfinMatchItem = JellyfinUserItem &
  Pick<JellyfinMusicItem, 'AlbumArtist' | 'AlbumArtists'> & {
    Type: string;
  };

export interface JellyfinUserItemsResponse {
  Items: JellyfinUserItem[];
  TotalRecordCount: number;
}

/** One device's session, as /Sessions lists it. */
export interface JellyfinSession {
  UserId?: string;
  UserName?: string;
  DeviceName?: string;
  NowPlayingItem?: {
    Type?: string;
    /** The film's, or the episode's. */
    Id: string;
    Name?: string;
    SeriesId?: string;
    SeriesName?: string;
    /** An episode's season and number. */
    ParentIndexNumber?: number;
    IndexNumber?: number;
  };
  PlayState?: { IsPaused?: boolean };
}

/** One account on the server, with whether it is switched off. */
export interface JellyfinAccount {
  Name: string;
  Id: string;
  Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean };
}

class JellyfinAPI extends ExternalAPI {
  private userId?: string;
  /** Jellyfin and Emby differ in a few places; this says which it is. */
  public readonly kind: JellyfinFamilyKind;

  /**
   * `kind` is the server being spoken to. Left out, it is the primary
   * server's when that is Emby, else Jellyfin.
   */
  constructor(
    jellyfinHost: string,
    authToken?: string | null,
    deviceId?: string | null,
    kind?: JellyfinFamilyKind
  ) {
    const settings = getSettings();
    const serverKind: JellyfinFamilyKind =
      kind ??
      (settings.main.mediaServerType === MediaServerType.EMBY
        ? 'emby'
        : 'jellyfin');
    const safeDeviceId =
      deviceId && deviceId.length > 0
        ? deviceId
        : Buffer.from('BOT_seerr').toString('base64');

    const version = serverKind === 'emby' ? '1.0.0' : getAppVersion();

    let authHeaderVal = `MediaBrowser Client="Seerr", Device="Seerr", DeviceId="${safeDeviceId}", Version="${version}"`;
    if (authToken) {
      authHeaderVal += `, Token="${authToken}"`;
    }

    super(
      jellyfinHost,
      {},
      {
        headers: {
          Authorization: authHeaderVal,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    this.kind = serverKind;
  }

  /** Jellyfin or Emby, as the log names the server spoken to. */
  private get serverName(): string {
    return this.kind === 'emby' ? 'Emby' : 'Jellyfin';
  }

  public async login(
    Username?: string,
    Password?: string,
    ClientIP?: string
  ): Promise<JellyfinLoginResponse> {
    const authenticate = async (useHeaders: boolean) => {
      const headers =
        useHeaders && ClientIP ? { 'X-Forwarded-For': ClientIP } : {};

      return this.post<JellyfinLoginResponse>(
        '/Users/AuthenticateByName',
        {
          Username,
          Pw: Password,
        },
        { headers }
      );
    };

    try {
      return await authenticate(true);
    } catch (e) {
      logger.debug('Failed to authenticate with headers', {
        label: `${this.serverName} API`,
        error: e.response?.statusText,
        ip: ClientIP,
      });

      if (!e.response?.status) {
        throw new ApiError(404, ApiErrorCode.InvalidUrl);
      }

      if (e.response?.status === 401) {
        throw new ApiError(e.response?.status, ApiErrorCode.InvalidCredentials);
      }
    }

    try {
      return await authenticate(false);
    } catch (e) {
      if (e.response?.status === 401) {
        throw new ApiError(e.response?.status, ApiErrorCode.InvalidCredentials);
      }

      logger.error(
        `Something went wrong while authenticating with the ${this.serverName} server: ${e.message}`,
        {
          label: `${this.serverName} API`,
          error: e.response?.status,
          ip: ClientIP,
        }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }
  }

  public async initiateQuickConnect(): Promise<QuickConnectInitiateResponse> {
    try {
      const response = await this.post<QuickConnectInitiateResponse>(
        '/QuickConnect/Initiate'
      );

      return response;
    } catch (e) {
      logger.error(
        `Something went wrong while initiating Quick Connect: ${e.message}`,
        { label: `${this.serverName} API`, error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }
  }

  public async checkQuickConnect(
    secret: string
  ): Promise<QuickConnectStatusResponse> {
    try {
      const response = await this.get<QuickConnectStatusResponse>(
        '/QuickConnect/Connect',
        { params: { secret } }
      );

      return response;
    } catch (e) {
      logger.error(
        `Something went wrong while getting Quick Connect status: ${e.message}`,
        { label: `${this.serverName} API`, error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }
  }

  public async authenticateQuickConnect(
    secret: string
  ): Promise<JellyfinLoginResponse> {
    try {
      const response = await this.post<JellyfinLoginResponse>(
        '/Users/AuthenticateWithQuickConnect',
        { Secret: secret }
      );
      return response;
    } catch (e) {
      logger.error(
        `Something went wrong while authenticating with Quick Connect: ${e.message}`,
        { label: `${this.serverName} API`, error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }
  }

  public setUserId(userId: string): void {
    this.userId = userId;
    return;
  }

  public async getSystemInfo(): Promise<any> {
    try {
      const systemInfoResponse = await this.get<any>('/System/Info');

      return systemInfoResponse;
    } catch (e) {
      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getServerName(): Promise<string> {
    try {
      const serverResponse = await this.get<JellyfinUserResponse>(
        '/System/Info/Public'
      );

      return serverResponse.ServerName;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the server name from the ${this.serverName} server: ${e.message}`,
        { label: `${this.serverName} API`, error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }
  }

  public async getUsers(): Promise<JellyfinUserListResponse> {
    try {
      const userReponse = await this.get<JellyfinUserResponse[]>(`/Users`);

      return { users: userReponse };
    } catch (e) {
      logger.error(
        `Something went wrong while getting the account from the ${this.serverName} server: ${e.message}`,
        { label: `${this.serverName} API`, error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  /**
   * Every device's session, with what each is playing. Needs the server's
   * API key; never cached.
   */
  public async getSessions(): Promise<JellyfinSession[]> {
    const sessions = await this.get<JellyfinSession[]>(
      '/Sessions',
      undefined,
      0
    );
    return Array.isArray(sessions) ? sessions : [];
  }

  public async getUser(): Promise<JellyfinUserResponse> {
    try {
      const userReponse = await this.get<JellyfinUserResponse>(
        `/Users/${this.userId ?? 'Me'}`
      );
      return userReponse;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the account from the ${this.serverName} server: ${e.message}`,
        { label: `${this.serverName} API`, error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  /** The server's libraries, as folders with their kind. */
  private async getMediaFolders(): Promise<JellyfinMediaFolder[]> {
    try {
      const mediaFolderResponse = await this.get<any>(`/Library/MediaFolders`);

      return mediaFolderResponse.Items;
    } catch {
      // fallback to user views to get libraries
      // this only and maybe/depending on factors affects LDAP users
      try {
        const mediaFolderResponse = await this.get<any>(
          `/Users/${this.userId ?? 'Me'}/Views`
        );

        return mediaFolderResponse.Items;
      } catch (e) {
        logger.error(
          `Something went wrong while getting libraries from the ${this.serverName} server: ${e.message}`,
          {
            label: `${this.serverName} API`,
            error: e.response?.status,
          }
        );

        if (!e.response) {
          throw new ApiError(502, ApiErrorCode.ConnectionError);
        }

        return [];
      }
    }
  }

  public async getLibraries(): Promise<JellyfinLibrary[]> {
    return this.mapLibraries(await this.getMediaFolders());
  }

  /**
   * The film and series libraries, and apart from them the music ones,
   * from one look at the server.
   */
  public async getAllLibraries(): Promise<{
    libraries: JellyfinLibrary[];
    musicLibraries: JellyfinLibrary[];
  }> {
    const folders = await this.getMediaFolders();
    return {
      libraries: this.mapLibraries(folders),
      musicLibraries: folders
        .filter(
          (folder) =>
            folder.Type === 'CollectionFolder' &&
            folder.CollectionType === 'music'
        )
        .map((folder) => ({
          key: folder.Id,
          title: folder.Name,
          type: 'music',
          agent: 'jellyfin',
        })),
    };
  }

  private mapLibraries(mediaFolders: JellyfinMediaFolder[]): JellyfinLibrary[] {
    const excludedTypes = [
      'music',
      'books',
      'musicvideos',
      'homevideos',
      'boxsets',
    ];

    return mediaFolders
      .filter((Item: JellyfinMediaFolder) => {
        return (
          Item.Type === 'CollectionFolder' &&
          !excludedTypes.includes(Item.CollectionType)
        );
      })
      .map((Item: JellyfinMediaFolder) => {
        return <JellyfinLibrary>{
          key: Item.Id,
          title: Item.Name,
          type: Item.CollectionType === 'movies' ? 'movie' : 'show',
          agent: 'jellyfin',
        };
      });
  }

  public async getLibraryContents(id: string): Promise<JellyfinLibraryItem[]> {
    try {
      const libraryItemsResponse = await this.get<any>(
        `/Items?SortBy=SortName&SortOrder=Ascending&IncludeItemTypes=Series,Movie,Others&Recursive=true&StartIndex=0&ParentId=${id}&collapseBoxSetItems=false`
      );

      return libraryItemsResponse.Items.filter(
        (item: JellyfinLibraryItem) => item.LocationType !== 'Virtual'
      );
    } catch (e) {
      logger.error(
        `Something went wrong while getting library content from the ${this.serverName} server: ${e.message}`,
        { label: `${this.serverName} API`, error: e?.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getRecentlyAdded(id: string): Promise<JellyfinLibraryItem[]> {
    try {
      const endpoint =
        this.kind === 'jellyfin'
          ? `/Items/Latest`
          : `/Users/${this.userId}/Items/Latest`;
      const itemResponse = await this.get<any>(
        `${endpoint}?Limit=12&ParentId=${id}${
          this.kind === 'jellyfin' ? `&userId=${this.userId ?? 'Me'}` : ''
        }`
      );

      return itemResponse;
    } catch (e) {
      logger.error(
        `Something went wrong while getting library content from the ${this.serverName} server: ${e.message}`,
        { label: `${this.serverName} API`, error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getItemData(
    id: string
  ): Promise<JellyfinLibraryItemExtended | undefined> {
    try {
      const itemResponse = await this.get<JellyfinItemsReponse>(`/Items`, {
        params: {
          ids: id,
          fields: 'ProviderIds,MediaSources,Width,Height,IsHD,DateCreated',
        },
      });

      return itemResponse.Items?.[0];
    } catch (e) {
      if (availabilitySync.running) {
        if (e.response?.status === 500) {
          return undefined;
        }
      }

      logger.error(
        `Something went wrong while getting library content from the ${this.serverName} server: ${e.message}`,
        { label: `${this.serverName} API`, error: e.response?.status }
      );
      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getSeasons(seriesID: string): Promise<JellyfinLibraryItem[]> {
    try {
      const seasonResponse = await this.get<any>(`/Shows/${seriesID}/Seasons`);

      return seasonResponse.Items;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the list of seasons from the ${this.serverName} server: ${e.message}`,
        { label: `${this.serverName} API`, error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getEpisodes<
    T extends { includeMediaInfo?: boolean } | undefined = undefined,
  >(
    seriesID: string,
    seasonID: string,
    options?: T
  ): Promise<EpisodeReturn<T>> {
    try {
      const episodeResponse = await this.get<any>(
        `/Shows/${seriesID}/Episodes`,
        {
          params: {
            seasonId: seasonID,
            ...(options?.includeMediaInfo && { fields: 'MediaSources' }),
          },
        }
      );

      return episodeResponse.Items.filter(
        (item: JellyfinLibraryItem) => item.LocationType !== 'Virtual'
      );
    } catch (e) {
      logger.error(
        `Something went wrong while getting the list of episodes from the ${this.serverName} server: ${e.message}`,
        { label: `${this.serverName} API`, error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  /**
   * Items as one person sees them, with their own play state. Both
   * Jellyfin and Emby answer /Items with a UserId, so one call serves both;
   * errors are left to the caller, which knows whether "no answer" may be
   * read as "nothing".
   */
  public async getUserItems(
    userId: string,
    params: Record<string, string | number | boolean>
  ): Promise<JellyfinUserItemsResponse> {
    const response = await this.get<JellyfinUserItemsResponse>('/Items', {
      params: { UserId: userId, EnableUserData: true, ...params },
      timeout: WATCH_TIMEOUT_MS,
    });
    return {
      Items: response?.Items ?? [],
      TotalRecordCount: response?.TotalRecordCount ?? 0,
    };
  }

  /**
   * One page of a library's movies or series, with their paths and the ids
   * the server matched them to.
   */
  public async getLibraryPage(
    libraryId: string,
    type: 'Movie' | 'Series',
    start: number,
    limit: number
  ): Promise<JellyfinUserItemsResponse> {
    const response = await this.get<JellyfinUserItemsResponse>('/Items', {
      params: {
        ParentId: libraryId,
        Recursive: true,
        IncludeItemTypes: type,
        Fields: 'Path,ProviderIds,ProductionYear',
        SortBy: 'SortName',
        StartIndex: start,
        Limit: limit,
      },
    });
    return {
      Items: response?.Items ?? [],
      TotalRecordCount: response?.TotalRecordCount ?? 0,
    };
  }

  /**
   * Items to compare with Sonarr, Radarr or Lidarr: the newest of a
   * library's (by when the server added them), or those with these ids,
   * with their paths and the ids the server matched them to.
   */
  public async getMatchItems(
    query:
      | {
          libraryId: string;
          type: 'Movie' | 'Episode' | 'MusicAlbum';
          newest: number;
        }
      | { ids: string[] },
    timeout: number
  ): Promise<JellyfinMatchItem[]> {
    const params =
      'ids' in query
        ? { Ids: query.ids.join(',') }
        : {
            ParentId: query.libraryId,
            Recursive: true,
            IncludeItemTypes: query.type,
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Limit: query.newest,
          };
    const response = await this.get<{ Items?: JellyfinMatchItem[] }>('/Items', {
      params: {
        ...params,
        Fields: 'Path,ProviderIds,ProductionYear,DateCreated',
      },
      timeout,
    });
    return response?.Items ?? [];
  }

  /**
   * One page of a music library's albums and artists, with their folders
   * and MusicBrainz ids. Newest first when asked, for what was just added.
   */
  public async getMusicItems(
    libraryId: string,
    {
      start,
      limit,
      newestFirst = false,
    }: { start: number; limit: number; newestFirst?: boolean }
  ): Promise<{ Items: JellyfinMusicItem[]; TotalRecordCount: number }> {
    const response = await this.get<{
      Items?: JellyfinMusicItem[];
      TotalRecordCount?: number;
    }>('/Items', {
      params: {
        ParentId: libraryId,
        Recursive: true,
        IncludeItemTypes: 'MusicAlbum,MusicArtist',
        Fields: 'ProviderIds,Path,DateCreated,ChildCount',
        SortBy: newestFirst ? 'DateCreated,SortName' : 'SortName',
        SortOrder: newestFirst ? 'Descending' : 'Ascending',
        StartIndex: start,
        Limit: limit,
      },
    });
    return {
      Items: response?.Items ?? [],
      TotalRecordCount: response?.TotalRecordCount ?? 0,
    };
  }

  /** Every account on the server, the switched-off ones included. */
  public async getAccounts(): Promise<JellyfinAccount[]> {
    const accounts = await this.get<JellyfinAccount[]>('/Users', {
      timeout: WATCH_TIMEOUT_MS,
    });
    return Array.isArray(accounts) ? accounts : [];
  }

  /** One account, or undefined when the server no longer has it. */
  public async getAccount(id: string): Promise<JellyfinAccount | undefined> {
    try {
      return await this.get<JellyfinAccount>(
        `/Users/${encodeURIComponent(id)}`,
        { timeout: WATCH_TIMEOUT_MS }
      );
    } catch (e) {
      if (e.response?.status === 404 || e.response?.status === 400) {
        return undefined;
      }
      throw e;
    }
  }

  public async createApiToken(appName: string): Promise<string> {
    try {
      await this.post(`/Auth/Keys?App=${appName}`);
      const apiKeys = await this.get<any>(`/Auth/Keys`);
      return apiKeys.Items.reverse().find(
        (item: any) => item.AppName === appName
      ).AccessToken;
    } catch (e) {
      logger.error(
        `Something went wrong while creating an API key from the ${this.serverName} server: ${e.message}`,
        { label: `${this.serverName} API`, error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }
}

export default JellyfinAPI;
