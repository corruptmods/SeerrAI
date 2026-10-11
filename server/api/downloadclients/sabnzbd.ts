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
import axios from 'axios';

/*
 * The part of SABnzbd's API Seerr reads: its queue (downloading) and its
 * history (after downloading, where verifying, repairing, unpacking and the
 * post-processing script happen). Radarr and Sonarr record a SABnzbd job by
 * its nzo_id, which is how a queue item is matched to its job here: a UUID
 * on current SABnzbd (as yours records them), SABnzbd_nzo_… on older ones.
 */

interface QueueSlot {
  nzo_id: string;
  status: string;
  mb?: string;
  mbleft?: string;
  timeleft?: string;
}

interface HistorySlot {
  nzo_id: string;
  status: string;
  bytes?: number;
}

interface Answer {
  status?: boolean;
  error?: string;
  version?: string;
  queue?: { paused?: boolean; kbpersec?: string; slots?: QueueSlot[] };
  history?: { slots?: HistorySlot[] };
}

const MB = 1024 * 1024;

/** A job as Backfill follows it. */
export type SabJob = UsenetJob;

/** SABnzbd's "time left": H:MM:SS, with days in front when it runs long. */
export const sabSecondsLeft = (timeleft?: string): number | undefined => {
  if (!timeleft) {
    return undefined;
  }
  const parts = timeleft.split(':').map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  const [s = 0, m = 0, h = 0, d = 0] = parts.reverse();
  const total = ((d * 24 + h) * 60 + m) * 60 + s;
  return total > 0 ? total : undefined;
};

/** A SABnzbd history status: what it is doing after the download. */
const AFTER_DOWNLOAD: Record<string, DownloadStep | undefined> = {
  QuickCheck: 'verifying',
  Verifying: 'verifying',
  Repairing: 'repairing',
  Fetching: 'repairing', // more repair blocks
  Extracting: 'unpacking',
  Moving: 'moving',
  Running: 'script',
  Queued: undefined, // waiting for its turn to be processed
};

export const sabQueueDownload = (
  slot: QueueSlot,
  allPaused: boolean
): LiveDownload => {
  const size = Math.round(Number(slot.mb ?? 0) * MB);
  const sizeLeft = Math.round(Number(slot.mbleft ?? 0) * MB);
  const paused = allPaused || slot.status === 'Paused';
  const downloading = slot.status === 'Downloading';
  return {
    size: Number.isFinite(size) ? size : 0,
    sizeLeft: Number.isFinite(sizeLeft) ? sizeLeft : 0,
    stage: paused ? 'paused' : downloading ? 'downloading' : 'queued',
    secondsLeft: paused ? undefined : sabSecondsLeft(slot.timeleft),
  };
};

export const sabHistoryDownload = (slot: HistorySlot): LiveDownload => {
  const size = Number(slot.bytes ?? 0);
  const base = { size: Number.isFinite(size) ? size : 0, sizeLeft: 0 };
  if (slot.status === 'Completed') {
    return { ...base, stage: 'importing' };
  }
  if (slot.status === 'Failed') {
    return { ...base, stage: 'failed' };
  }
  return { ...base, stage: 'finishing', step: AFTER_DOWNLOAD[slot.status] };
};

class SabnzbdAPI implements UsenetClient {
  public readonly product = 'SABnzbd';
  private axios: AxiosInstance;
  private apiKey: string;

  constructor(
    settings: Pick<
      DownloadClientSettings,
      'hostname' | 'port' | 'useSsl' | 'urlBase' | 'apiKey'
    >
  ) {
    this.apiKey = settings.apiKey;
    this.axios = axios.create({
      baseURL: `${clientBaseUrl(settings)}/api`,
      timeout: CLIENT_TIMEOUT_MS,
    });
  }

  private async call(params: Record<string, string | number>) {
    const { data } = await this.axios.get<Answer>('', {
      params: { ...params, output: 'json', apikey: this.apiKey },
    });
    // SABnzbd reports a wrong key with a normal response saying so.
    if (data?.status === false || data?.error) {
      throw new Error(`SABnzbd: ${data.error ?? 'request refused'}`);
    }
    return data;
  }

  /*
   * Writing, for Backfill: it adds an NZB it found and checked, follows the
   * job to SABnzbd's history, and removes it there once Sonarr has imported
   * what it needed.
   */

