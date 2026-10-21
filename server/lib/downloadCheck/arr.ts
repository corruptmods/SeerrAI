import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type {
  SeriesEpisode,
  TitleFacts,
} from '@server/lib/downloadCheck/names';
import type { Quality } from '@server/lib/downloadCheck/rules';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';

/*
 * The Sonarr and Radarr calls Download Check makes, in one shape for both:
 * the queue (downloads waiting, downloading and blocked), the title each is
 * filed under, the files there already, and the three things it does about
 * a download: take it out of the queue, import it, or search again.
 */

export type ArrApp = 'sonarr' | 'radarr';

export interface QueueEpisode extends SeriesEpisode {
  airDateUtc?: string;
  episodeFileId?: number;
}

/** One download in a queue; a pack's records joined into one. */
export interface Grab {
  /** The download client's id in lower case, or the title while waiting. */
  key: string;
  downloadId?: string;
  /** Every queue record it has (Sonarr lists a pack once per episode). */
  queueIds: number[];
  title: string;
  protocol: string;
  /** "delay" while a delay profile holds it, before any client has it. */
  status: string;
  /** downloading, importPending, importBlocked, importing, imported… */
  state: string;
  /** ok, warning or error. */
  trackedStatus: string;
  /** What the server says is wrong, every line. */
  messages: string[];
  /** When the server took it, or held it back. */
  added?: string;
  size: number;
  sizeLeft: number;
  quality?: Quality;
  customFormatScore?: number;
  /** Sonarr's series, Radarr's movie. */
  itemId: number;
  /** Sonarr: the episodes it's filed as. */
  episodes: QueueEpisode[];
}

/** A file Sonarr or Radarr would import from a download, as it reads it. */
export interface ImportCandidate {
  path: string;
  size: number;
  episodeIds: number[];
  quality?: Quality;
  customFormatScore?: number;
  languages?: unknown[];
  releaseGroup?: string;
  indexerFlags?: number;
  releaseType?: string;
}

/**
 * What a file going in is: the episodes, or the movie. The download's id
 * ties the import to it, so the server finishes the download as its own.
 */
export interface ImportFile extends ImportCandidate {
  itemId: number;
  downloadId: string;
}

export interface HeldFile {
  quality: Quality;
  customFormatScore?: number;
}

export interface ItemFacts extends TitleFacts {
  qualityProfileId: number;
  poster?: string;
  /** Radarr: the movie's file. */
  movieFile?: HeldFile & { id: number };
}

export interface Removal {
  /** Delete it from the download client too. */
  removeFromClient: boolean;
  /** Never grab this release again. */
  blocklist: boolean;
  /** Don't search again for what it was meant to bring. */
  skipRedownload: boolean;
}

export interface CheckServer {
  readonly app: ArrApp;
  queue(): Promise<Grab[]>;
  /** The title a name parses to on this server, if any. */
  parsedItem(title: string): Promise<number | undefined>;
  facts(itemId: number): Promise<ItemFacts>;
  /** Sonarr: every episode of a series, with the file each has. */
  episodes(itemId: number): Promise<QueueEpisode[]>;
  /** Sonarr: a series' files; Radarr: the movie's. */
  files(itemId: number): Promise<Map<number, HeldFile>>;
  profile(id: number): Promise<{ items: unknown[] }>;
  candidates(downloadId: string, itemId: number): Promise<ImportCandidate[]>;
  manualImport(files: ImportFile[]): Promise<number>;
  command(id: number): Promise<{ status: string; message?: string }>;
  remove(queueIds: number[], how: Removal): Promise<void>;
  search(itemId: number, episodeIds: number[]): Promise<void>;
}

/** A queue's records, a page at a time; packs come once per episode. */
const QUEUE_PAGE = 500;
const QUEUE_PAGES = 10;

interface RawQueueRecord {
  id: number;
  downloadId?: string;
  title?: string;
  protocol?: string;
  status?: string;
  trackedDownloadState?: string;
  trackedDownloadStatus?: string;
  statusMessages?: { title?: string; messages?: string[] }[];
  errorMessage?: string;
  added?: string;
  size?: number;
  sizeleft?: number;
  quality?: Quality;
  customFormatScore?: number;
  seriesId?: number;
  movieId?: number;
  episodeId?: number;
  episode?: QueueEpisode & { seriesId?: number };
}

const lower = (value?: string) => (value ?? '').toLowerCase();

