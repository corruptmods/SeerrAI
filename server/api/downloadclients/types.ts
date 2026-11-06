import type { DownloadStage, DownloadStep } from '@server/constants/downloads';
import type { DownloadClientSettings } from '@server/lib/settings';
import { createHash } from 'node:crypto';

/** One download as its client currently reports it. */
export interface LiveDownload {
  size: number;
  sizeLeft: number;
  /** Until done, when the client estimates it. */
  secondsLeft?: number;
  stage: DownloadStage;
  step?: DownloadStep;
}

export interface DownloadClient {
  /** The client's version; also proves the address and sign-in work. */
  getVersion(): Promise<string>;
  /**
   * The downloads among `ids` this client holds, keyed by lower-case id.
   * Other ids are skipped.
   */
  getDownloads(ids: string[]): Promise<Map<string, LiveDownload>>;
}

/*
 * Clients Backfill adds to, follows and removes from itself. Each implements
 * one of the two interfaces below so the engine treats them alike.
 */

/** A torrent's state, normalised across clients. */
export type TorrentState =
  /** Fetching its file list from the swarm (magnet link). */
  | 'metadata'
  /** Checking data on disk. */
  | 'checking'
  /** Waiting behind the client's own download limit. */
  | 'queued'
  | 'paused'
  | 'downloading'
  /** The client is moving it to another folder. */
  | 'moving'
  /** All wanted data is in; seeding or stopped. */
  | 'done'
  /** Stopped on its own error (disk full, files gone). */
  | 'error';

export interface ClientTorrent {
  /** Lower-case info hash. */
  hash: string;
  name: string;
  state: TorrentState;
  /** The client's message when the state is 'error'. */
  error?: string;
  /** 0 to 1, of the wanted data. */
  progress: number;
  /** Bytes a second. */
  speed: number;
  /** Until done; undefined when the client has no estimate. */
  secondsLeft?: number;
  /** In the client's own paths; a file is at savePath/name. */
  savePath: string;
  /** When added (ms); undefined when the client cannot say. */
  addedAt?: number;
  /**
   * Wanted bytes not yet in that no connected peer has; undefined when the
   * client cannot say.
   */
  unavailable?: number;
}

export interface ClientTorrentFile {
  /** Position in the .torrent file's list. */
  index: number;
  /** Path, prefixed by the torrent's folder for a multi-file torrent. */
  name: string;
  size: number;
  /** 0 to 1. */
  progress: number;
  /**
   * 0 to 1: share of its pieces that are in or held by a connected peer;
   * undefined when the client cannot say.
   */
  availability?: number;
}

export interface TorrentClient extends DownloadClient {
  /** Product name for display ("Paused in Transmission"). */
  readonly product: string;
  /**
   * Whether a magnet added with metadataOnly stops itself once its file list
   * is in. Otherwise it is polled closely until then, with its download speed
   * capped where the client allows.
   */
  readonly stopsAtMetadata: boolean;
  /**
   * Adds a .torrent file (stopped, so files can be chosen first) or a magnet
   * link (started, to fetch its file list). Backfill stops it once its files
   * are in; nothing set on it lets the client remove it before import.
   */
  addTorrent(options: {
    torrent?: Buffer;
    magnet?: string;
    /**
     * The info hash Backfill read from the file or link. Refused, and
     * nothing else changed, when the client adds or already holds another.
     */
    hash: string;
    category: string;
    metadataOnly?: boolean;
  }): Promise<void>;
  /** Ensures Backfill's category (or label) exists. */
  ensureCategory(category: string): Promise<void>;
  /** The torrent with this hash, or undefined. */
  findTorrent(hash: string): Promise<ClientTorrent | undefined>;
  /** Torrents in a category (label), for clearing leftover probes. */
  listCategory(category: string): Promise<ClientTorrent[]>;
  /** Files in index order; empty until the file list is in. */
  getFiles(hash: string): Promise<ClientTorrentFile[]>;
  /** 0 skips the files, 1 downloads them. */
  setFilePriority(
    hash: string,
    indexes: number[],
    priority: 0 | 1
  ): Promise<void>;
  startTorrent(hash: string): Promise<void>;
  stopTorrent(hash: string): Promise<void>;
  /**
   * Removes the torrent and its data on disk, keeping the data when another
   * torrent in the client is, holds or is inside the same files or folder.
   */
  deleteTorrent(hash: string): Promise<void>;
  /** Problems that limit Backfill's use of the client; empty if none. */
  backfillProblems(): Promise<string[]>;
}

