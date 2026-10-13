import SonarrAPI from '@server/api/servarr/sonarr';
import type { SonarrSettings } from '@server/lib/settings';

/*
 * The Sonarr calls only Backfill makes: parsing a name the way Sonarr would,
 * reading a series' files, quality profile and wanted lists, and running a
 * manual import and following it to the end.
 */

export interface SonarrQuality {
  quality: { id: number; name: string; resolution?: number; source?: string };
  revision: { version: number; real: number; isRepack?: boolean };
}

export interface SonarrLanguage {
  id: number;
  name: string;
}

export interface SonarrEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber?: number;
  title?: string;
  airDateUtc?: string;
  hasFile: boolean;
  monitored: boolean;
  episodeFileId: number;
  lastSearchTime?: string;
}

export interface SonarrEpisodeFile {
  id: number;
  seasonNumber: number;
  relativePath?: string;
  path?: string;
  size: number;
  quality: SonarrQuality;
  customFormatScore?: number;
  releaseGroup?: string;
  languages?: SonarrLanguage[];
  /** What Sonarr read from the file itself: "eng", "eng/jpn"; "13:43". */
  mediaInfo?: { audioLanguages?: string; subtitles?: string; runTime?: string };
}

export interface SonarrParseResult {
  title: string;
  parsedEpisodeInfo?: {
    seriesTitle?: string;
    quality?: SonarrQuality;
    /** Undefined when the name has no season (see `seasonOrNone`). */
    seasonNumber?: number;
    /** Sonarr v5: every season a pack covers. */
    seasonNumbers?: number[];
    episodeNumbers?: number[];
    absoluteEpisodeNumbers?: number[];
    releaseGroup?: string;
    fullSeason?: boolean;
    isMultiSeason?: boolean;
    special?: boolean;
  };
  series?: { id: number; title: string };
  episodes?: SonarrEpisode[];
  languages?: SonarrLanguage[];
  customFormats?: { id: number; name: string }[];
  customFormatScore?: number;
}

export interface SonarrProfileItem {
  id?: number;
  name?: string;
  quality?: { id: number; name: string };
  items?: SonarrProfileItem[];
  allowed: boolean;
}

export interface SonarrQualityProfile {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  cutoff: number;
  items: SonarrProfileItem[];
  minFormatScore: number;
  cutoffFormatScore: number;
  minUpgradeFormatScore?: number;
}

export interface SonarrWantedRecord {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  airDateUtc?: string;
  lastSearchTime?: string;
  monitored: boolean;
  series?: {
    id: number;
    title: string;
    year?: number;
    tvdbId?: number;
    tmdbId?: number;
    seriesType?: string;
    monitored?: boolean;
    /** When it was added to Sonarr. */
    added?: string;
    images?: { coverType: string; remoteUrl?: string }[];
  };
}

export interface SonarrCommand {
  id: number;
  name: string;
  status: 'queued' | 'started' | 'completed' | 'failed' | 'aborted' | string;
  result?: string;
  message?: string;
  /** What it was asked for: a search's series, episodes or movies. */
  body?: {
    seriesId?: number;
    episodeIds?: number[];
    movieIds?: number[];
  };
}

export interface SonarrRemotePathMapping {
  host: string;
  remotePath: string;
  localPath: string;
}

/** A result of Sonarr's or Radarr's own indexer search. */
export interface ArrSearchRelease {
  guid: string;
  title: string;
  indexerId: number;
  indexer?: string;
  protocol?: 'torrent' | 'usenet' | string;
  size?: number;
  seeders?: number;
  publishDate?: string;
  downloadUrl?: string;
  magnetUrl?: string;
  infoHash?: string;
  approved?: boolean;
  rejections?: (string | { reason?: string })[];
  fullSeason?: boolean;
  /** Undefined when the name has no season (see `seasonOrNone`). */
  seasonNumber?: number;
  /** Sonarr v5: every season a pack covers, "S01-S03" as [1, 2, 3]. */
  seasonNumbers?: number[];
  mappedEpisodeNumbers?: number[];
  mappedSeasonNumber?: number;
  quality?: { quality: { id: number; name: string } };
  languages?: SonarrLanguage[];
}

/**
 * A season number as Sonarr reads it from a name, or undefined when the name
 * has none. Sonarr v5 says -1 for that where v4 said 0, in a parse and in
 * search results alike; 0 stays as it was, as v4 also uses it for specials.
 */
export const seasonOrNone = (season?: number | null): number | undefined =>
  season === undefined || season === null || season < 0 ? undefined : season;

/**
 * An indexer search can take a while across many indexers; an anime season
 * minutes, since Sonarr searches it episode by episode.
 */
export const RELEASE_SEARCH_TIMEOUT_MS = 10 * 60_000;

export interface SonarrSeriesDetail {
  id: number;
  title: string;
  year: number;
  tvdbId: number;
  tmdbId?: number;
  seriesType: 'standard' | 'daily' | 'anime';
  qualityProfileId: number;
  path: string;
  alternateTitles?: { title: string; seasonNumber?: number }[];
  /**
   * Sonarr v5: the title in its original language. `title` is then in the
   * language chosen for the series, which need not be the one releases use.
   */
  originalTitle?: string;
  originalLanguage?: { id: number; name: string };
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
  statistics?: { episodeFileCount: number; episodeCount: number };
  /** An episode's usual length, in minutes. */
  runtime?: number;
}

