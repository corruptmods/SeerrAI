import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';

/*
 * The few Sonarr and Radarr calls fixing a reported problem needs: what
 * file an episode or movie has and where it came from, the releases there
 * are for it, and grabbing one of them. Both apps answer these the same way.
 */

/** Searching every indexer can take a while; a minute and a half is ample. */
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

const records = (data: unknown): ArrHistoryRecord[] =>
  Array.isArray(data)
    ? (data as ArrHistoryRecord[])
    : ((data as { records?: ArrHistoryRecord[] })?.records ?? []);

export class FixSonarr extends SonarrAPI {
  static forServer(server: SonarrSettings): FixSonarr {
    return new FixSonarr({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    });
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
    return Array.isArray(data) ? data : [];
  }

  public async grab(release: Pick<ArrRelease, 'guid' | 'indexerId'>) {
    await this.axios.post('/release', {
      guid: release.guid,
      indexerId: release.indexerId,
    });
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
  movieFile?: ArrFile;
}

export class FixRadarr extends RadarrAPI {
  static forServer(server: RadarrSettings): FixRadarr {
    return new FixRadarr({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    });
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
    return Array.isArray(data) ? data : [];
  }

  public async grab(release: Pick<ArrRelease, 'guid' | 'indexerId'>) {
    await this.axios.post('/release', {
      guid: release.guid,
      indexerId: release.indexerId,
    });
  }
}
