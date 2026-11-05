import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrQualityModel,
  LidarrTrack,
} from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import type {
  ArrSearchRelease,
  SonarrCommand,
  SonarrQualityProfile,
} from '@server/lib/backfill/sonarr';
import { RELEASE_SEARCH_TIMEOUT_MS } from '@server/lib/backfill/sonarr';
import type { LidarrSettings } from '@server/lib/settings';

/*
 * Lidarr calls for album Backfill: wanted albums, name parsing, quality
 * profiles (Sonarr's shape), and manual import track by track into one
 * release of the album.
 */

/** A track with its position on the album. */
export interface AlbumTrack extends LidarrTrack {
  trackNumber?: string;
  absoluteTrackNumber?: number;
  mediumNumber?: number;
  albumReleaseId?: number;
}

/** A track's file on disk, per Lidarr. */
export interface AlbumTrackFile {
  id: number;
  albumId: number;
  size: number;
  quality: LidarrQualityModel;
  path?: string;
}

/** Lidarr's parse of a release or file name. */
export interface LidarrParseResult {
  title: string;
  parsedAlbumInfo?: {
    albumTitle?: string;
    artistName?: string;
    releaseYear?: number;
    quality?: LidarrQualityModel;
    discography?: boolean;
  };
  artist?: { id: number; artistName: string };
  albums?: { id: number; title: string }[];
  customFormatScore?: number;
}

export interface AlbumImportFile {
  path: string;
  artistId: number;
  albumId: number;
  albumReleaseId: number;
  trackIds: number[];
  quality: LidarrQualityModel;
}

class BackfillLidarr extends LidarrAPI {
  static forServer(server: LidarrSettings): BackfillLidarr {
    return new BackfillLidarr({
      apiKey: server.apiKey,
      url: LidarrAPI.buildUrl(server, '/api/v1'),
    });
  }

  public async parse(title: string): Promise<LidarrParseResult> {
    const { data } = await this.axios.get<LidarrParseResult>('/parse', {
      params: { title },
    });
    return data;
  }

  public async getArtistDetail(id: number): Promise<LidarrArtist> {
    const { data } = await this.axios.get<LidarrArtist>(`/artist/${id}`);
    return data;
  }

  /** The album with this MusicBrainz id, if Lidarr has it. */
  public async getAlbumByMbid(mbId: string): Promise<LidarrAlbum | undefined> {
    const { data } = await this.axios.get<LidarrAlbum[]>('/album', {
      params: { foreignAlbumId: mbId },
    });
    return (Array.isArray(data) ? data : []).find(
      (album) => album.foreignAlbumId === mbId
    );
  }

  public async getAlbumDetail(id: number): Promise<LidarrAlbum> {
    const { data } = await this.axios.get<LidarrAlbum>(`/album/${id}`);
    return data;
  }

  /** An album's tracks: those of its monitored release. */
  public async getAlbumTracks(albumId: number): Promise<AlbumTrack[]> {
    const { data } = await this.axios.get<AlbumTrack[]>('/track', {
      params: { albumId },
    });
    return Array.isArray(data) ? data : [];
  }

  /** One release's tracks, monitored or not. */
  public async getEditionTracks(albumReleaseId: number): Promise<AlbumTrack[]> {
    const { data } = await this.axios.get<AlbumTrack[]>('/track', {
      params: { albumReleaseId },
    });
    return Array.isArray(data) ? data : [];
  }

  public async getAlbumTrackFiles(albumId: number): Promise<AlbumTrackFile[]> {
    const { data } = await this.axios.get<AlbumTrackFile[]>('/trackfile', {
      params: { albumId },
    });
    return Array.isArray(data) ? data : [];
  }

  public async getQualityProfile(id: number): Promise<SonarrQualityProfile> {
    const { data } = await this.axios.get<SonarrQualityProfile>(
      `/qualityprofile/${id}`
    );
    return data;
  }

  /**
   * Monitored albums missing or below cutoff, with their artists. `complete`
   * is false past `maxPages` pages: the rest is still wanted, not found.
   */
  public async getWanted(
    kind: 'missing' | 'cutoff',
    maxPages = 40
  ): Promise<{ records: LidarrAlbum[]; complete: boolean }> {
    const albums: LidarrAlbum[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.axios.get<{
        totalRecords: number;
        records: LidarrAlbum[];
      }>(`/wanted/${kind}`, {
        params: { page, pageSize: 250, monitored: true, includeArtist: true },
      });
      albums.push(...(data?.records ?? []));
      if (!data?.records?.length || albums.length >= data.totalRecords) {
        return { records: albums, complete: true };
      }
    }
    return { records: albums, complete: false };
  }

  /** Lidarr's search for an album, with each rejection reason. */
  public async getReleases(albumId: number): Promise<ArrSearchRelease[]> {
    const { data } = await this.axios.get<ArrSearchRelease[]>('/release', {
      params: { albumId },
      timeout: RELEASE_SEARCH_TIMEOUT_MS,
    });
    return Array.isArray(data) ? data : [];
  }

  /**
   * Lidarr's queued downloads for this album. Uses /queue/details because
   * the paged /queue ignores an album filter.
   */
  public async getAlbumQueueCount(albumId: number): Promise<number> {
    const { data } = await this.axios.get<{ albumId?: number }[]>(
      '/queue/details',
      { params: { albumIds: albumId } }
    );
    return (Array.isArray(data) ? data : []).filter(
      (item) => item.albumId === albumId
    ).length;
  }

  public async getRootFoldersNow(): Promise<
    { path: string; freeSpace: number }[]
  > {
    const { data } =
      await this.axios.get<{ path: string; freeSpace: number }[]>(
        '/rootfolder'
      );
    return Array.isArray(data) ? data : [];
  }

  /** A finished folder's files as Lidarr sees them for one artist. */
  public async getFolderFiles(
    folder: string,
    artistId?: number
  ): Promise<{ path: string; name: string; size: number }[]> {
    const { data } = await this.axios.get<
      { path: string; name: string; size: number }[]
    >('/manualimport', {
      params: { folder, artistId, filterExistingFiles: false },
    });
    return Array.isArray(data) ? data : [];
  }

  /**
   * Imports files into the given tracks; returns the command id. Moves, so
   * the download is removed after.
   */
  public async importAlbumFiles(files: AlbumImportFile[]): Promise<number> {
    const { data } = await this.axios.post<SonarrCommand>('/command', {
      name: 'ManualImport',
      importMode: 'move',
      files: files.map((file) => ({
        ...file,
        indexerFlags: 0,
        disableReleaseSwitching: false,
      })),
    });
    return data.id;
  }
}

export default BackfillLidarr;
