import type { BazarrSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';
import axios from 'axios';

/*
 * The part of Bazarr's API Seerr uses. Bazarr knows a movie by its Radarr
 * id and an episode by its Sonarr ids, the same ids Seerr records for a
 * title it sent to Radarr or Sonarr.
 *
 * Bazarr runs a manual download, and its search for what a title is
 * missing, as a job in its queue, and answers as soon as the job is
 * queued; the job may wait behind others, and a Whisper transcription
 * takes as long as the audio does. So each of those is followed in
 * Bazarr's job list until it ends. A Bazarr with no job list does the
 * work before it answers, as Bazarr once did, and is waited on instead.
 */

/** Long enough for a busy Bazarr, short enough never to hold up a page. */
const READ_TIMEOUT_MS = 15_000;
/** A manual search asks every provider Bazarr has. */
const SEARCH_TIMEOUT_MS = 90_000;
/** A download, which Bazarr may also sync to the audio. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** A Whisper transcription of a whole film, queue included. */
const TRANSCRIBE_TIMEOUT_MS = 24 * 60 * 60_000;
/** Bazarr searching every missing subtitle of a series, start to finish. */
const SEARCH_MISSING_TIMEOUT_MS = 2 * 60 * 60_000;
/** How often a job Bazarr queued is looked at. */
export const bazarrJobPoll = { ms: 5_000 };

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
  /** When, as Bazarr writes it ("10/25/26 16:55:00"). */
  parsed_timestamp?: string;
  description?: string;
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

/** A job in Bazarr's queue: a download, a search, a sync. */
export interface BazarrJob {
  job_id: number;
  /** "Manually downloading Subtitles for …", once it runs. */
  job_name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled' | string;
}

/**
 * How a job Bazarr was given ended: finished (or done before Bazarr
 * answered), failed or canceled, gone from the list (Bazarr restarted),
 * or still not over when Seerr stopped waiting.
 */
export type BazarrJobEnd = 'finished' | 'failed' | 'gone' | 'timedOut';

/** What following a job tells along the way. */
export interface JobWatch {
  /** Bazarr has queued it but not started it yet. */
  onWaiting?: () => void;
  /** Bazarr has started it. */
  onRunning?: () => void;
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

  /** Bazarr's job queue: what is waiting, running and recently done. */
  public async getJobs(): Promise<BazarrJob[]> {
    const { data } = await this.read<{ data: BazarrJob[] }>('/system/jobs');
    if (!Array.isArray(data)) {
      throw new Error('Bazarr: not an API answer');
    }
    return data;
  }

  /**
   * Asks Bazarr for something it runs as a job, and follows that job until
   * it ends. The job is the one that appears with a name `named` accepts;
   * with none new (Bazarr already had the same one queued), the one already
   * waiting or running. With no job list to read, the answer itself is the
   * end, as Bazarr once did the work before answering.
   */
  private async asJob(
    ask: (timeout: number) => Promise<void>,
    named: (name: string) => boolean,
    timeout: number,
    watch: JobWatch = {}
  ): Promise<BazarrJobEnd> {
    const before = await this.getJobs().catch(() => undefined);
    if (!before) {
      await ask(timeout);
      return 'finished';
    }
    await ask(READ_TIMEOUT_MS * 4);
    const known = new Set(before.map((job) => job.job_id));
    const deadline = Date.now() + timeout;
    let id: number | undefined;
    let told: string | undefined;
    for (;;) {
      const jobs = await this.getJobs().catch(() => undefined);
      if (jobs) {
        if (id === undefined) {
          const mine = (list: BazarrJob[]) =>
            list
              .filter((job) => named(job.job_name))
              .sort((a, b) => b.job_id - a.job_id)[0]?.job_id;
          id =
            mine(jobs.filter((job) => !known.has(job.job_id))) ??
            mine(
              jobs.filter(
                (job) =>
                  known.has(job.job_id) &&
                  (job.status === 'pending' || job.status === 'running')
              )
            );
          if (id === undefined) {
            // Over before it could be seen.
            return 'finished';
          }
        }
        const job = jobs.find((j) => j.job_id === id);
        if (!job) return 'gone';
        if (job.status === 'completed') return 'finished';
        if (job.status === 'failed' || job.status === 'canceled') {
          return 'failed';
        }
        if (job.status !== told) {
          told = job.status;
          if (job.status === 'pending') watch.onWaiting?.();
          if (job.status === 'running') watch.onRunning?.();
        }
      }
      if (Date.now() >= deadline) return 'timedOut';
      await new Promise((resolve) => setTimeout(resolve, bazarrJobPoll.ms));
    }
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

  /** Bazarr's manual downloads, whatever stage they are at. */
  private static manualDownload = (name: string) =>
    name.startsWith('Manually download');

  /** A manual download, followed until Bazarr is done with it. */
  public async downloadMovie(
    radarrId: number,
    choice: DownloadChoice,
    watch?: JobWatch
  ): Promise<BazarrJobEnd> {
    return this.asJob(
      (timeout) =>
        this.form(
          'post',
          '/providers/movies',
          { radarrid: radarrId, ...this.downloadFields(choice) },
          timeout
        ),
      BazarrAPI.manualDownload,
      choice.provider === WHISPER_PROVIDER
        ? TRANSCRIBE_TIMEOUT_MS
        : DOWNLOAD_TIMEOUT_MS,
      watch
    );
  }

  /** A manual download, followed until Bazarr is done with it. */
  public async downloadEpisode(
    sonarrSeriesId: number,
    sonarrEpisodeId: number,
    choice: DownloadChoice,
    watch?: JobWatch
  ): Promise<BazarrJobEnd> {
    return this.asJob(
      (timeout) =>
        this.form(
          'post',
          '/providers/episodes',
          {
            seriesid: sonarrSeriesId,
            episodeid: sonarrEpisodeId,
            ...this.downloadFields(choice),
          },
          timeout
        ),
      BazarrAPI.manualDownload,
      choice.provider === WHISPER_PROVIDER
        ? TRANSCRIBE_TIMEOUT_MS
        : DOWNLOAD_TIMEOUT_MS,
      watch
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

  private static missingSearch = (name: string) =>
    name.startsWith('Downloading missing subtitles');

  /** Bazarr's own search for whatever the movie is missing, to its end. */
  public async searchMissingMovie(radarrId: number): Promise<BazarrJobEnd> {
    return this.asJob(
      (timeout) =>
        this.form(
          'patch',
          '/movies',
          { radarrid: radarrId, action: 'search-missing' },
          timeout
        ),
      BazarrAPI.missingSearch,
      SEARCH_MISSING_TIMEOUT_MS
    );
  }

  /** Bazarr's own search for whatever the series is missing, to its end. */
  public async searchMissingSeries(
    sonarrSeriesId: number
  ): Promise<BazarrJobEnd> {
    return this.asJob(
      (timeout) =>
        this.form(
          'patch',
          '/series',
          { seriesid: sonarrSeriesId, action: 'search-missing' },
          timeout
        ),
      BazarrAPI.missingSearch,
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
