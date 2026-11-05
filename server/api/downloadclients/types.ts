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
  /** Removes the torrent and its data on disk. */
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