/** One Grab per download: a pack's records joined, waiting ones by title. */
export const grabsOf = (records: RawQueueRecord[], app: ArrApp): Grab[] => {
  const grabs = new Map<string, Grab>();
  for (const r of records) {
    const itemId = (app === 'sonarr' ? r.seriesId : r.movieId) ?? 0;
    if (!itemId || !r.title) continue;
    const key = r.downloadId
      ? r.downloadId.toLowerCase()
      : `waiting:${itemId}:${r.title.toLowerCase()}`;
    const grab =
      grabs.get(key) ??
      ({
        key,
        downloadId: r.downloadId,
        queueIds: [],
        title: r.title,
        protocol: lower(r.protocol),
        status: lower(r.status),
        state: lower(r.trackedDownloadState),
        trackedStatus: lower(r.trackedDownloadStatus),
        messages: [],
        added: r.added,
        size: r.size ?? 0,
        sizeLeft: r.sizeleft ?? 0,
        quality: r.quality,
        customFormatScore: r.customFormatScore,
        itemId,
        episodes: [],
      } satisfies Grab);
    grab.queueIds.push(r.id);
    for (const m of r.statusMessages ?? []) {
      for (const line of m.messages ?? []) {
        if (line && !grab.messages.includes(line)) grab.messages.push(line);
      }
    }
    if (r.errorMessage && !grab.messages.includes(r.errorMessage)) {
      grab.messages.push(r.errorMessage);
    }
    if (r.episode && !grab.episodes.some((e) => e.id === r.episode!.id)) {
      grab.episodes.push({
        id: r.episode.id,
        seasonNumber: r.episode.seasonNumber,
        episodeNumber: r.episode.episodeNumber,
        title: r.episode.title,
        airDateUtc: r.episode.airDateUtc,
        hasFile: !!r.episode.hasFile,
        episodeFileId: r.episode.episodeFileId,
      });
    }
    grabs.set(key, grab);
  }
  return [...grabs.values()];
};

const posterOf = (images?: { coverType: string; remoteUrl?: string }[]) =>
  images?.find((i) => i.coverType === 'poster')?.remoteUrl;

interface RawCandidate {
  path: string;
  size?: number;
  episodes?: { id: number }[];
  quality?: Quality;
  customFormatScore?: number;
  languages?: unknown[];
  releaseGroup?: string;
  indexerFlags?: number;
  releaseType?: string;
}

const candidatesOf = (data: unknown): ImportCandidate[] =>
  (Array.isArray(data) ? (data as RawCandidate[]) : []).map((c) => ({
    path: c.path,
    size: c.size ?? 0,
    episodeIds: (c.episodes ?? []).map((e) => e.id),
    quality: c.quality,
    customFormatScore: c.customFormatScore,
    languages: c.languages,
    releaseGroup: c.releaseGroup,
    indexerFlags: c.indexerFlags,
    releaseType: c.releaseType,
  }));

/** Both apps take a queue removal, a command and a profile the same way. */
const shared = (http: AxiosInstance, app: ArrApp) => ({
  async queuePages(params: Record<string, unknown>) {
    const records: RawQueueRecord[] = [];
    for (let page = 1; page <= QUEUE_PAGES; page++) {
      const { data } = await http.get<{
        totalRecords?: number;
        records?: RawQueueRecord[];
      }>('/queue', {
        params: { page, pageSize: QUEUE_PAGE, ...params },
      });
      records.push(...(data?.records ?? []));
      if (
        !data?.records?.length ||
        records.length >= (data.totalRecords ?? 0)
      ) {
        break;
      }
    }
    return grabsOf(records, app);
  },
  async profile(id: number) {
    const { data } = await http.get<{ items: unknown[] }>(
      `/qualityprofile/${id}`
    );
    return data;
  },
  async manualImport(files: Record<string, unknown>[]) {
    const { data } = await http.post<{ id: number }>('/command', {
      name: 'ManualImport',
      // Moves what a Usenet client finished, copies (or hard-links) what a
      // torrent client still seeds, as the server's own import would.
      importMode: 'auto',
      files,
    });
    return data.id;
  },
  async command(id: number) {
    const { data } = await http.get<{ status: string; message?: string }>(
      `/command/${id}`
    );
    return data;
  },
  async remove(queueIds: number[], how: Removal) {
    await http.delete('/queue/bulk', {
      data: { ids: queueIds },
      params: { ...how, changeCategory: false },
    });
  },
});

export class CheckSonarr extends SonarrAPI implements CheckServer {
  public readonly app = 'sonarr' as const;

  static forServer(server: SonarrSettings): CheckSonarr {
    return new CheckSonarr({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    });
  }

  private get both() {
    return shared(this.axios, 'sonarr');
  }

  public queue() {
    return this.both.queuePages({
      includeEpisode: true,
      includeUnknownSeriesItems: false,
    });
  }

  public async parsedItem(title: string) {
    const { data } = await this.axios.get<{ series?: { id: number } }>(
      '/parse',
      { params: { title } }
    );
    return data?.series?.id;
  }

  public async facts(seriesId: number): Promise<ItemFacts> {
    const { data } = await this.axios.get<{
      title: string;
      year?: number;
      originalTitle?: string;
      alternateTitles?: { title: string }[];
      qualityProfileId: number;
      images?: { coverType: string; remoteUrl?: string }[];
    }>(`/series/${seriesId}`);
    return {
      title: data.title,
      year: data.year,
      originalTitle: data.originalTitle,
      alternateTitles: data.alternateTitles,
      qualityProfileId: data.qualityProfileId,
      poster: posterOf(data.images),
    };
  }

