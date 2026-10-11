import RadarrAPI from '@server/api/servarr/radarr';
import type {
  ArrSearchRelease,
  SonarrCommand,
  SonarrLanguage,
  SonarrQuality,
  SonarrQualityProfile,
  SonarrRemotePathMapping,
} from '@server/lib/backfill/sonarr';
import { RELEASE_SEARCH_TIMEOUT_MS } from '@server/lib/backfill/sonarr';
import type { RadarrSettings } from '@server/lib/settings';

/*
 * The Radarr calls Backfill makes for movies: the same as for Sonarr, with
 * movies for series. Radarr's profiles, qualities, commands and path
 * mappings have Sonarr's shapes.
 */

export interface RadarrMovieDetail {
  id: number;
  title: string;
  originalTitle?: string;
  year: number;
  secondaryYear?: number;
  tmdbId: number;
  imdbId?: string;
  path: string;
  qualityProfileId: number;
  monitored: boolean;
  isAvailable: boolean;
  hasFile: boolean;
  movieFileId: number;
  lastSearchTime?: string;
  /** When it was added to Radarr. */
  added?: string;
  alternateTitles?: { title: string }[];
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
  originalLanguage?: { id: number; name: string };
}

export interface RadarrMovieFile {
  id: number;
  movieId: number;
  relativePath?: string;
  size: number;
  quality: SonarrQuality;
  customFormatScore?: number;
  qualityCutoffNotMet?: boolean;
  releaseGroup?: string;
  mediaInfo?: { audioLanguages?: string; subtitles?: string };
}

export interface RadarrParseResult {
  title: string;
  parsedMovieInfo?: {
    movieTitles?: string[];
    primaryMovieTitle?: string;
    year?: number;
    quality?: SonarrQuality;
    releaseGroup?: string;
    edition?: string;
  };
  movie?: { id: number; title: string; year?: number };
  languages?: SonarrLanguage[];
  customFormatScore?: number;
}

export interface MovieImportFile {
  path: string;
  movieId: number;
  quality: SonarrQuality;
  languages: SonarrLanguage[];
  releaseGroup?: string;
}

class BackfillRadarr extends RadarrAPI {
  static forServer(server: RadarrSettings): BackfillRadarr {
    return new BackfillRadarr({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    });
  }

  public async parse(title: string): Promise<RadarrParseResult> {
    const { data } = await this.axios.get<RadarrParseResult>('/parse', {
      params: { title },
    });
    return data;
  }

  public async getMovieDetail(id: number): Promise<RadarrMovieDetail> {
    const { data } = await this.axios.get<RadarrMovieDetail>(`/movie/${id}`);
    return data;
  }

  public async getAllMovies(): Promise<RadarrMovieDetail[]> {
    const { data } = await this.axios.get<RadarrMovieDetail[]>('/movie');
    return Array.isArray(data) ? data : [];
  }

  public async getMovieFile(movieId: number): Promise<RadarrMovieFile | null> {
    const { data } = await this.axios.get<RadarrMovieFile[]>('/moviefile', {
      params: { movieId },
    });
    return Array.isArray(data) ? (data[0] ?? null) : null;
  }

  public async getQualityProfile(id: number): Promise<SonarrQualityProfile> {
    const { data } = await this.axios.get<SonarrQualityProfile>(
      `/qualityprofile/${id}`
    );
    return data;
  }

  /** Monitored movies that are missing, or below their cutoff. */
  public async getWanted(
    kind: 'missing' | 'cutoff',
    maxPages = 40
  ): Promise<RadarrMovieDetail[]> {
    const movies: RadarrMovieDetail[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.axios.get<{
        totalRecords: number;
        records: RadarrMovieDetail[];
      }>(`/wanted/${kind}`, {
        params: { page, pageSize: 250, monitored: true },
      });
      movies.push(...(data?.records ?? []));
      if (!data?.records?.length || movies.length >= data.totalRecords) {
        break;
      }
    }
    return movies;
  }

  /** Radarr's own search for a movie, with its reasons for each refusal. */
  public async getReleases(movieId: number): Promise<ArrSearchRelease[]> {
    const { data } = await this.axios.get<ArrSearchRelease[]>('/release', {
      params: { movieId },
      timeout: RELEASE_SEARCH_TIMEOUT_MS,
    });
    return Array.isArray(data) ? data : [];
  }

  public async getMovieQueueCount(movieId: number): Promise<number> {
    const { data } = await this.axios.get<unknown[]>('/queue/details', {
      params: { movieId },
    });
    return Array.isArray(data) ? data.length : 0;
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

  public async getRemotePathMappings(): Promise<SonarrRemotePathMapping[]> {
    const { data } =
      await this.axios.get<SonarrRemotePathMapping[]>('/remotepathmapping');
    return Array.isArray(data) ? data : [];
  }

  public async getFolderFiles(
    folder: string
  ): Promise<{ path: string; name: string; size: number }[]> {
    const { data } = await this.axios.get<
      { path: string; name: string; size: number }[]
    >('/manualimport', {
      params: { folder, filterExistingFiles: false },
    });
    return Array.isArray(data) ? data : [];
  }

  public async manualImport(files: MovieImportFile[]): Promise<number> {
    const { data } = await this.axios.post<SonarrCommand>('/command', {
      name: 'ManualImport',
      importMode: 'move',
      files,
    });
    return data.id;
  }

  public async getCommand(id: number): Promise<SonarrCommand> {
    const { data } = await this.axios.get<SonarrCommand>(`/command/${id}`);
    return data;
  }

  /** Every command Radarr has queued, running or lately done. */
  public async getCommands(): Promise<SonarrCommand[]> {
    const { data } = await this.axios.get<SonarrCommand[]>('/command');
    return Array.isArray(data) ? data : [];
  }
}

export default BackfillRadarr;