  /** Adds an NZB file; answers SABnzbd's id for the new job. */
  public async addNzb(
    nzb: Buffer,
    name: string,
    category: string
  ): Promise<string> {
    const form = new FormData();
    form.append(
      'name',
      new Blob([new Uint8Array(nzb)], { type: 'application/x-nzb' }),
      name.endsWith('.nzb') ? name : `${name}.nzb`
    );
    const { data } = await this.axios.post<{
      status?: boolean;
      error?: string;
      nzo_ids?: string[];
    }>('', form, {
      params: {
        mode: 'addfile',
        cat: category,
        output: 'json',
        apikey: this.apiKey,
      },
    });
    const id = data?.nzo_ids?.[0];
    if (data?.status === false || data?.error || !id) {
      throw new Error(`SABnzbd: ${data?.error ?? 'the NZB was not added'}`);
    }
    return id;
  }

  /** Where a job is and what SABnzbd says about it; undefined if gone. */
  public async getJob(nzoId: string): Promise<SabJob | undefined> {
    // The whole queue, not just this job: whether its speed is its own
    // depends on what else is downloading.
    const [queue, history] = await Promise.all([
      this.raw({ mode: 'queue' }),
      this.raw({ mode: 'history', nzo_ids: nzoId }),
    ]);
    const slots: { nzo_id: string; status?: string }[] =
      queue.queue?.slots ?? [];
    const queued = slots.find((slot) => slot.nzo_id === nzoId) as
      | (QueueSlot & { percentage?: string })
      | undefined;
    if (queued) {
      const downloading = (slot: { status?: string }) =>
        /^downloading$/i.test(String(slot.status ?? ''));
      const active = slots.filter(downloading);
      return {
        place: 'queue',
        status: String(queued.status ?? ''),
        percentage: Number(queued.percentage) || 0,
        size: Number(queued.mb) * MB || 0,
        sizeLeft: Number(queued.mbleft) * MB || 0,
        secondsLeft: sabSecondsLeft(queued.timeleft),
        // SABnzbd reports one speed, for its whole queue. It is this job's
        // only while this is the one job downloading; with several at once
        // nobody knows the split here, and the caller measures it.
        speed: !downloading(queued)
          ? 0
          : active.length === 1
            ? Math.round(Number(queue.queue?.kbpersec ?? 0) * 1024)
            : undefined,
      };
    }
    const done = (history.history?.slots ?? []).find(
      (slot: { nzo_id: string }) => slot.nzo_id === nzoId
    );
    if (!done) {
      return undefined;
    }
    return {
      place: 'history',
      status: String(done.status ?? ''),
      percentage: 100,
      size: Number(done.bytes) || 0,
      sizeLeft: 0,
      speed: 0,
      storage: done.storage ? String(done.storage) : undefined,
      failMessage: done.fail_message ? String(done.fail_message) : undefined,
    };
  }

  public async backfillProblems(): Promise<string[]> {
    return [];
  }

  public async pauseJob(nzoId: string): Promise<void> {
    await this.call({ mode: 'queue', name: 'pause', value: nzoId });
  }

  public async resumeJob(nzoId: string): Promise<void> {
    await this.call({ mode: 'queue', name: 'resume', value: nzoId });
  }

  /** Removes the job, from the queue or the history, and its files. */
  public async deleteJob(nzoId: string): Promise<void> {
    await this.call({
      mode: 'queue',
      name: 'delete',
      value: nzoId,
      del_files: 1,
    });
    await this.call({
      mode: 'history',
      name: 'delete',
      value: nzoId,
      del_files: 1,
    });
  }

  // The same call, typed loosely: the queue and history slots carry more
  // than progress needs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async raw(params: Record<string, string | number>): Promise<any> {
    return this.call(params);
  }

  public async getVersion(): Promise<string> {
    // The version needs no key; reading the queue proves the key works.
    const { version } = await this.call({ mode: 'version' });
    await this.call({ mode: 'queue', limit: 1 });
    return version ?? 'unknown';
  }

  public async getDownloads(ids: string[]): Promise<Map<string, LiveDownload>> {
    const found = new Map<string, LiveDownload>();
    // SABnzbd's job ids: a UUID from SABnzbd 4.2 on, SABnzbd_nzo_… before.
    // Anything that isn't a torrent's hash is asked about; ids it doesn't
    // hold simply aren't in its answer.
    const mine = ids.filter((id) => !isTorrentHash(id));
    if (!mine.length) {
      return found;
    }
    const nzoIds = mine.join(',');
    const [queue, history] = await Promise.all([
      this.call({ mode: 'queue', nzo_ids: nzoIds }),
      this.call({ mode: 'history', nzo_ids: nzoIds }),
    ]);
    const allPaused = queue.queue?.paused === true;
    for (const slot of history.history?.slots ?? []) {
      found.set(slot.nzo_id.toLowerCase(), sabHistoryDownload(slot));
    }
    // A job is in one or the other; the queue is the fresher if both.
    for (const slot of queue.queue?.slots ?? []) {
      found.set(slot.nzo_id.toLowerCase(), sabQueueDownload(slot, allPaused));
    }
    return found;
  }
}

export default SabnzbdAPI;
