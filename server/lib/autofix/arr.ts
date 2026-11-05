import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { noteGrab } from '@server/lib/quality/notes';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';

// Sonarr/Radarr calls auto-fix needs: current file and its source, available
// releases, grabbing.

/** Indexer searches are slow; 2½ minutes is ample. */
const RELEASE_SEARCH_TIMEOUT_MS = 150_000;

export interface ArrRelease {
  guid: string;
  indexerId: number;
  indexer?: string;
  title: string;
  releaseGroup?: string;
  protocol?: string;
  size?: number;
  seeders?: number;
  approved?: boolean;
  rejected?: boolean;
  downloadAllowed?: boolean;
  rejections?: (string | { reason?: string })[];
  fullSeason?: boolean;
  qualityWeight?: number;
  customFormatScore?: number;
  quality?: { quality: { id: number; name: string } };
  /** Sonarr: episodes the release maps to. */
  mappedEpisodeInfo?: { id: number }[];
  episodeRequested?: boolean;
  /** Languages parsed from the name. */
  languages?: { id?: number; name?: string }[];
  /** Sonarr: the release's season. */
  seasonNumber?: number;
  /** Sonarr v5: all seasons in a pack. */
  seasonNumbers?: number[];
}

export interface ArrMediaInfo {
  runTime?: string;
  audioLanguages?: string;
  subtitles?: string;
}

export interface ArrFile {
  id: number;
  relativePath?: string;
  path?: string;
  sceneName?: string | null;
  releaseGroup?: string | null;
  size?: number;
  quality?: { quality: { id: number; name: string } };
  mediaInfo?: ArrMediaInfo;
}

export interface ArrEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber?: number;
  title?: string;
  runtime?: number;
  airDateUtc?: string;
  hasFile: boolean;
  episodeFileId: number;
  monitored: boolean;
}

export interface ArrHistoryRecord {
  id: number;
  eventType: string;
  sourceTitle: string;
  date: string;
  downloadId?: string;
  episodeId?: number;
  data?: Record<string, string | null | undefined>;
}

export interface SonarrParse {
  series?: { id: number };
  episodes?: { id: number }[];
}

/** A custom format (Sonarr v4, Radarr). */
export interface ArrCustomFormat {
  id?: number;
  name: string;
  includeCustomFormatWhenRenaming?: boolean;
  specifications: {
    name: string;
    implementation: string;
    negate: boolean;
    required: boolean;
    fields: { name: string; value: unknown }[];
  }[];
}

/** A full quality profile; updates send it back whole. */
export interface ArrQualityProfile {
  id: number;
  name: string;
  minFormatScore?: number;
  formatItems?: { format: number; name?: string; score: number }[];
  [field: string]: unknown;
}

/**
 * Shared Sonarr/Radarr admin calls: custom formats and scores, queue, mark
 * failed, recycle bin.
 */
const extrasOf = (http: AxiosInstance) => ({
  customFormats: async (): Promise<ArrCustomFormat[]> => {
    const { data } = await http.get<ArrCustomFormat[]>('/customformat');
    return Array.isArray(data) ? data : [];
  },
  saveCustomFormat: async (
    format: ArrCustomFormat
  ): Promise<ArrCustomFormat> =>
    format.id
      ? (await http.put<ArrCustomFormat>(`/customformat/${format.id}`, format))
          .data
      : (await http.post<ArrCustomFormat>('/customformat', format)).data,
  deleteCustomFormat: async (id: number): Promise<void> => {
    await http.delete(`/customformat/${id}`);
  },
  qualityProfiles: async (): Promise<ArrQualityProfile[]> => {
    const { data } = await http.get<ArrQualityProfile[]>('/qualityprofile');
    return Array.isArray(data) ? data : [];
  },
  saveQualityProfile: async (profile: ArrQualityProfile): Promise<void> => {
    await http.put(`/qualityprofile/${profile.id}`, profile);
  },
  /** Removes from the queue and download client, and blocklists it. */
  removeFromQueue: async (id: number): Promise<void> => {
    await http.delete(`/queue/${id}`, {
      params: {
        removeFromClient: true,
        blocklist: true,
        skipRedownload: false,
      },
    });
  },
  /** Marks a grab failed: blocklists the release and searches again. */
  markFailed: async (historyId: number): Promise<void> => {
    await http.post(`/history/failed/${historyId}`);
  },
  /** Recycle bin path; empty when deletes are permanent. */
  recycleBin: async (): Promise<string> => {
    const { data } = await http.get<{ recycleBin?: string }>(
      '/config/mediamanagement'
    );
    return data?.recycleBin ?? '';
  },
});

export type ArrExtras = ReturnType<typeof extrasOf>;

const records = (data: unknown): ArrHistoryRecord[] =>
  Array.isArray(data)
    ? (data as ArrHistoryRecord[])
    : ((data as { records?: ArrHistoryRecord[] })?.records ?? []);

export class FixSonarr extends SonarrAPI {
  /** Server, for grab notes (lib/quality). */
  public serverId?: number;
  /** Last offered releases, so a grab can note what it beat. */
  private offered: ArrRelease[] = [];

  static forServer(server: SonarrSettings): FixSonarr {
    const api = new FixSonarr({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    });
    api.serverId = server.id;
    return api;
  }

