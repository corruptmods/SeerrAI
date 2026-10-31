import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { noteGrab } from '@server/lib/quality/notes';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';

/*
 * The few Sonarr and Radarr calls fixing a reported problem needs: what
 * file an episode or movie has and where it came from, the releases there
 * are for it, and grabbing one of them. Both apps answer these the same way.
 */

/** Searching every indexer can take a while; 2½ minutes is ample. */
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
  /** Sonarr: the episodes the release maps to. */
  mappedEpisodeInfo?: { id: number }[];
  episodeRequested?: boolean;
  /** The languages Sonarr or Radarr reads in its name. */
  languages?: { id?: number; name?: string }[];
  /** Sonarr: the season a release is for. */
  seasonNumber?: number;
  /** Sonarr v5: every season a pack holds. */
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

/** A custom format, as Sonarr (v4) and Radarr keep them. */
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

/** A quality profile, whole: it is sent back whole when changed. */
export interface ArrQualityProfile {
  id: number;
  name: string;
  minFormatScore?: number;
  formatItems?: { format: number; name?: string; score: number }[];
  [field: string]: unknown;
}

/**
 * What an admin's changes need of Sonarr and Radarr alike: custom formats
 * and the scores profiles give them, the queue, marking a grab failed, and
 * where deleted files go.
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
  /** Takes it out of the queue and the download client, blocklisting it. */
  removeFromQueue: async (id: number): Promise<void> => {
    await http.delete(`/queue/${id}`, {
      params: {
        removeFromClient: true,
        blocklist: true,
        skipRedownload: false,
      },
    });
  },
  /** Marks a grab failed: its release is blocklisted and searched again. */
  markFailed: async (historyId: number): Promise<void> => {
    await http.post(`/history/failed/${historyId}`);
  },
  /** Where deleted files go; empty when they are deleted for good. */
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
  /** The server it is, for notes on what Seerr AI grabs (lib/quality). */
  public serverId?: number;
  /** The releases last offered, so a grab can say what it was chosen over. */
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

  /** The series' newest events, newest first. */
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

  /** The newest events for one episode, newest first. */
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
   * Sonarr's search for a whole season: its packs, and the single episodes
   * the indexers return for it, each with why Sonarr would turn it down.
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

  /** One season's events, newest first: where each file came from. */
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

  /** The series' name and original language, as Sonarr has them. */
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
  /** The server it is, for notes on what Seerr AI grabs (lib/quality). */
  public serverId?: number;
  /** The releases last offered, so a grab can say what it was chosen over. */
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

  /** Whether Radarr looks for the movie. */
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
