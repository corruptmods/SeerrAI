import { isAxiosError } from 'axios';
import ServarrBase from './base';

/*
 * Lidarr uses /api/v1, Lidarr 2 included. The artist holds the root folder,
 * profiles and tags; albums are only monitored or not.
 */

export interface LidarrImage {
  coverType: string;
  url?: string;
  remoteUrl?: string;
}

export interface LidarrStatistics {
  albumCount?: number;
  trackFileCount: number;
  trackCount: number;
  totalTrackCount: number;
  sizeOnDisk: number;
  percentOfTracks: number;
}

export interface LidarrArtist {
  id: number;
  artistName: string;
  /** MusicBrainz artist id. */
  foreignArtistId: string;
  monitored: boolean;
  monitorNewItems?: 'all' | 'none' | 'new';
  qualityProfileId: number;
  metadataProfileId: number;
  rootFolderPath?: string;
  path?: string;
  tags: number[];
  images?: LidarrImage[];
  statistics?: LidarrStatistics;
  added?: string;
}

export interface LidarrRelease {
  id: number;
  albumId: number;
  /** MusicBrainz release id. */
  foreignReleaseId: string;
  title: string;
  monitored: boolean;
  trackCount?: number;
  /** Official, Promotion, Bootleg, Pseudo-Release… */
  status?: string;
  /** "Digital Media", "CD", "12\" Vinyl"… */
  format?: string;
  country?: string[];
}

/** A track of the album release Lidarr chose. */
export interface LidarrTrack {
  id: number;
  albumId: number;
  title: string;
  /** MusicBrainz recording id. */
  foreignRecordingId?: string;
  /** In milliseconds. */
  duration?: number;
  hasFile: boolean;
  trackFileId?: number;
}

/** A file as Lidarr's manual import reads it. */
export interface LidarrManualImportItem {
  path: string;
  name?: string;
  size?: number;
  quality?: LidarrQualityModel;
  /** From the file's tags; duration like "00:03:41.5". */
  audioTags?: { title?: string; duration?: string };
}

