import ExternalAPI from '@server/api/externalapi';
import type { AvailableCacheIds } from '@server/lib/cache';
import cacheManager from '@server/lib/cache';
import { getSettings, type DVRSettings } from '@server/lib/settings';
import { hostRefusedMessage, refusedHost } from '@server/utils/hostRefused';

export interface SystemStatus {
  version: string;
  buildTime: Date;
  isDebug: boolean;
  isProduction: boolean;
  isAdmin: boolean;
  isUserInteractive: boolean;
  startupPath: string;
  appData: string;
  osName: string;
  osVersion: string;
  isNetCore: boolean;
  isMono: boolean;
  isLinux: boolean;
  isOsx: boolean;
  isWindows: boolean;
  isDocker: boolean;
  mode: string;
  branch: string;
  authentication: string;
  sqliteVersion: string;
  migrationVersion: number;
  urlBase: string;
  runtimeVersion: string;
  runtimeName: string;
  startTime: Date;
  packageUpdateMechanism: string;
}

/** One issue from a Sonarr, Radarr or Prowlarr health page. */
export interface ServarrHealthIssue {
  source: string;
  type: 'ok' | 'notice' | 'warning' | 'error';
  message: string;
  wikiUrl?: string;
}

export interface RootFolder {
  id: number;
  path: string;
  freeSpace: number;
  totalSpace: number;
  unmappedFolders: {
    name: string;
    path: string;
  }[];
}

export interface QualityProfile {
  id: number;
  name: string;
}

interface QueueItem {
  size: number;
  title: string;
  sizeleft: number;
  timeleft: string;
  estimatedCompletionTime: string;
  status: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  downloadId: string;
  protocol: string;
  downloadClient: string;
  indexer: string;
  id: number;
}

export interface Tag {
  id: number;
  label: string;
}

/** A download Radarr or Sonarr imported, from its history. */
export interface ImportRecord {
  /** History id; only increases. */
  id: number;
  date: string;
  /** None for a manual import. */
  downloadId?: string;
  sourceTitle: string;
  movieId?: number;
  seriesId?: number;
  episode?: {
    id: number;
    seasonNumber: number;
    episodeNumber: number;
    absoluteEpisodeNumber?: number;
  };
  data?: { size?: string };
}

const QUEUE_PAGE_SIZE = 250;
const QUEUE_MAX_PAGES = 20;

interface QueueResponse<QueueItemAppendT> {
  page: number;
  pageSize: number;
  sortKey: string;
  sortDirection: string;
  totalRecords: number;
  records: (QueueItem & QueueItemAppendT)[];
}

class ServarrBase<QueueItemAppendT> extends ExternalAPI {
  static buildUrl(settings: DVRSettings, path?: string): string {
    return `${settings.useSsl ? 'https' : 'http'}://${settings.hostname}:${
      settings.port
    }${settings.baseUrl ?? ''}${path}`;
  }

  protected apiName: string;

  constructor({
    url,
    apiKey,
    cacheName,
    apiName,
  }: {
    url: string;
    apiKey: string;
    cacheName: AvailableCacheIds;
    apiName: string;
  }) {
    const timeout = getSettings().network.apiRequestTimeout;

    super(
      url,
      {
        apikey: apiKey,
      },
      {
        nodeCache: cacheManager.getCache(cacheName).data,
        timeout,
      }
    );

    this.apiName = apiName;
    // Settings → Network → API Request Timeout as it is now, for requests
    // that don't set their own.
    this.axios.interceptors.request.use((config) => {
      if (config.timeout === timeout) {
        config.timeout = getSettings().network.apiRequestTimeout;
      }
      return config;
    });
    // Refused for the hostname used: say how to allow Seerr AI instead of
    // "status code 400".
    this.axios.interceptors.response.use(undefined, (e) => {
      const host = refusedHost(e);
      if (host !== undefined && e instanceof Error) {
        e.message = hostRefusedMessage(apiName, host);
      }
      return Promise.reject(e);
    });
  }

