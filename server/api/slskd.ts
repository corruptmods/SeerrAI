import ExternalAPI from '@server/api/externalapi';
import { randomUUID } from 'node:crypto';

/*
 * slskd, a Soulseek client run as a service: searched for a song's file
 * when no release of its album or single is on the indexers, and asked to
 * download just that file, into a folder of its own for Lidarr to import
 * from. Needs slskd 0.26 or newer (download batches), and an API key with
 * the ReadWrite role.
 */

/** The first slskd with download batches. */
export const SLSKD_MIN_VERSION = [0, 26, 0] as const;

const TIMEOUT_MS = 20_000;
/** How long Soulseek is searched: slskd's own default. */
const SEARCH_MS = 15_000;
/** How often a search is looked at while it runs. */
const POLL_MS = 1_500;

export interface SlskdFile {
  /** The path as the sharer names it, folders and all. */
  filename: string;
  size: number;
  bitRate?: number | null;
  bitDepth?: number | null;
  sampleRate?: number | null;
  /** Seconds. */
  length?: number | null;
  extension?: string | null;
  isVariableBitRate?: boolean | null;
}

/** One sharer's answer to a search. */
export interface SlskdResponse {
  username: string;
  files: SlskdFile[];
  hasFreeUploadSlot: boolean;
  queueLength: number;
  /** Bytes a second. */
  uploadSpeed: number;
}

interface SlskdSearch {
  id: string;
  /** Flags, as words: "InProgress", "Completed, TimedOut". */
  state: string;
  responseCount: number;
}

export interface SlskdTransfer {
  id: string;
  username: string;
  filename: string;
  size: number;
  /** Flags, as words: "Queued, Remotely", "InProgress", "Completed, Succeeded". */
  state: string;
  bytesTransferred: number;
  placeInQueue?: number | null;
  exception?: string | null;
}

export interface SlskdBatch {
  id: string;
  username: string;
  transfers?: SlskdTransfer[] | null;
}

interface SlskdEnqueued {
  batch?: SlskdBatch | null;
  failures?: { filename: string; message: string }[];
}

export interface SlskdApplication {
  version: { current: string; full?: string };
  server: { isConnected?: boolean; isLoggedIn?: boolean; state?: string };
}

/** What slskd said no to, in its words: a sharer offline, a file refused. */
export class SlskdRefused extends Error {}

/** Whether a transfer's state holds this flag. */
export const transferIs = (transfer: { state: string }, flag: string) =>
  transfer.state.split(/,\s*/).includes(flag);

const newer = (current: string, wanted: readonly number[]): boolean => {
  const parts = current.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < wanted.length; i++) {
    const have = Number.isFinite(parts[i]) ? parts[i] : 0;
    if (have !== wanted[i]) return have > wanted[i];
  }
  return true;
};