export interface ManualImportFile {
  path: string;
  seriesId: number;
  episodeIds: number[];
  quality: SonarrQuality;
  languages: SonarrLanguage[];
  releaseGroup?: string;
}

/** A command's ending states. */
export const commandFinished = (status: string): boolean =>
  ['completed', 'failed', 'aborted', 'cancelled', 'orphaned'].includes(status);

class BackfillSonarr extends SonarrAPI {
  static forServer(server: SonarrSettings): BackfillSonarr {
    return new BackfillSonarr({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    });
  }

  public async parse(title: string): Promise<SonarrParseResult> {
    const { data } = await this.axios.get<SonarrParseResult>('/parse', {
      params: { title },
    });
    if (data?.parsedEpisodeInfo) {
      data.parsedEpisodeInfo.seasonNumber = seasonOrNone(
        data.parsedEpisodeInfo.seasonNumber
      );
    }
    return data;
  }

  public async getSeriesDetail(id: number): Promise<SonarrSeriesDetail> {
    const { data } = await this.axios.get<SonarrSeriesDetail>(`/series/${id}`);
    return data;
  }

  public async getAllSeries(): Promise<SonarrSeriesDetail[]> {
    const { data } = await this.axios.get<SonarrSeriesDetail[]>('/series');
    return Array.isArray(data) ? data : [];
  }

  public async getSeriesEpisodes(seriesId: number): Promise<SonarrEpisode[]> {
    const { data } = await this.axios.get<SonarrEpisode[]>('/episode', {
      params: { seriesId },
    });
    return Array.isArray(data) ? data : [];
  }

  public async getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]> {
    const { data } = await this.axios.get<SonarrEpisodeFile[]>('/episodefile', {
      params: { seriesId },
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
   * Every monitored, missing episode (or every one below its cutoff), a
   * page at a time, newest first. `complete` is false when there were more
   * than `maxPages` pages: what was left out is still missing, not found.
   */
  public async getWanted(
    kind: 'missing' | 'cutoff',
    maxPages = 40
  ): Promise<{ records: SonarrWantedRecord[]; complete: boolean }> {
    const records: SonarrWantedRecord[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.axios.get<{
        totalRecords: number;
        records: SonarrWantedRecord[];
      }>(`/wanted/${kind}`, {
        params: {
          page,
          pageSize: 250,
          includeSeries: true,
          monitored: true,
          sortKey: 'episodes.airDateUtc',
          sortDirection: 'descending',
        },
      });
      records.push(...(data?.records ?? []));
      if (!data?.records?.length || records.length >= data.totalRecords) {
        return { records, complete: true };
      }
    }
    return { records, complete: false };
  }

  /** The episodes of a series waiting in Sonarr's download queue. */
  public async getSeriesQueueEpisodes(seriesId: number): Promise<number[]> {
    const { data } = await this.axios.get<{
      records?: { episodeId?: number; episode?: { id: number } }[];
    }>('/queue', { params: { seriesIds: seriesId, pageSize: 500 } });
    return (data?.records ?? [])
      .map((r) => r.episodeId ?? r.episode?.id)
      .filter((id): id is number => typeof id === 'number');
  }

  /**
   * Sonarr's own search across its indexers, every result with its
   * reasons for turning it down: a season, or one episode.
   */
  public async getReleases(
    params: { seriesId: number; seasonNumber: number } | { episodeId: number }
  ): Promise<ArrSearchRelease[]> {
    const { data } = await this.axios.get<ArrSearchRelease[]>('/release', {
      params,
      timeout: RELEASE_SEARCH_TIMEOUT_MS,
    });
    return Array.isArray(data)
      ? data.map((release) => ({
          ...release,
          seasonNumber: seasonOrNone(release.seasonNumber),
        }))
      : [];
  }

  public async getSeriesQueueCount(seriesId: number): Promise<number> {
    const { data } = await this.axios.get<{ totalRecords: number }>('/queue', {
      params: { seriesIds: seriesId, pageSize: 1 },
    });
    return Number(data?.totalRecords) || 0;
  }

  /** Root folders with their free space now, not from the hour's cache. */
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

  /** The video files Sonarr sees in a folder, as its own paths. */
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

  /** Starts a manual import; answers the command's id to follow. */
  public async manualImport(files: ManualImportFile[]): Promise<number> {
    const { data } = await this.axios.post<SonarrCommand>('/command', {
      name: 'ManualImport',
      importMode: 'move',
      files,
    });
    return data.id;
  }

  /** Has Sonarr rename files to its naming scheme; answers the command's id. */
  public async renameFiles(seriesId: number, files: number[]): Promise<number> {
    const { data } = await this.axios.post<SonarrCommand>('/command', {
      name: 'RenameFiles',
      seriesId,
      files,
    });
    return data.id;
  }

  public async getCommand(id: number): Promise<SonarrCommand> {
    const { data } = await this.axios.get<SonarrCommand>(`/command/${id}`);
    return data;
  }

  /** Every command Sonarr has queued, running or lately done. */
  public async getCommands(): Promise<SonarrCommand[]> {
    const { data } = await this.axios.get<SonarrCommand[]>('/command');
    return Array.isArray(data) ? data : [];
  }
}

export default BackfillSonarr;
