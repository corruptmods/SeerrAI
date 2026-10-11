import type { BazarrSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';
import axios from 'axios';

/*
 * The part of Bazarr's API Seerr uses. Bazarr knows a movie by its Radarr
 * id and an episode by its Sonarr ids, the same ids Seerr records for a
 * title it sent to Radarr or Sonarr.
 *
 * Bazarr answers a manual download only once the subtitle is on disk, and
 * for its Whisper provider that means once the audio is transcribed, which
 * can take many minutes; those calls get a long timeout of their own.
 */

/** Long enough for a busy Bazarr, short enough never to hold up a page. */
const READ_TIMEOUT_MS = 15_000;
/** A manual search asks every provider Bazarr has. */
const SEARCH_TIMEOUT_MS = 90_000;
/** A download, which Bazarr may also sync to the audio. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** A Whisper transcription of a whole film. */
const TRANSCRIBE_TIMEOUT_MS = 90 * 60_000;
/** Bazarr searching every missing subtitle of a series, start to finish. */
const SEARCH_MISSING_TIMEOUT_MS = 60 * 60_000;

/** A subtitle Bazarr lists for a movie or episode. */
export interface BazarrSubtitle {
  name: string;
  code2: string;
  code3?: string;
  /** Null for a track inside the video file. */
  path: string | null;
  forced: boolean;
  hi: boolean;
  file_size?: number | null;
  embedded_track_id?: number | null;
  id?: number;
}

/** A language a profile wants that has no subtitle yet. */
export interface BazarrMissing {
  name: string;
  code2: string;
  code3?: string;
  forced: boolean;
  hi: boolean;
}

export interface BazarrMovie {
  radarrId: number;
  title: string;
  profileId: number | null;
  sceneName?: string | null;
  audio_language?: { name: string; code2: string }[];
  subtitles: BazarrSubtitle[] | null;
  missing_subtitles: BazarrMissing[] | null;
}

export interface BazarrSeries {
  sonarrSeriesId: number;
  title: string;
  profileId: number | null;
}

export interface BazarrEpisode {
  sonarrSeriesId: number;
  sonarrEpisodeId: number;
  season: number;
  episode: number;
  title: string;
  sceneName?: string | null;
  subtitles: BazarrSubtitle[] | null;
  missing_subtitles: BazarrMissing[] | null;
}

export interface BazarrLanguageProfile {
  profileId: number;
  name: string;
  items: { language: string; hi: string; forced: string }[];
}

export interface BazarrHistoryEntry {
  action: number;
  provider: string | null;
  subtitles_path: string | null;
  language?: { code2: string } | null;
}

/** A result of a manual search, as Bazarr sends it. */
export interface BazarrSearchResult {
  provider: string;
  subtitle: string;
  language: string;
  score: number;
  /** "True" or "False". */
  hearing_impaired: string;
  forced: string;
  original_format: string;
  release_info: string[] | null;
  matches: string[] | null;
  dont_matches: string[] | null;
}

/** The provider Bazarr uses to transcribe audio with Whisper. */
export const WHISPER_PROVIDER = 'whisperai';

const bool = (value: boolean | string) =>
  value === true || String(value).toLowerCase() === 'true' ? 'True' : 'False';

export const bazarrBaseUrl = (
  settings: Pick<BazarrSettings, 'hostname' | 'port' | 'useSsl' | 'urlBase'>
): string => {
  const base = (settings.urlBase ?? '').replace(/^\/+|\/+$/g, '');
  return `${settings.useSsl ? 'https' : 'http'}://${settings.hostname}:${
    settings.port
  }${base ? `/${base}` : ''}`;
};

export const bazarrConfigured = (settings: BazarrSettings): boolean =>
  !!settings.hostname && !!settings.apiKey;

class BazarrAPI {
  private axios: AxiosInstance;

  constructor(
    settings: Pick<
      BazarrSettings,
      'hostname' | 'port' | 'useSsl' | 'urlBase' | 'apiKey'
    >
  ) {
    this.axios = axios.create({
      baseURL: `${bazarrBaseUrl(settings)}/api`,
      timeout: READ_TIMEOUT_MS,
      headers: { 'X-API-KEY': settings.apiKey, Accept: 'application/json' },
    });
  }

  private async read<T>(
    path: string,
    params?: Record<string, unknown>,
    timeout = READ_TIMEOUT_MS
  ): Promise<T> {
    const { data } = await this.axios.get<T>(path, { params, timeout });
    // Bazarr answers an unknown path with its web page, not an error.
    if (typeof data === 'string') {
      throw new Error('Bazarr: not an API answer');
    }
    return data;
  }

  private async form(
    method: 'post' | 'patch',
    path: string,
    fields: Record<string, string | number>,
    timeout: number
  ): Promise<void> {
    const body = new URLSearchParams(
      Object.entries(fields).map(([key, value]) => [key, String(value)])
    ).toString();
    await this.axios.request({
      method,
      url: path,
      data: body,
      timeout,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  /** Bazarr's version; also proves the address and API key work. */
  public async getVersion(): Promise<string> {
    const { data } = await this.read<{ data: { bazarr_version?: string } }>(
      '/system/status'
    );
    if (!data) {
      throw new Error('Bazarr: not an API answer');
    }
    return data.bazarr_version ?? 'unknown';
  }

  public async getLanguageProfiles(): Promise<BazarrLanguageProfile[]> {
    const data = await this.read<BazarrLanguageProfile[]>(
      '/system/languages/profiles'
    );
    return Array.isArray(data) ? data : [];
  }

  public async getMovie(radarrId: number): Promise<BazarrMovie | undefined> {
    const { data } = await this.read<{ data: BazarrMovie[] }>('/movies', {
      'radarrid[]': radarrId,
    });
    return data?.[0];
  }

  public async getSeries(
    sonarrSeriesId: number
  ): Promise<BazarrSeries | undefined> {
    const { data } = await this.read<{ data: BazarrSeries[] }>('/series', {
      'seriesid[]': sonarrSeriesId,
    });
    return data?.[0];
  }

  public async getEpisodes(sonarrSeriesId: number): Promise<BazarrEpisode[]> {
    const { data } = await this.read<{ data: BazarrEpisode[] }>('/episodes', {
      'seriesid[]': sonarrSeriesId,
    });
    return data ?? [];
  }

  /** Newest first. */
  public async getMovieHistory(
    radarrId: number
  ): Promise<BazarrHistoryEntry[]> {
    const { data } = await this.read<{ data: BazarrHistoryEntry[] }>(
      '/movies/history',
      { radarrid: radarrId, start: 0, length: 50 }
    );
    return data ?? [];
  }

  /** Newest first. */
  public async getEpisodeHistory(
    sonarrEpisodeId: number
  ): Promise<BazarrHistoryEntry[]> {
    const { data } = await this.read<{ data: BazarrHistoryEntry[] }>(
      '/episodes/history',
      { episodeid: sonarrEpisodeId, start: 0, length: 20 }
    );
    return data ?? [];
  }

  /** The providers Bazarr has turned on, by name ("whisperai"). */
  /** What Bazarr's own System → Status page lists as wrong. */
  public async getHealth(): Promise<{ object?: string; issue?: string }[]> {
    const { data } = await this.read<{
      data: { object?: string; issue?: string }[];
    }>('/system/health');
    return Array.isArray(data) ? data : [];
  }

  public async getProviders(): Promise<string[]> {
    return (await this.getProviderStatus()).map((provider) => provider.name);
  }

  /**
   * The providers Bazarr has turned on and how each stands: "Good", or the
   * error that made Bazarr pause it ("ReadTimeout") and when it tries again
   * ("in 41 minutes").
   */
  public async getProviderStatus(): Promise<
    { name: string; status?: string; retry?: string }[]
  > {
    const { data } = await this.read<{
      data: { name: string; status?: string; retry?: string }[];
    }>('/providers');
    return data ?? [];
  }

  public async searchMovie(radarrId: number): Promise<BazarrSearchResult[]> {
    const { data } = await this.read<{ data: BazarrSearchResult[] }>(
      '/providers/movies',
      { radarrid: radarrId },
      SEARCH_TIMEOUT_MS
    );
    return data ?? [];
  }

  public async searchEpisode(
    sonarrEpisodeId: number
  ): Promise<BazarrSearchResult[]> {
    const { data } = await this.read<{ data: BazarrSearchResult[] }>(
      '/providers/episodes',
      { episodeid: sonarrEpisodeId },
      SEARCH_TIMEOUT_MS
    );
    return data ?? [];
  }

  private downloadFields(result: DownloadChoice) {
    return {
      hi: bool(result.hi),
      forced: bool(result.forced),
      original_format: bool(result.originalFormat),
      provider: result.provider,
      subtitle: result.subtitle,
    };
  }

  public async downloadMovie(
    radarrId: number,
    choice: DownloadChoice
  ): Promise<void> {
    await this.form(
      'post',
      '/providers/movies',
      { radarrid: radarrId, ...this.downloadFields(choice) },
      choice.provider === WHISPER_PROVIDER
        ? TRANSCRIBE_TIMEOUT_MS
        : DOWNLOAD_TIMEOUT_MS
    );
  }

  public async downloadEpisode(
    sonarrSeriesId: number,
    sonarrEpisodeId: number,
    choice: DownloadChoice
  ): Promise<void> {
    await this.form(
      'post',
      '/providers/episodes',
      {
        seriesid: sonarrSeriesId,
        episodeid: sonarrEpisodeId,
        ...this.downloadFields(choice),
      },
      choice.provider === WHISPER_PROVIDER
        ? TRANSCRIBE_TIMEOUT_MS
        : DOWNLOAD_TIMEOUT_MS
    );
  }

  public async deleteMovieSubtitle(
    radarrId: number,
    subtitle: Pick<BazarrSubtitle, 'code2' | 'forced' | 'hi' | 'path'>
  ): Promise<void> {
    await this.axios.delete('/movies/subtitles', {
      params: {
        radarrid: radarrId,
        language: subtitle.code2,
        forced: bool(subtitle.forced),
        hi: bool(subtitle.hi),
        path: subtitle.path,
      },
    });
  }

  public async deleteEpisodeSubtitle(
    sonarrSeriesId: number,
    sonarrEpisodeId: number,
    subtitle: Pick<BazarrSubtitle, 'code2' | 'forced' | 'hi' | 'path'>
  ): Promise<void> {
    await this.axios.delete('/episodes/subtitles', {
      params: {
        seriesid: sonarrSeriesId,
        episodeid: sonarrEpisodeId,
        language: subtitle.code2,
        forced: bool(subtitle.forced),
        hi: bool(subtitle.hi),
        path: subtitle.path,
      },
    });
  }

  /** Bazarr's own search for whatever the movie is missing. */
  public async searchMissingMovie(radarrId: number): Promise<void> {
    await this.form(
      'patch',
      '/movies',
      { radarrid: radarrId, action: 'search-missing' },
      SEARCH_MISSING_TIMEOUT_MS
    );
  }

  /** Bazarr's own search for whatever the series is missing. */
  public async searchMissingSeries(sonarrSeriesId: number): Promise<void> {
    await this.form(
      'patch',
      '/series',
      { seriesid: sonarrSeriesId, action: 'search-missing' },
      SEARCH_MISSING_TIMEOUT_MS
    );
  }
}

/** Which search result to download. */
export interface DownloadChoice {
  provider: string;
  subtitle: string;
  hi: boolean | string;
  forced: boolean | string;
  originalFormat: boolean | string;
}

export default BazarrAPI;
