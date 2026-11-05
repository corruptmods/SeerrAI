import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type {
  ArrCustomFormat,
  ArrQualityProfile,
} from '@server/lib/autofix/arr';
import type { ArrKind } from '@server/lib/quality/types';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';

/*
 * Radarr and Sonarr calls for Settings → Quality: quality profiles and
 * custom formats (reads all, writes only Seerr AI's own), the delay
 * profile, release parsing, grab history, and moving titles between
 * profiles. Both apps serve these identically at /api/v3.
 */

export interface QualityServerRef {
  kind: ArrKind;
  serverId: number;
}

/** A quality or quality group in a profile. */
export interface ArrProfileItem {
  id?: number;
  name?: string;
  quality?: { id: number; name: string; resolution?: number };
  items: ArrProfileItem[];
  allowed: boolean;
  /** Sonarr v5: per-quality sizes in MB per minute. */
  minSize?: number | null;
  maxSize?: number | null;
  preferredSize?: number | null;
}

export interface ArrDelayProfile {
  id: number;
  enableUsenet: boolean;
  enableTorrent: boolean;
  preferredProtocol: 'usenet' | 'torrent';
  usenetDelay: number;
  torrentDelay: number;
  order: number;
  tags: number[];
  [field: string]: unknown;
}

export interface ArrParsed {
  quality?: string;
  /** Languages Radarr or Sonarr parsed from the name. */
  languages: string[];
  formats: { id: number; name: string }[];
}

export interface ArrTitle {
  id: number;
  title: string;
  profileId: number;
  hasFile: boolean;
  monitored: boolean;
  added?: string;
  /** Released (movie) or has aired episodes (series). */
  wanted: boolean;
}

export interface ArrGrab {
  title: string;
  date: string;
  score: number;
  protocol: 'usenet' | 'torrent' | null;
  quality?: string;
  profileId?: number;
}

const PROTOCOLS: Record<string, 'usenet' | 'torrent'> = {
  '1': 'usenet',
  usenet: 'usenet',
  '2': 'torrent',
  torrent: 'torrent',
};

class QualityRadarr extends RadarrAPI {
  public get http(): AxiosInstance {
    return this.axios;
  }
}

class QualitySonarr extends SonarrAPI {
  public get http(): AxiosInstance {
    return this.axios;
  }
}

export const serverSettingsOf = (
  ref: QualityServerRef
): RadarrSettings | SonarrSettings | undefined =>
  (ref.kind === 'radarr' ? getSettings().radarr : getSettings().sonarr).find(
    (s) => s.id === ref.serverId
  );

export class QualityArr {
  constructor(
    public readonly kind: ArrKind,
    private readonly http: AxiosInstance
  ) {}

  static forServer(ref: QualityServerRef): QualityArr | undefined {
    const server = serverSettingsOf(ref);
    if (!server) return undefined;
    const options = {
      apiKey: server.apiKey,
      url:
        ref.kind === 'radarr'
          ? RadarrAPI.buildUrl(server, '/api/v3')
          : SonarrAPI.buildUrl(server, '/api/v3'),
    };
    const api =
      ref.kind === 'radarr'
        ? new QualityRadarr(options)
        : new QualitySonarr(options);
    return new QualityArr(ref.kind, api.http);
  }

  /** App version, e.g. "5.0.0.2870". */
  async version(): Promise<string> {
    const { data } = await this.http.get<{ version?: string }>(
      '/system/status'
    );
    return data?.version ?? '';
  }

  /** The app's default new profile: every quality, in order. */
  async template(): Promise<ArrQualityProfile> {
    const { data } = await this.http.get<ArrQualityProfile>(
      '/qualityprofile/schema'
    );
    return data;
  }

  async profiles(): Promise<ArrQualityProfile[]> {
    const { data } =
      await this.http.get<ArrQualityProfile[]>('/qualityprofile');
    return Array.isArray(data) ? data : [];
  }

  async createProfile(
    profile: Omit<ArrQualityProfile, 'id'>
  ): Promise<ArrQualityProfile> {
    const { data } = await this.http.post<ArrQualityProfile>(
      '/qualityprofile',
      profile
    );
    return data;
  }

  async saveProfile(profile: ArrQualityProfile): Promise<ArrQualityProfile> {
    const { data } = await this.http.put<ArrQualityProfile>(
      `/qualityprofile/${profile.id}`,
      profile
    );
    return data ?? profile;
  }

  async deleteProfile(id: number): Promise<void> {
    await this.http.delete(`/qualityprofile/${id}`);
  }

  async formats(): Promise<ArrCustomFormat[]> {
    const { data } = await this.http.get<ArrCustomFormat[]>('/customformat');
    return Array.isArray(data) ? data : [];
  }