  public async episodes(seriesId: number): Promise<QueueEpisode[]> {
    const { data } = await this.axios.get<QueueEpisode[]>('/episode', {
      params: { seriesId },
    });
    return Array.isArray(data)
      ? data.map((e) => ({
          id: e.id,
          seasonNumber: e.seasonNumber,
          episodeNumber: e.episodeNumber,
          title: e.title,
          airDateUtc: e.airDateUtc,
          hasFile: !!e.hasFile,
          episodeFileId: e.episodeFileId,
        }))
      : [];
  }

  public async files(seriesId: number) {
    const { data } = await this.axios.get<
      { id: number; quality: Quality; customFormatScore?: number }[]
    >('/episodefile', { params: { seriesId } });
    return new Map(
      (Array.isArray(data) ? data : []).map((f) => [
        f.id,
        { quality: f.quality, customFormatScore: f.customFormatScore },
      ])
    );
  }

  public profile(id: number) {
    return this.both.profile(id);
  }

  public async candidates(downloadId: string, seriesId: number) {
    const { data } = await this.axios.get('/manualimport', {
      params: { downloadId, seriesId, filterExistingFiles: false },
    });
    return candidatesOf(data);
  }

  public manualImport(files: ImportFile[]) {
    return this.both.manualImport(
      files.map((f) => ({
        path: f.path,
        seriesId: f.itemId,
        episodeIds: f.episodeIds,
        quality: f.quality,
        languages: f.languages,
        releaseGroup: f.releaseGroup,
        indexerFlags: f.indexerFlags ?? 0,
        releaseType: f.releaseType,
        downloadId: f.downloadId,
      }))
    );
  }

  public command(id: number) {
    return this.both.command(id);
  }

  public remove(queueIds: number[], how: Removal) {
    return this.both.remove(queueIds, how);
  }

  public async search(_seriesId: number, episodeIds: number[]) {
    if (!episodeIds.length) return;
    await this.axios.post('/command', { name: 'EpisodeSearch', episodeIds });
  }
}

export class CheckRadarr extends RadarrAPI implements CheckServer {
  public readonly app = 'radarr' as const;

  static forServer(server: RadarrSettings): CheckRadarr {
    return new CheckRadarr({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    });
  }

  private get both() {
    return shared(this.axios, 'radarr');
  }

  public queue() {
    return this.both.queuePages({ includeUnknownMovieItems: false });
  }

  public async parsedItem(title: string) {
    const { data } = await this.axios.get<{ movie?: { id: number } }>(
      '/parse',
      { params: { title } }
    );
    return data?.movie?.id;
  }

  public async facts(movieId: number): Promise<ItemFacts> {
    const { data } = await this.axios.get<{
      title: string;
      year?: number;
      originalTitle?: string;
      alternateTitles?: { title: string }[];
      qualityProfileId: number;
      images?: { coverType: string; remoteUrl?: string }[];
      movieFile?: { id: number; quality: Quality; customFormatScore?: number };
    }>(`/movie/${movieId}`);
    // The movie's own copy of its file has no custom format score; the file
    // list does.
    let score: number | undefined;
    if (data.movieFile) {
      const { data: files } = await this.axios.get<
        { id: number; customFormatScore?: number }[]
      >('/moviefile', { params: { movieId } });
      score = (Array.isArray(files) ? files : []).find(
        (f) => f.id === data.movieFile!.id
      )?.customFormatScore;
    }
    return {
      title: data.title,
      year: data.year,
      originalTitle: data.originalTitle,
      alternateTitles: data.alternateTitles,
      qualityProfileId: data.qualityProfileId,
      poster: posterOf(data.images),
      movieFile: data.movieFile
        ? {
            id: data.movieFile.id,
            quality: data.movieFile.quality,
            customFormatScore: score ?? data.movieFile.customFormatScore,
          }
        : undefined,
    };
  }

  public async episodes(): Promise<QueueEpisode[]> {
    return [];
  }

  public async files(movieId: number) {
    const facts = await this.facts(movieId);
    return new Map(
      facts.movieFile ? [[facts.movieFile.id, facts.movieFile]] : []
    );
  }

  public profile(id: number) {
    return this.both.profile(id);
  }

  public async candidates(downloadId: string, movieId: number) {
    const { data } = await this.axios.get('/manualimport', {
      params: { downloadId, movieId, filterExistingFiles: false },
    });
    return candidatesOf(data);
  }

  public manualImport(files: ImportFile[]) {
    return this.both.manualImport(
      files.map((f) => ({
        path: f.path,
        movieId: f.itemId,
        quality: f.quality,
        languages: f.languages,
        releaseGroup: f.releaseGroup,
        indexerFlags: f.indexerFlags ?? 0,
        downloadId: f.downloadId,
      }))
    );
  }

  public command(id: number) {
    return this.both.command(id);
  }

  public remove(queueIds: number[], how: Removal) {
    return this.both.remove(queueIds, how);
  }

  public async search(movieId: number) {
    await this.axios.post('/command', {
      name: 'MoviesSearch',
      movieIds: [movieId],
    });
  }
}