/**
 * A Usenet job as Backfill follows it. Status is a lower-case SABnzbd word,
 * which every Usenet client's statuses are mapped to:
 * - in the queue: downloading, queued, paused, fetching (the NZB itself),
 *   propagating, checking
 * - after downloading: queued (for post-processing), verifying, repairing,
 *   fetching (repair blocks), renaming, extracting, moving, running (its
 *   script), completed, failed
 */
export interface UsenetJob {
  place: 'queue' | 'history';
  status: string;
  percentage: number;
  size: number;
  sizeLeft: number;
  secondsLeft?: number;
  /**
   * Bytes a second: 0 while waiting, undefined when several jobs download
   * at once and the client's single figure cannot be split.
   */
  speed?: number;
  /** Finished files' folder, in the client's own paths. */
  storage?: string;
  failMessage?: string;
}

export interface UsenetClient extends DownloadClient {
  readonly product: string;
  /** Adds an NZB file; returns the client's id for the new job. */
  addNzb(nzb: Buffer, name: string, category: string): Promise<string>;
  /** The job's place and status; undefined if gone. */
  getJob(id: string): Promise<UsenetJob | undefined>;
  pauseJob(id: string): Promise<void>;
  resumeJob(id: string): Promise<void>;
  /** Removes the job (queue or history) and as many of its files as it can. */
  deleteJob(id: string): Promise<void>;
  backfillProblems(): Promise<string[]>;
}

/** Long enough for a busy client, short enough not to hold up a page. */
export const CLIENT_TIMEOUT_MS = 8_000;

export const clientBaseUrl = (
  settings: Pick<
    DownloadClientSettings,
    'hostname' | 'port' | 'useSsl' | 'urlBase'
  >
): string => {
  const base = (settings.urlBase ?? '').replace(/^\/+|\/+$/g, '');
  return `${settings.useSsl ? 'https' : 'http'}://${settings.hostname}:${
    settings.port
  }${base ? `/${base}` : ''}`;
};

/**
 * Session cache key: address, username and a password digest. A different
 * password signs in afresh instead of reusing the saved one's session, so
 * testing a wrong password fails.
 */
export const sessionKeyOf = (
  baseUrl: string,
  username: string,
  password: string
): string =>
  `${baseUrl}|${username}|${createHash('sha256').update(password).digest('hex')}`;

/** A torrent's hash: 40 hex characters, or 64 for a v2-only torrent. */
export const isTorrentHash = (id: string): boolean =>
  /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(id);

const sameHash = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The added torrent's hash as the client reports it is the one read. */
export const assertAddedHash = (
  product: string,
  added: string,
  hash: string
): void => {
  if (!sameHash(added, hash)) {
    throw new Error(`${product} added the torrent under another hash.`);
  }
};

// A busy client can take a while to list what it was just given.
const LISTED_TRIES = 20;
const LISTED_WAIT_MS = 1_000;

/**
 * For clients whose add answer names no hash: waits up to about 20 seconds
 * for the torrent to be listed under the hash read.
 */
export const confirmListed = async (
  client: Pick<TorrentClient, 'product' | 'findTorrent'>,
  hash: string
): Promise<void> => {
  for (let tries = 0; tries < LISTED_TRIES; tries++) {
    if (tries) await new Promise((r) => setTimeout(r, LISTED_WAIT_MS));
    if (await client.findTorrent(hash)) return;
  }
  throw new Error(`${client.product} did not list the torrent under its hash.`);
};

/** One "/"-separated form of a client path, for comparing. */
const tidyDataPath = (path: string): string => {
  const slashed = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const tidy = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
  // Windows paths compare without case.
  return /^[a-z]:(\/|$)|^\/\//i.test(path.replace(/\\/g, '/'))
    ? tidy.toLowerCase()
    : tidy;
};

/** Where a torrent's data is: its folder, or a single file's path. */
export const dataRoot = (savePath: string, name: string): string =>
  savePath && name ? `${savePath.replace(/[\\/]+$/, '')}/${name}` : '';

/**
 * A data root, or none when it is the save folder itself (a torrent added
 * without its own folder), which holds other torrents' files too.
 */
export const rootUnlessSaveFolder = (root: string, savePath: string): string =>
  savePath && tidyDataPath(root) === tidyDataPath(savePath) ? '' : root;

/**
 * Whether a torrent's data root is, holds or is inside another torrent's.
 * Unknown roots share nothing.
 */
export const sharesData = (root: string, others: string[]): boolean => {
  const own = tidyDataPath(root);
  if (own.length <= 1) return false;
  return others
    .map(tidyDataPath)
    .filter((other) => other.length > 1)
    .some(
      (other) =>
        other === own ||
        other.startsWith(`${own}/`) ||
        own.startsWith(`${other}/`)
    );
};