  async saveFormat(format: ArrCustomFormat): Promise<ArrCustomFormat> {
    return format.id
      ? (
          await this.http.put<ArrCustomFormat>(
            `/customformat/${format.id}`,
            format
          )
        ).data
      : (await this.http.post<ArrCustomFormat>('/customformat', format)).data;
  }

  async deleteFormat(id: number): Promise<void> {
    await this.http.delete(`/customformat/${id}`);
  }

  async delayProfiles(): Promise<ArrDelayProfile[]> {
    const { data } = await this.http.get<ArrDelayProfile[]>('/delayprofile');
    return Array.isArray(data) ? data : [];
  }

  async saveDelayProfile(profile: ArrDelayProfile): Promise<void> {
    await this.http.put(`/delayprofile/${profile.id}`, profile);
  }

  /** How the app parses a release name, and the formats it matches. */
  async parse(title: string): Promise<ArrParsed> {
    const { data } = await this.http.get<{
      parsedMovieInfo?: { quality?: { quality?: { name?: string } } };
      parsedEpisodeInfo?: { quality?: { quality?: { name?: string } } };
      languages?: { name?: string }[];
      customFormats?: { id: number; name: string }[];
    }>('/parse', { params: { title } });
    const info = data?.parsedMovieInfo ?? data?.parsedEpisodeInfo;
    return {
      quality: info?.quality?.quality?.name,
      languages: (data?.languages ?? [])
        .map((l) => l.name ?? '')
        .filter(Boolean),
      formats: data?.customFormats ?? [],
    };
  }

  /** Recent grabs, newest first, with each title's profile. */
  async grabs(count = 100): Promise<ArrGrab[]> {
    const { data } = await this.http.get<{
      records?: {
        sourceTitle: string;
        date: string;
        customFormatScore?: number;
        quality?: { quality?: { name?: string } };
        data?: Record<string, string | null | undefined>;
        movie?: { qualityProfileId?: number };
        series?: { qualityProfileId?: number };
      }[];
    }>('/history', {
      params: {
        page: 1,
        pageSize: count,
        sortKey: 'date',
        sortDirection: 'descending',
        eventType: 1,
        ...(this.kind === 'radarr'
          ? { includeMovie: true }
          : { includeSeries: true }),
      },
    });
    return (data?.records ?? []).map((r) => ({
      title: r.sourceTitle,
      date: r.date,
      score: Number(r.customFormatScore ?? r.data?.customFormatScore ?? 0),
      protocol: PROTOCOLS[String(r.data?.protocol ?? '').toLowerCase()] ?? null,
      quality: r.quality?.quality?.name,
      profileId: (r.movie ?? r.series)?.qualityProfileId,
    }));
  }

  /** Every movie or series with its id, title and profile. */
  async titles(): Promise<ArrTitle[]> {
    const { data } = await this.http.get<
      {
        id: number;
        title: string;
        qualityProfileId: number;
        hasFile?: boolean;
        monitored?: boolean;
        added?: string;
        isAvailable?: boolean;
        status?: string;
        statistics?: { episodeFileCount?: number; episodeCount?: number };
      }[]
    >(this.kind === 'radarr' ? '/movie' : '/series');
    return (Array.isArray(data) ? data : []).map((t) => ({
      id: t.id,
      title: t.title,
      profileId: t.qualityProfileId,
      hasFile:
        this.kind === 'radarr'
          ? !!t.hasFile
          : (t.statistics?.episodeFileCount ?? 0) > 0,
      monitored: t.monitored !== false,
      added: t.added,
      // An unreleased movie or a series with nothing aired isn't missing.
      wanted:
        this.kind === 'radarr'
          ? t.isAvailable !== false
          : (t.statistics?.episodeCount ?? 0) > 0,
    }));
  }

  /** Moves movies or series to a profile. */
  async moveTitles(ids: number[], profileId: number): Promise<void> {
    if (!ids.length) return;
    await this.http.put(
      this.kind === 'radarr' ? '/movie/editor' : '/series/editor',
      this.kind === 'radarr'
        ? { movieIds: ids, qualityProfileId: profileId }
        : { seriesIds: ids, qualityProfileId: profileId }
    );
  }

  /** Starts a search for movies or series. */
  async search(ids: number[]): Promise<void> {
    if (!ids.length) return;
    if (this.kind === 'radarr') {
      await this.http.post('/command', { name: 'MoviesSearch', movieIds: ids });
      return;
    }
    // Sonarr's SeriesSearch takes one series per command.
    for (const id of ids) {
      await this.http.post('/command', { name: 'SeriesSearch', seriesId: id });
    }
  }
}
