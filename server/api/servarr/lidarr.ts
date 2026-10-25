import ServarrBase from './base';

/*
 * Lidarr, for music. Its API is /api/v1, Lidarr 2 included. An artist holds
 * the root folder, quality and metadata profiles and tags; its albums are
 * only monitored or not.
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
  /** The artist's MusicBrainz id. */
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
  /** The release's MusicBrainz id. */
  foreignReleaseId: string;
  title: string;
  monitored: boolean;
  trackCount?: number;
}

/** A track of an album in Lidarr, of the release Lidarr chose. */
export interface LidarrTrack {
  id: number;
  albumId: number;
  title: string;
  /** The track's MusicBrainz recording id. */
  foreignRecordingId?: string;
  hasFile: boolean;
  trackFileId?: number;
}

/** A file as Lidarr's manual import reads it. */
export interface LidarrManualImportItem {
  path: string;
  name?: string;
  size?: number;
  quality?: LidarrQualityModel;
}

/** A quality as Lidarr writes it on a file. */
export interface LidarrQualityModel {
  quality: { id: number; name: string };
  revision?: { version: number; real: number; isRepack?: boolean };
}

/** One file for Lidarr's manual import, and the tracks it is. */
export interface LidarrManualImportFile {
  path: string;
  artistId: number;
  albumId: number;
  albumReleaseId: number;
  trackIds: number[];
  quality: LidarrQualityModel;
  indexerFlags: 0;
  disableReleaseSwitching: boolean;
}

export interface LidarrAlbum {
  id: number;
  title: string;
  /** The album's MusicBrainz release-group id. */
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

/** Which kinds of release a metadata profile lets Lidarr list. */
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

/** How an artist added to Lidarr is set up; Lidarr's own words. */
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
     * Release-group ids to monitor. Lidarr then unmonitors every other
     * album of the artist: only for an artist being added.
     */
    albumsToMonitor?: string[];
    searchForMissingAlbums: boolean;
  };
}

export interface LidarrQueueAppend {
  artistId: number;
  albumId: number;
  artist?: Pick<LidarrArtist, 'id' | 'artistName' | 'foreignArtistId'>;
  album?: Pick<LidarrAlbum, 'id' | 'title' | 'foreignAlbumId'>;
}

class LidarrAPI extends ServarrBase<LidarrQueueAppend> {
  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, cacheName: 'lidarr', apiName: 'Lidarr' });
  }

  private fail(action: string, e: unknown): never {
    throw new Error(
      `[Lidarr] Failed to ${action}: ${e instanceof Error ? e.message : e}`,
      { cause: e }
    );
  }

  /** An artist as Lidarr's metadata service knows it, to add. */
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

  /** An album as Lidarr's metadata service knows it, to add. */
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

  /** The artist in this Lidarr, if it has it. */
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

  /**
   * One artist's albums, or every album in Lidarr (with their releases)
   * when no artist is given.
   */
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

  /** One album, with its releases and artist. */
  public getAlbum = async (id: number): Promise<LidarrAlbum> => {
    try {
      return (await this.axios.get<LidarrAlbum>(`/album/${id}`)).data;
    } catch (e) {
      this.fail('retrieve the album', e);
    }
  };

  /** An album's tracks, and which of them have a file. */
  public getTracks = async (albumId: number): Promise<LidarrTrack[]> => {
    try {
      return (
        await this.axios.get<LidarrTrack[]>('/track', { params: { albumId } })
      ).data;
    } catch (e) {
      this.fail('retrieve tracks', e);
    }
  };

  /**
   * What Lidarr's manual import makes of the files in a folder (paths as
   * Lidarr sees them): each file's quality, and what it takes it to be.
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
   * Imports files into the tracks given, as Lidarr's manual import does;
   * answers the command's id. Copies, so the download can be removed after.
   */
  public manualImport = async (
    files: LidarrManualImportFile[]
  ): Promise<number> => {
    try {
      const response = await this.axios.post<{ id: number }>('/command', {
        name: 'ManualImport',
        importMode: 'copy',
        files,
      });
      return response.data.id;
    } catch (e) {
      this.fail('import the files', e);
    }
  };

  /** A command Lidarr was given, and how far it is. */
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

  /** Where a download client's folders are, as Lidarr sees them. */
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

  /** An album's track files: where it sits on disk. */
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

  /** Adds an artist from a lookup, set up as given. */
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
   * Adds one album from a lookup. With an artist Lidarr does not have yet,
   * `artist` carries how to set it up and Lidarr adds it too; for one it
   * has, it is `{ id }`. Monitored unless `monitored` is false, as for an
   * album only one song is taken from.
   */
  public addAlbum = async (
    album: LidarrAlbum,
    {
      artist,
      searchForNewAlbum,
      monitored = true,
    }: {
      artist:
        | { id: number }
        | (LidarrArtist & LidarrArtistOptions & LidarrAddArtistOptions);
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
   * Changes an artist Lidarr has. Callers send the artist as Lidarr gave it
   * with only what they mean to change.
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

  /** What Lidarr is downloading, with each item's album and artist. */
  public getMusicQueue = () =>
    this.getQueue({ includeArtist: true, includeAlbum: true });
}

export default LidarrAPI;
