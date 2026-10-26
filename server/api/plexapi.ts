import ExternalAPI, {
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '@server/api/externalapi';
import { ApiErrorCode } from '@server/constants/error';
import type { Library, MusicLibrary, PlexSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { ApiError } from '@server/types/error';

interface PlexStatusResponse {
  MediaContainer: {
    machineIdentifier: string;
    friendlyName: string;
  };
}

export interface PlexLibraryItem {
  ratingKey: string;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  title: string;
  year?: number;
  /** An episode's show. */
  grandparentTitle?: string;
  guid: string;
  parentGuid?: string;
  grandparentGuid?: string;
  addedAt: number;
  updatedAt: number;
  Guid?: {
    id: string;
  }[];
  type: 'movie' | 'show' | 'season' | 'episode';
  Media: Media[];
  /** A show's folders on disk. */
  Location?: { path: string }[];
}

interface PlexLibraryResponse {
  MediaContainer: {
    totalSize: number;
    Metadata: PlexLibraryItem[];
  };
}

export interface PlexLibrary {
  /** 'artist' is a music library. */
  type: 'show' | 'movie' | 'artist';
  key: string;
  title: string;
  agent: string;
}

interface PlexLibrariesResponse {
  MediaContainer: {
    Directory: PlexLibrary[];
  };
}

export interface PlexMetadata {
  ratingKey: string;
  parentRatingKey?: string;
  guid: string;
  type: 'movie' | 'show' | 'season';
  title: string;
  Guid: {
    id: string;
  }[];
  Children?: {
    size: 12;
    Metadata: PlexMetadata[];
  };
  index: number;
  parentIndex?: number;
  leafCount: number;
  viewedLeafCount: number;
  addedAt: number;
  updatedAt: number;
  Media: Media[];
}

interface Media {
  id: number;
  duration: number;
  bitrate: number;
  width: number;
  height: number;
  aspectRatio: number;
  audioChannels: number;
  audioCodec: string;
  videoCodec: string;
  videoResolution: string;
  container: string;
  videoFrameRate: string;
  videoProfile: string;
  /** The files it is, for a movie: where it sits on disk. */
  Part?: { file?: string }[];
}

interface PlexMetadataResponse {
  MediaContainer: {
    Metadata: PlexMetadata[];
  };
}

/** An artist, album or track in a music library. */
export interface PlexMusicItem {
  ratingKey: string;
  /** An album's artist; a track's album. */
  parentRatingKey?: string;
  type: 'artist' | 'album' | 'track';
  title: string;
  /** An album's artist, by name. */
  parentTitle?: string;
  year?: number;
  addedAt?: number;
  /** An album's tracks in the library. */
  leafCount?: number;
  /**
   * The ids its agent matched it to. With Plex's music agent an artist has
   * `mbid://<artist>` and an album `mbid://<id>`, which may be the album's
   * (release group) or one release's.
   */
  Guid?: { id: string }[];
  /** An artist's folders on disk, when Plex gives them. */
  Location?: { path: string }[];
  /** A track's files. */
  Media?: { Part?: { file?: string }[] }[];
}

interface PlexMusicResponse {
  MediaContainer: {
    totalSize?: number;
    Metadata?: PlexMusicItem[];
  };
}

/** One thing playing on the server, as /status/sessions lists it. */
export interface PlexSession {
  type: string;
  /** The film's, or the episode's. */
  ratingKey: string;
  /** An episode's series. */
  grandparentRatingKey?: string;
  title?: string;
  grandparentTitle?: string;
  /** An episode's season and number. */
  parentIndex?: number;
  index?: number;
  /** Who is watching: their plex.tv id, or "1" for the server's owner. */
  User?: { id?: string; title?: string };
  Player?: { state?: string; title?: string };
}

interface PlexSessionsResponse {
  MediaContainer: { size?: number; Metadata?: PlexSession[] };
}

/** Plex's numbers for the kinds of music item, in its listings. */
const PLEX_MUSIC_TYPE = { artist: 8, album: 9 } as const;

const RECENT_PAGE_SIZE = 500;
/** A bound on one recently added read, should a window be very wide. */
const RECENT_MAX_ITEMS = 5000;

class PlexAPI extends ExternalAPI {
  constructor({
    plexToken,
    plexSettings,
    timeout,
  }: {
    plexToken?: string | null;
    plexSettings?: PlexSettings;
    timeout?: number;
  }) {
    const settings = getSettings();
    const settingsPlex = plexSettings ?? settings.plex;

    const protocol = settingsPlex.useSsl ? 'https' : 'http';
    const baseUrl = `${protocol}://${settingsPlex.ip}:${settingsPlex.port}`;

    super(
      baseUrl,
      {},
      {
        timeout: timeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
        headers: {
          'X-Plex-Token': plexToken ?? '',
          'X-Plex-Client-Identifier': settings.clientId,
          'X-Plex-Product': 'Seerr AI',
          'X-Plex-Device-Name': 'Seerr AI',
          'X-Plex-Platform': 'Seerr AI',
        },
      }
    );
  }

  public async getStatus(): Promise<PlexStatusResponse> {
    return await this.get('/');
  }

  public async getLibraries(): Promise<PlexLibrary[]> {
    const response = await this.get<PlexLibrariesResponse>('/library/sections');

    return response.MediaContainer.Directory;
  }

  public async syncLibraries(): Promise<void> {
    const settings = getSettings();

    try {
      const libraries = await this.getLibraries();

      const newLibraries = libraries
        // Remove libraries that are not movie or show
        .filter(
          (library) => library.type === 'movie' || library.type === 'show'
        )
        // Remove libraries that do not have a metadata agent set (usually personal video libraries)
        .filter((library) => library.agent !== 'com.plexapp.agents.none')
        .map((library): Library => {
          const existing = settings.plex.libraries.find(
            (l) => l.id === library.key
          );

          return {
            id: library.key,
            name: library.title,
            enabled: existing?.enabled ?? false,
            type: library.type as Library['type'],
            lastScan: existing?.lastScan,
          };
        });

      settings.plex.libraries = newLibraries;
      // Music libraries are kept apart. Any agent counts, none included:
      // albums are found by folder and title too.
      settings.plex.musicLibraries = libraries
        .filter((library) => library.type === 'artist')
        .map((library): MusicLibrary => {
          const existing = (settings.plex.musicLibraries ?? []).find(
            (l) => l.id === library.key
          );
          return {
            id: library.key,
            name: library.title,
            enabled: existing?.enabled ?? false,
            type: 'artist',
            lastScan: existing?.lastScan,
          };
        });
    } catch (e) {
      logger.error('Failed to fetch Plex libraries', {
        label: 'Plex API',
        message: e.message,
      });

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }

    await settings.save();
  }

  public async getLibraryContents(
    id: string,
    { offset = 0, size = 50 }: { offset?: number; size?: number } = {}
  ): Promise<{ totalSize: number; items: PlexLibraryItem[] }> {
    const response = await this.get<PlexLibraryResponse>(
      `/library/sections/${id}/all?includeGuids=1`,
      {
        headers: {
          'X-Plex-Container-Start': `${offset}`,
          'X-Plex-Container-Size': `${size}`,
        },
      }
    );

    return {
      totalSize: response.MediaContainer.totalSize,
      items: response.MediaContainer.Metadata ?? [],
    };
  }

  public async getMetadata(
    key: string,
    options: { includeChildren?: boolean } = {}
  ): Promise<PlexMetadata> {
    const response = await this.get<PlexMetadataResponse>(
      `/library/metadata/${key}${
        options.includeChildren ? '?includeChildren=1' : ''
      }`
    );

    return response.MediaContainer.Metadata[0];
  }

  /**
   * One movie or show as a library listing gives it: the ids it is matched
   * to, a movie's files and a show's folders. Undefined once it is gone.
   */
  public async getMatchItem(
    ratingKey: string
  ): Promise<PlexLibraryItem | undefined> {
    try {
      const response = await this.get<PlexLibraryResponse>(
        `/library/metadata/${ratingKey}?includeGuids=1`
      );
      return response.MediaContainer.Metadata?.[0];
    } catch (e) {
      if (e.response?.status === 404) return undefined;
      throw e;
    }
  }

  public async getChildrenMetadata(key: string): Promise<PlexMetadata[]> {
    const response = await this.get<PlexMetadataResponse>(
      `/library/metadata/${key}/children`
    );

    return response.MediaContainer.Metadata;
  }

  /**
   * Everything added to a library since a time, newest first. Read a page
   * at a time, so a busy day (a whole series imported at once) is not cut
   * off at the first page.
   */
  public async getRecentlyAdded(
    id: string,
    options: { addedAt: number } = {
      addedAt: Date.now() - 1000 * 60 * 60,
    },
    mediaType: 'movie' | 'show'
  ): Promise<PlexLibraryItem[]> {
    const items: PlexLibraryItem[] = [];
    for (let start = 0; start < RECENT_MAX_ITEMS; start += RECENT_PAGE_SIZE) {
      const response = await this.get<PlexLibraryResponse>(
        `/library/sections/${id}/all?type=${mediaType === 'show' ? '4' : '1'}${
          // Shows are queried as episodes, whose guids the scanner never reads.
          mediaType === 'movie' ? '&includeGuids=1' : ''
        }&sort=addedAt%3Adesc&addedAt>>=${Math.floor(options.addedAt / 1000)}`,
        {
          headers: {
            'X-Plex-Container-Start': String(start),
            'X-Plex-Container-Size': String(RECENT_PAGE_SIZE),
          },
        }
      );
      const page = response.MediaContainer.Metadata ?? [];
      items.push(...page);
      if (page.length < RECENT_PAGE_SIZE) break;
    }
    return items;
  }

  /**
   * One page of a music library's artists or albums, with the ids Plex
   * matched them to.
   */
  public async getMusicItems(
    sectionId: string,
    type: 'artist' | 'album',
    { offset = 0, size = RECENT_PAGE_SIZE }: { offset?: number; size?: number }
  ): Promise<{ totalSize: number; items: PlexMusicItem[] }> {
    const response = await this.get<PlexMusicResponse>(
      `/library/sections/${sectionId}/all?type=${PLEX_MUSIC_TYPE[type]}&includeGuids=1`,
      {
        headers: {
          'X-Plex-Container-Start': String(offset),
          'X-Plex-Container-Size': String(size),
        },
      }
    );
    const items = response.MediaContainer.Metadata ?? [];
    return {
      totalSize: response.MediaContainer.totalSize ?? items.length,
      items,
    };
  }

  /**
   * What is playing on the server now, for everyone. Needs the owner's
   * token; never cached, as it changes by the second.
   */
  public async getSessions(): Promise<PlexSession[]> {
    const response = await this.get<PlexSessionsResponse>(
      '/status/sessions',
      undefined,
      0
    );
    return response.MediaContainer?.Metadata ?? [];
  }

  /** Albums added to a music library since a time, newest first. */
  public async getRecentlyAddedAlbums(
    sectionId: string,
    addedAt: number
  ): Promise<PlexMusicItem[]> {
    const items: PlexMusicItem[] = [];
    for (let start = 0; start < RECENT_MAX_ITEMS; start += RECENT_PAGE_SIZE) {
      const response = await this.get<PlexMusicResponse>(
        `/library/sections/${sectionId}/all?type=${PLEX_MUSIC_TYPE.album}&includeGuids=1&sort=addedAt%3Adesc&addedAt>>=${Math.floor(addedAt / 1000)}`,
        {
          headers: {
            'X-Plex-Container-Start': String(start),
            'X-Plex-Container-Size': String(RECENT_PAGE_SIZE),
          },
        }
      );
      const page = response.MediaContainer.Metadata ?? [];
      items.push(...page);
      if (page.length < RECENT_PAGE_SIZE) break;
    }
    return items;
  }

  /** One artist, album or track, with the ids Plex matched it to. */
  public async getMusicItem(
    ratingKey: string
  ): Promise<PlexMusicItem | undefined> {
    const response = await this.get<PlexMusicResponse>(
      `/library/metadata/${ratingKey}?includeGuids=1`
    );
    return response.MediaContainer.Metadata?.[0];
  }

  /** An album's tracks, with their files. */
  public async getAlbumTracks(ratingKey: string): Promise<PlexMusicItem[]> {
    const response = await this.get<PlexMusicResponse>(
      `/library/metadata/${ratingKey}/children`
    );
    return response.MediaContainer.Metadata ?? [];
  }
}

export default PlexAPI;
