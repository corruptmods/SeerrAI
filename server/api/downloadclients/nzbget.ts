import type {
  DownloadClient,
  LiveDownload,
} from '@server/api/downloadclients/types';
import {
  CLIENT_TIMEOUT_MS,
  clientBaseUrl,
  isTorrentHash,
} from '@server/api/downloadclients/types';
import type { DownloadStep } from '@server/constants/downloads';
import type { DownloadClientSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';
import axios, { isAxiosError } from 'axios';

/*
 * The part of NZBGet's JSON-RPC Seerr reads: its queue and its history.
 * Radarr and Sonarr add a "drone" parameter to each NZB they send and record
 * its value as the download id (the NZB's own NZBID on older versions), so a
 * job is matched by either. NZBGet signs in with HTTP basic auth.
 */

interface Parameter {
  Name: string;
  Value: string;
}

export interface NzbgetGroup {
  NZBID: number;
  /** QUEUED, PAUSED, DOWNLOADING, FETCHING, PP_QUEUED, LOADING_PARS,
   * VERIFYING_SOURCES, REPAIRING, VERIFYING_REPAIRED, RENAMING, UNPACKING,
   * MOVING, EXECUTING_SCRIPT, PP_FINISHED. */
  Status: string;
  FileSizeMB: number;
  RemainingSizeMB: number;
  Parameters?: Parameter[];
}

export interface NzbgetHistoryItem {
  NZBID: number;
  /** SUCCESS/…, FAILURE/…, WARNING/…, DELETED/… */
  Status: string;
  FileSizeMB: number;
  Parameters?: Parameter[];
}

interface Status {
  DownloadRate: number;
  DownloadPaused: boolean;
}

const MB = 1024 * 1024;

/** What NZBGet does to a job after downloading it. */
const AFTER_DOWNLOAD: Record<string, DownloadStep | undefined> = {
  PP_QUEUED: undefined,
  LOADING_PARS: 'verifying',
  VERIFYING_SOURCES: 'verifying',
  VERIFYING_REPAIRED: 'verifying',
  REPAIRING: 'repairing',
  RENAMING: 'unpacking',
  UNPACKING: 'unpacking',
  MOVING: 'moving',
  EXECUTING_SCRIPT: 'script',
};

/** The download id Radarr or Sonarr recorded for a job, in lower case. */
export const nzbgetJobId = (job: {
  NZBID: number;
  Parameters?: Parameter[];
}): string =>
  (
    job.Parameters?.find((p) => p.Name === 'drone')?.Value ?? String(job.NZBID)
  ).toLowerCase();

export const nzbgetQueueDownload = (
  group: NzbgetGroup,
  status: Status,
  /** The one job downloading, when only one is: it has all the speed. */
  soleDownloading: boolean
): LiveDownload => {
  const size = Math.round((Number(group.FileSizeMB) || 0) * MB);
  const sizeLeft = Math.round((Number(group.RemainingSizeMB) || 0) * MB);
  const base = { size, sizeLeft };
  if (group.Status in AFTER_DOWNLOAD) {
    return {
      ...base,
      sizeLeft: 0,
      stage: 'finishing',
      step: AFTER_DOWNLOAD[group.Status],
    };
  }
  switch (group.Status) {
    case 'PP_FINISHED':
      return { ...base, sizeLeft: 0, stage: 'importing' };
    case 'PAUSED':
      return { ...base, stage: 'paused' };
    case 'DOWNLOADING':
      if (status.DownloadPaused) {
        return { ...base, stage: 'paused' };
      }
      return {
        ...base,
        stage: 'downloading',
        secondsLeft:
          soleDownloading && status.DownloadRate > 0 && sizeLeft > 0
            ? Math.round(sizeLeft / status.DownloadRate)
            : undefined,
      };
    default:
      // QUEUED, and FETCHING (the NZB itself is being fetched).
      return {
        ...base,
        stage: status.DownloadPaused ? 'paused' : 'queued',
      };
  }
};

export const nzbgetHistoryDownload = (
  item: NzbgetHistoryItem
): LiveDownload => {
  const base = {
    size: Math.round((Number(item.FileSizeMB) || 0) * MB),
    sizeLeft: 0,
  };
  const kind = String(item.Status).split('/')[0];
  if (kind === 'SUCCESS') return { ...base, stage: 'importing' };
  if (kind === 'WARNING') return { ...base, stage: 'needsAttention' };
  return { ...base, stage: 'failed' };
};

interface RpcAnswer<T> {
  result: T;
  error?: { message?: string } | null;
}

class NzbgetAPI implements DownloadClient {
  private axios: AxiosInstance;

  constructor(
    settings: Pick<
      DownloadClientSettings,
      'hostname' | 'port' | 'useSsl' | 'urlBase' | 'username' | 'password'
    >
  ) {
    this.axios = axios.create({
      baseURL: `${clientBaseUrl(settings)}/jsonrpc`,
      timeout: CLIENT_TIMEOUT_MS,
      auth: settings.username
        ? { username: settings.username, password: settings.password ?? '' }
        : undefined,
    });
  }

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    try {
      const { data } = await this.axios.post<RpcAnswer<T>>('', {
        method,
        params,
        id: 1,
      });
      if (data?.error) {
        throw new Error(`NZBGet: ${data.error.message ?? 'error'}`);
      }
      return data.result;
    } catch (e) {
      if (isAxiosError(e) && e.response?.status === 401) {
        throw new Error('NZBGet did not accept the username or password.');
      }
      throw e;
    }
  }

  public async getVersion(): Promise<string> {
    return (await this.call<string>('version')) || 'unknown';
  }

  public async getDownloads(ids: string[]): Promise<Map<string, LiveDownload>> {
    const found = new Map<string, LiveDownload>();
    const mine = new Set(
      ids.filter((id) => !isTorrentHash(id)).map((id) => id.toLowerCase())
    );
    if (!mine.size) {
      return found;
    }
    const [groups, history, status] = await Promise.all([
      this.call<NzbgetGroup[]>('listgroups', [0]),
      this.call<NzbgetHistoryItem[]>('history', [false]),
      this.call<Status>('status'),
    ]);
    for (const item of history ?? []) {
      const id = nzbgetJobId(item);
      if (mine.has(id)) found.set(id, nzbgetHistoryDownload(item));
    }
    const downloading = (groups ?? []).filter(
      (group) => group.Status === 'DOWNLOADING'
    ).length;
    // The queue last: a job back in it after a failure is what counts now.
    for (const group of groups ?? []) {
      const id = nzbgetJobId(group);
      if (mine.has(id)) {
        found.set(id, nzbgetQueueDownload(group, status, downloading === 1));
      }
    }
    return found;
  }
}

export default NzbgetAPI;