/** Whether this slskd can download in batches. */
export const slskdNewEnough = (version: string): boolean =>
  newer(version, SLSKD_MIN_VERSION);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SlskdAPI extends ExternalAPI {
  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super(
      `${url.replace(/\/+$/, '')}/api/v0`,
      {},
      { timeout: TIMEOUT_MS, headers: { 'X-API-Key': apiKey } }
    );
  }

  public getApplication(): Promise<SlskdApplication> {
    return this.get<SlskdApplication>('/application', {}, 0);
  }

  /**
   * Searches Soulseek and waits for the answers: every sharer's matching
   * files, unlocked ones only. A search still running when the wait is
   * over is stopped, and slskd given a moment to finish it, before it is
   * cleared from slskd: one cleared while running fails in slskd.
   */
  public async search(
    text: string,
    timing: { searchMs: number; pollMs: number } = {
      searchMs: SEARCH_MS,
      pollMs: POLL_MS,
    }
  ): Promise<SlskdResponse[]> {
    const id = randomUUID();
    const res = await this.axios.post<SlskdSearch>(
      '/searches',
      {
        id,
        searchText: text,
        searchTimeout: timing.searchMs,
        responseLimit: 100,
        fileLimit: 10_000,
        filterResponses: true,
        minimumResponseFileCount: 1,
      },
      { validateStatus: () => true }
    );
    if (res.status === 429) {
      throw new SlskdRefused('slskd is busy with another search.');
    }
    if (res.status === 409) {
      throw new SlskdRefused('slskd isn’t signed in to Soulseek.');
    }
    if (res.status >= 300) {
      throw new Error(`slskd could not search (${res.status}).`);
    }
    try {
      // slskd's timeout counts from the last answer, so a popular search
      // runs on: it is stopped once it has had twice its time.
      let until = Date.now() + timing.searchMs * 2;
      let stopped = false;
      for (;;) {
        await wait(timing.pollMs);
        const search = await this.get<SlskdSearch>(`/searches/${id}`, {}, 0);
        if (transferIs(search, 'Completed')) break;
        if (Date.now() > until) {
          if (stopped) break;
          await this.axios
            .put(`/searches/${id}`, undefined, {
              validateStatus: (s) => s < 300 || s === 304 || s === 404,
            })
            .catch(() => undefined);
          stopped = true;
          until = Date.now() + timing.pollMs * 4;
        }
      }
      const responses = await this.get<SlskdResponse[]>(
        `/searches/${id}/responses`,
        {},
        0
      );
      return Array.isArray(responses) ? responses : [];
    } finally {
      await this.axios.delete(`/searches/${id}`).catch(() => undefined);
    }
  }

  /**
   * Asks for these files of one sharer's, into `destination` (a folder
   * under slskd's downloads). Throws SlskdRefused when none could be.
   */
  public async download(
    username: string,
    files: { filename: string; size: number }[],
    destination: string
  ): Promise<string> {
    const id = randomUUID();
    const res = await this.axios.post<SlskdEnqueued | string>(
      '/transfers/downloads/batches',
      { id, username, files, options: { destination } },
      { validateStatus: () => true }
    );
    if (res.status === 404) {
      throw new SlskdRefused(`${username} is offline on Soulseek.`);
    }
    if (res.status === 429) {
      throw new Error('slskd is busy; asked again shortly.');
    }
    if (res.status === 200) {
      const failure =
        typeof res.data === 'object' ? res.data.failures?.[0] : undefined;
      throw new SlskdRefused(
        failure?.message ?? `${username} turned the download down.`
      );
    }
    if (res.status !== 201 && res.status !== 207) {
      throw new Error(
        `slskd could not start the download (${res.status}${
          typeof res.data === 'string' && res.data ? `: ${res.data}` : ''
        }).`
      );
    }
    return id;
  }

  /** A download batch, with its transfers; null once slskd has none. */
  public async getBatch(id: string): Promise<SlskdBatch | null> {
    const res = await this.axios.get<SlskdBatch>(
      `/transfers/downloads/batches/${id}`,
      { validateStatus: (s) => s === 200 || s === 404 }
    );
    return res.status === 404 ? null : res.data;
  }

  /** Stops a transfer and forgets it. */
  public async removeTransfer(username: string, id: string): Promise<void> {
    await this.axios.delete(
      `/transfers/downloads/${encodeURIComponent(username)}/${id}`,
      {
        params: { remove: true },
        validateStatus: (s) => s < 300 || s === 404,
      }
    );
  }

  /**
   * Deletes a folder under slskd's downloads, once Lidarr has moved what
   * was in it. Needs slskd's remote file management on; without it the
   * empty folder stays.
   */
  public async removeDownloadFolder(folder: string): Promise<void> {
    await this.axios.delete(
      `/files/downloads/directories/${encodeURIComponent(
        Buffer.from(folder, 'utf8').toString('base64')
      )}`,
      { validateStatus: (s) => s < 300 || s === 403 || s === 404 }
    );
  }
}

export default SlskdAPI;