/** Parses a Lidarr duration ("00:03:41.5", "1.02:03:04") to ms. */
export const lidarrDuration = (text: string | undefined): number | null => {
  const parts = text?.match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!parts) return null;
  const [, days, hours, minutes, seconds] = parts;
  return Math.round(
    (((Number(days ?? 0) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 +
      Number(seconds)) *
      1000
  );
};

/** Lidarr's preferred protocol for artists with these tags. */
export interface LidarrDelayProfile {
  id: number;
  enableUsenet: boolean;
  enableTorrent: boolean;
  preferredProtocol: 'usenet' | 'torrent';
  order: number;
  tags: number[];
}

/** A file's quality as Lidarr records it. */
export interface LidarrQualityModel {
  quality: { id: number; name: string };
  revision?: { version: number; real: number; isRepack?: boolean };
}

/** One file for Lidarr's manual import, with its tracks. */
export interface LidarrManualImportFile {
  path: string;
  artistId: number;
  albumId: number;
  albumReleaseId: number;
  trackIds: number[];
  quality: LidarrQualityModel;
  indexerFlags: 0;
  disableReleaseSwitching: boolean;
  /** The source queue item, which the import completes. */
  downloadId?: string;
}

export interface LidarrAlbum {
  id: number;
  title: string;
  /** MusicBrainz release-group id. */
  foreignAlbumId: string;
  artistId: number;
  monitored: boolean;
  anyReleaseOk?: boolean;
  albumType?: string;
  secondaryTypes?: string[];
  releaseDate?: string;
  releases?: LidarrRelease[];
  images?: LidarrImage[];
  statistics?: LidarrStatistics;
  artist?: LidarrArtist;
}

/** Which release kinds a metadata profile lets Lidarr list. */
export interface LidarrMetadataProfile {
  id: number;
  name: string;
  primaryAlbumTypes?: {
    albumType: { id: number; name: string };
    allowed: boolean;
  }[];
  secondaryAlbumTypes?: {
    albumType: { id: number; name: string };
    allowed: boolean;
  }[];
  releaseStatuses?: {
    releaseStatus: { id: number; name: string };
    allowed: boolean;
  }[];
}

/** Setup for an artist added to Lidarr, in Lidarr's field names. */
export interface LidarrArtistOptions {
  qualityProfileId: number;
  metadataProfileId: number;
  rootFolderPath: string;
  tags: number[];
  monitored: boolean;
  monitorNewItems: 'all' | 'none' | 'new';
}

export interface LidarrAddArtistOptions extends LidarrArtistOptions {
  addOptions: {
    monitor:
      | 'all'
      | 'future'
      | 'missing'
      | 'existing'
      | 'latest'
      | 'first'
      | 'none';
    /**
     * Release-group ids to monitor; Lidarr unmonitors the artist's other
     * albums. Only for an artist being added.
     */
    albumsToMonitor?: string[];
    searchForMissingAlbums: boolean;
  };
}

export interface LidarrQueueAppend {
  artistId: number;
  albumId: number;
  /** The finished download, in Lidarr's own paths. */
  outputPath?: string;
  /** Per file, why Lidarr hasn't imported it. */
  statusMessages?: { title: string; messages: string[] }[];
  artist?: Pick<LidarrArtist, 'id' | 'artistName' | 'foreignArtistId'>;
  album?: Pick<LidarrAlbum, 'id' | 'title' | 'foreignAlbumId'>;
}

/**
 * Lidarr's refusal text: its 400 validation errors ("This album has already
 * been added"), or its message.
 */
export const lidarrSaid = (e: unknown): string | undefined => {
  const data = isAxiosError(e) ? e.response?.data : undefined;
  const said = Array.isArray(data)
    ? data
        .map((item: { errorMessage?: unknown }) =>
          typeof item?.errorMessage === 'string' ? item.errorMessage : ''
        )
        .filter(Boolean)
        .join('; ')
    : typeof data === 'object' && data && 'message' in data
      ? String((data as { message: unknown }).message ?? '')
      : typeof data === 'string'
        ? data
        : '';
  return said.trim().slice(0, 200) || undefined;
};

class LidarrAPI extends ServarrBase<LidarrQueueAppend> {
  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, cacheName: 'lidarr', apiName: 'Lidarr' });
  }

  private fail(action: string, e: unknown): never {
    const said = lidarrSaid(e);
    throw new Error(
      `[Lidarr] Failed to ${action}: ${e instanceof Error ? e.message : e}${
        said ? ` (${said})` : ''
      }`,
      { cause: e }
    );
  }

  /** An artist from Lidarr's metadata service, ready to add. */
  public lookupArtist = async (
    artistMbid: string
  ): Promise<LidarrArtist | undefined> => {
    try {
      const response = await this.axios.get<LidarrArtist[]>('/artist/lookup', {
        params: { term: `lidarr:${artistMbid}` },
      });
      return response.data.find((a) => a.foreignArtistId === artistMbid);
    } catch (e) {
      this.fail('look up artist', e);
    }
  };

  /** An album from Lidarr's metadata service, ready to add. */
  public lookupAlbum = async (
    albumMbid: string
  ): Promise<LidarrAlbum | undefined> => {
    try {
      const response = await this.axios.get<LidarrAlbum[]>('/album/lookup', {
        params: { term: `lidarr:${albumMbid}` },
      });
      return response.data.find((a) => a.foreignAlbumId === albumMbid);
    } catch (e) {
      this.fail('look up album', e);
    }
  };

  /** The artist in this Lidarr, if present. */
  public getArtistByMbid = async (
    artistMbid: string
  ): Promise<LidarrArtist | undefined> => {
    try {
      const response = await this.axios.get<LidarrArtist[]>('/artist', {
        params: { mbId: artistMbid },
      });
      return response.data.find((a) => a.foreignArtistId === artistMbid);
    } catch (e) {
      this.fail('retrieve artist', e);
    }
  };

  public getArtists = async (): Promise<LidarrArtist[]> => {
    try {
      return (await this.axios.get<LidarrArtist[]>('/artist')).data;
    } catch (e) {
      this.fail('retrieve artists', e);
    }
  };

  /** One artist's albums, or every album (with releases) without an artist. */
  public getAlbums = async ({ artistId }: { artistId?: number } = {}): Promise<
    LidarrAlbum[]
  > => {
    try {
      const response = await this.axios.get<LidarrAlbum[]>('/album', {
        params: artistId !== undefined ? { artistId } : {},
      });
      return response.data;
    } catch (e) {
      this.fail('retrieve albums', e);
    }
  };

  /**
   * The album with this MusicBrainz id under any artist (a duet is filed
   * under the first credited artist).
   */
  public findAlbum = async (
    albumMbid: string
  ): Promise<LidarrAlbum | undefined> => {
    try {
      const response = await this.axios.get<LidarrAlbum[]>('/album', {
        params: { foreignAlbumId: albumMbid },
      });
      return response.data.find((a) => a.foreignAlbumId === albumMbid);
    } catch (e) {
      this.fail('retrieve the album', e);
    }
  };

  /** One album with its releases and artist. */
  public getAlbum = async (id: number): Promise<LidarrAlbum> => {
    try {
      return (await this.axios.get<LidarrAlbum>(`/album/${id}`)).data;
    } catch (e) {
      this.fail('retrieve the album', e);
    }
  };

  /** Tracks of the album's monitored release, with which have a file. */
  public getTracks = async (albumId: number): Promise<LidarrTrack[]> => {
    try {
      return (
        await this.axios.get<LidarrTrack[]>('/track', { params: { albumId } })
      ).data;
    } catch (e) {
      this.fail('retrieve tracks', e);
    }
  };

  /** Tracks of one release, monitored or not. */
  public getReleaseTracks = async (
    albumReleaseId: number
  ): Promise<LidarrTrack[]> => {
    try {
      return (
        await this.axios.get<LidarrTrack[]>('/track', {
          params: { albumReleaseId },
        })
      ).data;
    } catch (e) {
      this.fail('retrieve tracks', e);
    }
  };

  /**
   * Lidarr's manual-import reading of a folder's files (Lidarr's paths):
   * each file's quality and matched tracks.
   */
  public getManualImport = async (
    folder: string,
    artistId: number
  ): Promise<LidarrManualImportItem[]> => {
    try {
      const response = await this.axios.get<LidarrManualImportItem[]>(
        '/manualimport',
        { params: { folder, artistId, filterExistingFiles: false } }
      );
      return response.data;
    } catch (e) {
      this.fail('read the folder for import', e);
    }
  };

  /**
   * Manual-imports files into the given tracks; returns the command id. Copy
   * for a torrent still seeding, move when nothing is kept, auto for
   * Lidarr's own download.
   */
  public manualImport = async (
    importMode: 'copy' | 'move' | 'auto',
    files: LidarrManualImportFile[]
  ): Promise<number> => {
    try {
      const response = await this.axios.post<{ id: number }>('/command', {
        name: 'ManualImport',
        importMode,
        files,
      });
      return response.data.id;
    } catch (e) {
      this.fail('import the files', e);
    }
  };

  /** A Lidarr command and its progress. */
  public getCommand = async (
    id: number
  ): Promise<{ id: number; status: string; message?: string }> => {
    try {
      return (
        await this.axios.get<{ id: number; status: string; message?: string }>(
          `/command/${id}`
        )
      ).data;
    } catch (e) {
      this.fail('read the command', e);
    }
  };

  /** Download client folders mapped to Lidarr's paths. */
  public getRemotePathMappings = async (): Promise<
    { host: string; remotePath: string; localPath: string }[]
  > => {
    try {
      return (
        await this.axios.get<
          { host: string; remotePath: string; localPath: string }[]
        >('/remotepathmapping')
      ).data;
    } catch (e) {
      this.fail('read the remote path mappings', e);
    }
  };

  /**
   * Whether Lidarr sees this folder, checked via its parent's listing:
   * Lidarr's file browser returns a missing folder as empty.
   */
  public folderExists = async (path: string): Promise<boolean> => {
    const folder = path.replace(/[\\/]+$/, '');
    if (!folder) return true;
    const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
    const parent = folder.slice(0, folder.lastIndexOf(sep) + 1) || sep;
    try {
      const listing = (
        await this.axios.get<{ directories?: { path: string }[] }>(
          '/filesystem',
          { params: { path: parent, includeFiles: false } }
        )
      ).data;
      return (listing.directories ?? []).some(
        (d) => d.path.replace(/[\\/]+$/, '') === folder
      );
    } catch (e) {
      this.fail('read the folder', e);
    }
  };

  public getDelayProfiles = async (): Promise<LidarrDelayProfile[]> => {
    try {
      return (await this.axios.get<LidarrDelayProfile[]>('/delayprofile')).data;
    } catch (e) {
      this.fail('read the delay profiles', e);
    }
  };

  /** An album's track files on disk. */
  public getTrackFiles = async (
    albumId: number
  ): Promise<{ id: number; path?: string }[]> => {
    try {
      const response = await this.axios.get<{ id: number; path?: string }[]>(
        '/trackfile',
        { params: { albumId } }
      );
      return response.data;
    } catch (e) {
      this.fail('retrieve track files', e);
    }
  };

  /** Adds an artist from a lookup with the given setup. */
  public addArtist = async (
    artist: LidarrArtist,
    options: LidarrAddArtistOptions
  ): Promise<LidarrArtist> => {
    try {
      const response = await this.axios.post<LidarrArtist>('/artist', {
        ...artist,
        ...options,
      });
      return response.data;
    } catch (e) {
      this.fail('add artist', e);
    }
  };

  /**
   * Adds one album from a lookup. For a new artist, `artist` carries its
   * setup and Lidarr adds it too; for an existing one, pass the artist as
   * Lidarr returned it (Lidarr refuses an album whose artist lacks id,
   * profiles and folder). `monitored: false` suits taking one song.
   */
  public addAlbum = async (
    album: LidarrAlbum,
    {
      artist,
      searchForNewAlbum,
      monitored = true,
    }: {
      artist: LidarrArtist | (LidarrArtist & LidarrAddArtistOptions);
      searchForNewAlbum: boolean;
      monitored?: boolean;
    }
  ): Promise<LidarrAlbum> => {
    try {
      const response = await this.axios.post<LidarrAlbum>('/album', {
        ...album,
        monitored,
        anyReleaseOk: true,
        artist,
        addOptions: { searchForNewAlbum },
      });
      return response.data;
    } catch (e) {
      this.fail('add album', e);
    }
  };

  /**
   * Updates an artist. Send the artist as Lidarr returned it, changing only
   * the intended fields.
   */
  public updateArtist = async (artist: LidarrArtist): Promise<LidarrArtist> => {
    try {
      const response = await this.axios.put<LidarrArtist>(
        `/artist/${artist.id}`,
        artist
      );
      return response.data;
    } catch (e) {
      this.fail('update artist', e);
    }
  };

  /** Monitors (or stops monitoring) exactly these albums. */
  public monitorAlbums = async (
    albumIds: number[],
    monitored = true
  ): Promise<void> => {
    if (!albumIds.length) {
      return;
    }
    try {
      await this.axios.put('/album/monitor', { albumIds, monitored });
    } catch (e) {
      this.fail('monitor albums', e);
    }
  };

  /** Starts an album search; returns the command id. */
  public startAlbumSearch = async (albumIds: number[]): Promise<number> => {
    try {
      return (
        await this.axios.post<{ id: number }>('/command', {
          name: 'AlbumSearch',
          albumIds,
        })
      ).data.id;
    } catch (e) {
      this.fail('search for albums', e);
    }
  };

  public searchAlbums = async (albumIds: number[]): Promise<void> => {
    if (!albumIds.length) {
      return;
    }
    await this.runCommand('AlbumSearch', { albumIds });
  };

  public searchArtist = async (artistId: number): Promise<void> => {
    await this.runCommand('ArtistSearch', { artistId });
  };

  public refreshArtist = async (artistId: number): Promise<void> => {
    await this.runCommand('RefreshArtist', { artistId });
  };

  public getMetadataProfiles = async (): Promise<LidarrMetadataProfile[]> => {
    try {
      return await this.getRolling<LidarrMetadataProfile[]>(
        '/metadataprofile',
        undefined,
        3600
      );
    } catch (e) {
      this.fail('retrieve metadata profiles', e);
    }
  };

  public getMetadataProfile = async (
    id: number
  ): Promise<LidarrMetadataProfile> => {
    try {
      return await this.getRolling<LidarrMetadataProfile>(
        `/metadataprofile/${id}`,
        undefined,
        3600
      );
    } catch (e) {
      this.fail('retrieve metadata profile', e);
    }
  };

  /** Lidarr's queue with each item's album and artist. */
  public getMusicQueue = () =>
    this.getQueue({ includeArtist: true, includeAlbum: true });
}

export default LidarrAPI;