  public getSystemStatus = async (): Promise<SystemStatus> => {
    try {
      const response = await this.axios.get<SystemStatus>('/system/status');

      return response.data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve system status: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getProfiles = async (): Promise<QualityProfile[]> => {
    try {
      const data = await this.getRolling<QualityProfile[]>(
        `/qualityProfile`,
        undefined,
        3600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve profiles: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getRootFolders = async (): Promise<RootFolder[]> => {
    try {
      const data = await this.getRolling<RootFolder[]>(
        `/rootfolder`,
        undefined,
        3600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve root folders: ${e.message}`,
        { cause: e }
      );
    }
  };

  /** Root folders with current free space; never cached. */
  public getRootFolderSpace = async (): Promise<RootFolder[]> => {
    const response = await this.axios.get<RootFolder[]>('/rootfolder');
    return response.data;
  };

  /**
   * The app's health issues: unreachable indexers or download clients,
   * missing root folders, failing imports and the like.
   */
  public getHealth = async (): Promise<ServarrHealthIssue[]> => {
    const response = await this.axios.get<ServarrHealthIssue[]>('/health');
    return response.data ?? [];
  };

  /**
   * The whole download queue. `include` adds what each item is for: Sonarr
   * episodes by default, or Lidarr albums and artists.
   */
  public getQueue = async (
    include: Record<string, boolean> = { includeEpisode: true }
  ): Promise<(QueueItem & QueueItemAppendT)[]> => {
    try {
      // Read every page (10 items by default) so a busy queue doesn't leave
      // titles without progress.
      const records: (QueueItem & QueueItemAppendT)[] = [];
      for (let page = 1; page <= QUEUE_MAX_PAGES; page++) {
        const response = await this.axios.get<QueueResponse<QueueItemAppendT>>(
          `/queue`,
          {
            params: {
              ...include,
              page,
              pageSize: QUEUE_PAGE_SIZE,
            },
          }
        );
        records.push(...response.data.records);
        if (
          !response.data.records.length ||
          records.length >= response.data.totalRecords
        ) {
          break;
        }
      }

      return records;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve queue: ${e.message}`,
        { cause: e }
      );
    }
  };

  /** Imports from downloads since a time; Sonarr has one record per episode. */
  public getImportsSince = async (since: Date): Promise<ImportRecord[]> => {
    const response = await this.axios.get<ImportRecord[]>('/history/since', {
      params: {
        date: since.toISOString(),
        eventType: 'downloadFolderImported',
        includeEpisode: true,
      },
    });
    return Array.isArray(response.data) ? response.data : [];
  };

  /** Categories (or labels) this app files its downloads under. */
  public getDownloadCategories = async (): Promise<string[]> => {
    const response =
      await this.axios.get<{ fields?: { name?: string; value?: unknown }[] }[]>(
        '/downloadclient'
      );
    return (Array.isArray(response.data) ? response.data : []).flatMap(
      (client) =>
        (client.fields ?? [])
          .filter((f) => /category$/i.test(f.name ?? ''))
          .map((f) => f.value)
          .filter((v): v is string => typeof v === 'string' && v !== '')
    );
  };

  /** The addresses of the indexers this app has set up. */
  public getIndexerUrls = async (): Promise<string[]> => {
    const response =
      await this.axios.get<{ fields?: { name?: string; value?: unknown }[] }[]>(
        '/indexer'
      );
    return (Array.isArray(response.data) ? response.data : []).flatMap(
      (indexer) =>
        (indexer.fields ?? [])
          .filter((f) => f.name === 'baseUrl')
          .map((f) => f.value)
          .filter((v): v is string => typeof v === 'string' && v !== '')
    );
  };

  public getTags = async (): Promise<Tag[]> => {
    try {
      const response = await this.axios.get<Tag[]>(`/tag`);

      return response.data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve tags: ${e.message}`,
        { cause: e }
      );
    }
  };

  public createTag = async ({ label }: { label: string }): Promise<Tag> => {
    try {
      const response = await this.axios.post<Tag>(`/tag`, {
        label,
      });

      return response.data;
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to create tag: ${e.message}`, {
        cause: e,
      });
    }
  };

  public renameTag = async ({
    id,
    label,
  }: {
    id: number;
    label: string;
  }): Promise<Tag> => {
    try {
      const response = await this.axios.put<Tag>(`/tag/${id}`, {
        id,
        label,
      });

      return response.data;
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to rename tag: ${e.message}`, {
        cause: e,
      });
    }
  };

  async refreshMonitoredDownloads(): Promise<void> {
    await this.runCommand('RefreshMonitoredDownloads', {});
  }

  protected async runCommand(
    commandName: string,
    options: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.axios.post(`/command`, {
        name: commandName,
        ...options,
      });
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to run command: ${e.message}`, {
        cause: e,
      });
    }
  }
}

export default ServarrBase;
