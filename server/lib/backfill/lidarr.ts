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
 * The Lidarr calls Backfill makes for albums: what Lidarr is missing, how
 * it reads a release's name, its quality profiles (Sonarr's shape), and
 * its manual import, track by track into one release of the album.
 */

/** A track as Backfill judges it: where it sits on the album. */
export interface AlbumTrack extends LidarrTrack {
  trackNumber?: string;
  absoluteTrackNumber?: number;
  mediumNumber?: number;
  albumReleaseId?: number;
}

/** A track's file on disk, as Lidarr has it. */
export interface AlbumTrackFile {
  id: number;
  albumId: number;
  size: number;
  quality: LidarrQualityModel;
  path?: string;
}

/** What Lidarr makes of a release's or a file's name. */
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

  /** The album in this Lidarr, by its MusicBrainz id, if it has it. */
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

  /** The tracks Lidarr has for an album: those of its monitored release. */
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
   * Monitored albums that are missing, or below their cutoff, each with its
   * artist. `complete` is false when there were more than `maxPages` pages:
   * what was left out is still wanted, not found.
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

  /** Lidarr's own search for an album, with its reasons for each refusal. */
  public async getReleases(albumId: number): Promise<ArrSearchRelease[]> {
    const { data } = await this.axios.get<ArrSearchRelease[]>('/release', {
      params: { albumId },
      timeout: RELEASE_SEARCH_TIMEOUT_MS,
    });
    return Array.isArray(data) ? data : [];
  }

  /**
   * How many of Lidarr's own downloads are for this album. The paged
   * /queue has no album filter (it would answer the whole queue); its
   * details do.
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

  /** A finished folder's files, as Lidarr sees them, for one artist. */
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
   * Imports files into the tracks given; answers the command's id. Moves,
   * as Backfill's imports do: the download is removed after.
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