  public get extras(): ArrExtras {
    return extrasOf(this.axios);
  }

  /** Series history, newest first. */
  public async seriesHistory(seriesId: number): Promise<ArrHistoryRecord[]> {
    const { data } = await this.axios.get('/history/series', {
      params: { seriesId },
    });
    return records(data).sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }

  public async episodes(seriesId: number): Promise<ArrEpisode[]> {
    const { data } = await this.axios.get<ArrEpisode[]>('/episode', {
      params: { seriesId },
    });
    return Array.isArray(data) ? data : [];
  }

  public async episodeFile(id: number): Promise<ArrFile | undefined> {
    try {
      const { data } = await this.axios.get<ArrFile>(`/episodefile/${id}`);
      return data;
    } catch {
      return undefined;
    }
  }

  public async deleteEpisodeFile(id: number): Promise<void> {
    await this.axios.delete(`/episodefile/${id}`);
  }

  /** Episode history, newest first. */
  public async history(episodeId: number): Promise<ArrHistoryRecord[]> {
    const { data } = await this.axios.get('/history', {
      params: {
        episodeId,
        pageSize: 30,
        sortKey: 'date',
        sortDirection: 'descending',
      },
    });
    return records(data);
  }

  public async releases(episodeId: number): Promise<ArrRelease[]> {
    const { data } = await this.axios.get<ArrRelease[]>('/release', {
      params: { episodeId },
      timeout: RELEASE_SEARCH_TIMEOUT_MS,
    });
    this.offered = Array.isArray(data) ? data : [];
    return this.offered;
  }

  /**
   * Season search: packs and single episodes, each with Sonarr's rejections.
   */
  public async seasonReleases(
    seriesId: number,
    seasonNumber: number
  ): Promise<ArrRelease[]> {
    const { data } = await this.axios.get<ArrRelease[]>('/release', {
      params: { seriesId, seasonNumber },
      timeout: RELEASE_SEARCH_TIMEOUT_MS,
    });
    this.offered = Array.isArray(data) ? data : [];
    return this.offered;
  }

  /** Season history, newest first: each file's source. */
  public async seasonHistory(
    seriesId: number,
    seasonNumber: number
  ): Promise<ArrHistoryRecord[]> {
    const { data } = await this.axios.get('/history/series', {
      params: { seriesId, seasonNumber },
    });
    return records(data).sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }

  /** Series name and original language in Sonarr. */
  public async seriesFacts(
    seriesId: number
  ): Promise<{ title?: string; originalLanguage?: string }> {
    const { data } = await this.axios.get<{
      title?: string;
      originalLanguage?: { name?: string };
    }>(`/series/${seriesId}`);
    return {
      title: data?.title,
      originalLanguage: data?.originalLanguage?.name,
    };
  }

  public async grab(release: Pick<ArrRelease, 'guid' | 'indexerId'>) {
    await this.axios.post('/release', {
      guid: release.guid,
      indexerId: release.indexerId,
    });
    if (this.serverId !== undefined) {
      await noteGrab('sonarr', this.serverId, release.guid, this.offered).catch(
        () => undefined
      );
    }
  }

  public async parse(title: string): Promise<SonarrParse> {
    const { data } = await this.axios.get<SonarrParse>('/parse', {
      params: { title },
    });
    return data;
  }
}

export interface RadarrMovieDetail {
  id: number;
  title: string;
  runtime?: number;
  hasFile: boolean;
  monitored?: boolean;
  qualityProfileId?: number;
  movieFile?: ArrFile;
}

export class FixRadarr extends RadarrAPI {
  /** Server, for grab notes (lib/quality). */
  public serverId?: number;
  /** Last offered releases, so a grab can note what it beat. */
  private offered: ArrRelease[] = [];

  static forServer(server: RadarrSettings): FixRadarr {
    const api = new FixRadarr({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    });
    api.serverId = server.id;
    return api;
  }

  public get extras(): ArrExtras {
    return extrasOf(this.axios);
  }

  /** Whether the movie is monitored. */
  public async setMonitored(movieId: number, monitored: boolean) {
    await this.axios.put('/movie/editor', { movieIds: [movieId], monitored });
  }

  public async movieDetail(id: number): Promise<RadarrMovieDetail> {
    const { data } = await this.axios.get<RadarrMovieDetail>(`/movie/${id}`);
    return data;
  }

  public async deleteMovieFile(id: number): Promise<void> {
    await this.axios.delete(`/moviefile/${id}`);
  }

  public async history(movieId: number): Promise<ArrHistoryRecord[]> {
    const { data } = await this.axios.get('/history/movie', {
      params: { movieId },
    });
    return records(data).sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }

  public async releases(movieId: number): Promise<ArrRelease[]> {
    const { data } = await this.axios.get<ArrRelease[]>('/release', {
      params: { movieId },
      timeout: RELEASE_SEARCH_TIMEOUT_MS,
    });
    this.offered = Array.isArray(data) ? data : [];
    return this.offered;
  }

  public async grab(release: Pick<ArrRelease, 'guid' | 'indexerId'>) {
    await this.axios.post('/release', {
      guid: release.guid,
      indexerId: release.indexerId,
    });
    if (this.serverId !== undefined) {
      await noteGrab('radarr', this.serverId, release.guid, this.offered).catch(
        () => undefined
      );
    }
  }
}
