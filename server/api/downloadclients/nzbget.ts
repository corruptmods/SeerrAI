import type {
  LiveDownload,
  UsenetClient,
  UsenetJob,
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
 *
 * For Backfill it also adds NZBs (NZBGet 16 and newer), follows them to the
 * history, and removes them there. NZBGet keeps a finished job's folder when
 * it is removed; Backfill's imports move the videos out of it, and what is
 * left (an .nfo, a sample) stays until NZBGet's own cleanup or someone
 * clears it.
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
  /** Repair files held back until they are needed. */
  PausedSizeMB?: number;
  Parameters?: Parameter[];
}

export interface NzbgetHistoryItem {
  NZBID: number;
  /** SUCCESS/…, FAILURE/…, WARNING/…, DELETED/… */
  Status: string;
  FileSizeMB: number;
  /** Where it was put, and where a script moved it after, if one did. */
  DestDir?: string;
  FinalDir?: string;
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

/**
 * A job's size and what is left, without the repair files NZBGet holds
 * back: they are only fetched if the download turns out damaged.
 */
const groupSize = (group: NzbgetGroup) => {
  const paused = Number(group.PausedSizeMB) || 0;
  return {
    size: Math.max(
      0,
      Math.round(((Number(group.FileSizeMB) || 0) - paused) * MB)
    ),
    sizeLeft: Math.max(
      0,
      Math.round(((Number(group.RemainingSizeMB) || 0) - paused) * MB)
    ),
  };
};

export const nzbgetQueueDownload = (
  group: NzbgetGroup,
  status: Status,
  /** The one job downloading, when only one is: it has all the speed. */
  soleDownloading: boolean
): LiveDownload => {
  const { size, sizeLeft } = groupSize(group);
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

/** NZBGet's queue states, in Backfill's words (see UsenetJob). */
const QUEUE_WORDS: Record<string, string> = {
  QUEUED: 'queued',
  PAUSED: 'paused',
  DOWNLOADING: 'downloading',
  FETCHING: 'fetching',
};

/** After downloading, still in NZBGet's queue: Backfill's history words. */
const AFTER_WORDS: Record<string, string> = {
  PP_QUEUED: 'queued',
  LOADING_PARS: 'verifying',
  VERIFYING_SOURCES: 'verifying',
  VERIFYING_REPAIRED: 'verifying',
  REPAIRING: 'repairing',
  RENAMING: 'renaming',
  UNPACKING: 'extracting',
  MOVING: 'moving',
  EXECUTING_SCRIPT: 'running',
  // Done, and about to be put in the history, where its folder is.
  PP_FINISHED: 'moving',
};

/** Why a job in the history did not succeed, in words. */
const FAILURES: Record<string, string> = {
  'FAILURE/PAR': 'repairing it failed',
  'FAILURE/UNPACK': 'unpacking it failed',
  'FAILURE/MOVE': 'moving its files failed',
  'FAILURE/SCRIPT': 'its post-processing script failed',
  'FAILURE/DISKSPACE': 'the disk filled up',
  'FAILURE/HEALTH': 'too many of its articles are missing',
  'FAILURE/BAD': 'it was marked bad',
  'WARNING/DAMAGED': 'it is damaged and could not be repaired',
  'WARNING/REPAIRABLE': 'it could be repaired, but was not',
  'WARNING/SPACE': 'the disk filled up',
  'WARNING/PASSWORD': 'its archive needs a password',
  'WARNING/SKIPPED': 'it was skipped as a duplicate',
};

/** A job in NZBGet's queue as Backfill follows it. */
export const nzbgetJob = (
  group: NzbgetGroup,
  status: Status,
  soleDownloading: boolean
): UsenetJob => {
  const { size, sizeLeft } = groupSize(group);
  const percentage = size ? ((size - sizeLeft) / size) * 100 : 0;
  if (group.Status in AFTER_WORDS) {
    return {
      place: 'history',
      status: AFTER_WORDS[group.Status],
      percentage: 100,
      size,
      sizeLeft: 0,
      speed: 0,
    };
  }
  const downloading = group.Status === 'DOWNLOADING' && !status.DownloadPaused;
  const speed = !downloading
    ? 0
    : soleDownloading
      ? Number(status.DownloadRate) || 0
      : undefined;
  return {
    place: 'queue',
    status:
      status.DownloadPaused && group.Status !== 'PAUSED'
        ? 'paused'
        : (QUEUE_WORDS[group.Status] ?? 'queued'),
    percentage,
    size,
    sizeLeft,
    speed,
    secondsLeft: speed && sizeLeft ? Math.round(sizeLeft / speed) : undefined,
  };
};

/** A job in NZBGet's history as Backfill follows it. */
export const nzbgetHistoryJob = (item: NzbgetHistoryItem): UsenetJob => {
  const status = String(item.Status);
  const base = {
    place: 'history' as const,
    percentage: 100,
    size: Math.round((Number(item.FileSizeMB) || 0) * MB),
    sizeLeft: 0,
    speed: 0,
  };
  // A failing script leaves the download itself fine.
  if (status.startsWith('SUCCESS/') || status === 'WARNING/SCRIPT') {
    return {
      ...base,
      status: 'completed',
      storage: item.FinalDir || item.DestDir || undefined,
    };
  }
  return {
    ...base,
    status: 'failed',
    failMessage: status.startsWith('DELETED/')
      ? 'it was deleted in NZBGet'
      : (FAILURES[status] ?? status),
  };
};

/** The oldest NZBGet whose API Backfill speaks. */
const BACKFILL_MIN_VERSION = 16;

interface RpcAnswer<T> {
  result: T;
  error?: { message?: string } | null;
}

class NzbgetAPI implements UsenetClient {
  public readonly product = 'NZBGet';
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

  public async addNzb(
    nzb: Buffer,
    name: string,
    category: string
  ): Promise<string> {
    const id = await this.call<number>('append', [
      name.endsWith('.nzb') ? name : `${name}.nzb`,
      nzb.toString('base64'),
      category,
      0, // priority
      false, // to the top
      false, // paused
      '', // duplicate key
      0, // duplicate score
      'FORCE', // never held back as a duplicate
      [],
    ]);
    if (!(Number(id) > 0)) {
      throw new Error('NZBGet: the NZB was not added');
    }
    return String(id);
  }

  public async getJob(id: string): Promise<UsenetJob | undefined> {
    const matches = (job: { NZBID: number; Parameters?: Parameter[] }) =>
      String(job.NZBID) === id || nzbgetJobId(job) === id.toLowerCase();
    const [groups, history, status] = await Promise.all([
      this.call<NzbgetGroup[]>('listgroups', [0]),
      this.call<NzbgetHistoryItem[]>('history', [false]),
      this.call<Status>('status'),
    ]);
    const group = (groups ?? []).find(matches);
    if (group) {
      const downloading = (groups ?? []).filter(
        (g) => g.Status === 'DOWNLOADING'
      ).length;
      return nzbgetJob(group, status, downloading === 1);
    }
    const done = (history ?? []).find(matches);
    return done ? nzbgetHistoryJob(done) : undefined;
  }

  private async edit(command: string, id: string): Promise<boolean> {
    return !!(await this.call<boolean>('editqueue', [
      command,
      '',
      [Number(id)],
    ]));
  }

  public async pauseJob(id: string): Promise<void> {
    if (!(await this.edit('GroupPause', id))) {
      throw new Error('NZBGet: the job is not in its queue');
    }
  }

  public async resumeJob(id: string): Promise<void> {
    if (!(await this.edit('GroupResume', id))) {
      throw new Error('NZBGet: the job is not in its queue');
    }
  }

  /**
   * Removes the job from the queue (with what it downloaded) or from the
   * history, whichever it is in.
   */
  public async deleteJob(id: string): Promise<void> {
    if (!(await this.edit('GroupFinalDelete', id))) {
      await this.edit('HistoryFinalDelete', id);
    }
  }

  public async backfillProblems(): Promise<string[]> {
    const version = await this.getVersion();
    const major = parseInt(version, 10);
    return Number.isFinite(major) && major < BACKFILL_MIN_VERSION
      ? [
          `NZBGet ${version} is too old for Backfill to add downloads to: ${BACKFILL_MIN_VERSION} or newer is needed.`,
        ]
      : [];
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
