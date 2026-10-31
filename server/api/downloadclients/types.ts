import type { DownloadStage, DownloadStep } from '@server/constants/downloads';
import type { DownloadClientSettings } from '@server/lib/settings';
import { createHash } from 'node:crypto';

/** One download as its download client reports it, right now. */
export interface LiveDownload {
  size: number;
  sizeLeft: number;
  /** Until it finishes downloading, when the client can say. */
  secondsLeft?: number;
  stage: DownloadStage;
  step?: DownloadStep;
}

export interface DownloadClient {
  /** The client's version; also proves the address and sign-in work. */
  getVersion(): Promise<string>;
  /**
   * The downloads among `ids` that this client holds, by id in lower case.
   * Ids that aren't this client's are passed over.
   */
  getDownloads(ids: string[]): Promise<Map<string, LiveDownload>>;
}

/*
 * What Backfill does with a download client, which it adds to, follows and
 * removes from itself. Every client implements one of the two below, in its
 * own API, so the engine treats them all alike.
 */

/** What a torrent is doing, whichever client has it. */
export type TorrentState =
  /** Fetching its file list from the swarm (a magnet link). */
  | 'metadata'
  /** Checking what it has on disk. */
  | 'checking'
  /** Waiting its turn behind the client's own limit on downloads. */
  | 'queued'
  | 'paused'
  | 'downloading'
  /** Being moved to another folder by the client. */
  | 'moving'
  /** Everything wanted is in, seeding or stopped. */
  | 'done'
  /** Stopped on an error of its own (disk full, files gone). */
  | 'error';

export interface ClientTorrent {
  /** The info hash, in lower case. */
  hash: string;
  name: string;
  state: TorrentState;
  /** The client's own words, when the state is 'error'. */
  error?: string;
  /** 0 to 1, of what is wanted. */
  progress: number;
  /** Bytes a second. */
  speed: number;
  /** Until it is downloaded; undefined when the client has no estimate. */
  secondsLeft?: number;
  /**
   * The folder its files' names are under, in the client's own paths: a
   * file is at savePath/name.
   */
  savePath: string;
  /** When it was added (ms); undefined when the client cannot say. */
  addedAt?: number;
  /**
   * Bytes of what is wanted and not yet in that no peer connected has;
   * undefined when the client cannot say.
   */
  unavailable?: number;
}

export interface ClientTorrentFile {
  /** Its position in the torrent, as the .torrent file lists them. */
  index: number;
  /** Its path, with the torrent's folder in front for a multi-file one. */
  name: string;
  size: number;
  /** 0 to 1. */
  progress: number;
  /**
   * 0 to 1: the share of its pieces some peer connected has (or that are
   * in); undefined when the client cannot say.
   */
  availability?: number;
}

export interface TorrentClient extends DownloadClient {
  /** The product, for what Backfill shows: "Paused in Transmission". */
  readonly product: string;
  /**
   * Whether a magnet link added with metadataOnly stops by itself once its
   * file list is in. A client that cannot is watched closely until it is,
   * and its download speed for that torrent is held down meanwhile where
   * the client allows it.
   */
  readonly stopsAtMetadata: boolean;
  /**
   * Adds a torrent from its .torrent file (stopped, so its files can be
   * chosen before anything downloads) or a magnet link (started, to fetch
   * its file list). Backfill stops it once its files are in; nothing set
   * on it lets the client remove it before they are imported.
   */
  addTorrent(options: {
    torrent?: Buffer;
    magnet?: string;
    category: string;
    metadataOnly?: boolean;
  }): Promise<void>;
  /** Makes sure Backfill's category (or label) can be used. */
  ensureCategory(category: string): Promise<void>;
  /** The torrent with this hash, or undefined if the client has none. */
  findTorrent(hash: string): Promise<ClientTorrent | undefined>;
  /** The torrents in a category (label), for clearing probes left behind. */
  listCategory(category: string): Promise<ClientTorrent[]>;
  /** A torrent's files, in index order; empty until its file list is in. */
  getFiles(hash: string): Promise<ClientTorrentFile[]>;
  /** 0 skips the files, 1 downloads them. */
  setFilePriority(
    hash: string,
    indexes: number[],
    priority: 0 | 1
  ): Promise<void>;
  startTorrent(hash: string): Promise<void>;
  stopTorrent(hash: string): Promise<void>;
  /** Removes the torrent and whatever of it is on disk. */
  deleteTorrent(hash: string): Promise<void>;
  /** What keeps Backfill from using it fully, in words; empty if nothing. */
  backfillProblems(): Promise<string[]>;
}

/**
 * A Usenet job as Backfill follows it. Its status, in lower case, is one
 * of SABnzbd's words, which every Usenet client's are put into:
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
   * Bytes a second: 0 while it waits its turn, undefined when several jobs
   * download at once and the client's one figure cannot be split.
   */
  speed?: number;
  /** Where the finished job's files are, in the client's own paths. */
  storage?: string;
  failMessage?: string;
}

export interface UsenetClient extends DownloadClient {
  readonly product: string;
  /** Adds an NZB file; answers the client's id for the new job. */
  addNzb(nzb: Buffer, name: string, category: string): Promise<string>;
  /** Where a job is and what the client says about it; undefined if gone. */
  getJob(id: string): Promise<UsenetJob | undefined>;
  pauseJob(id: string): Promise<void>;
  resumeJob(id: string): Promise<void>;
  /** Removes the job, wherever it is, and as much of its files as it can. */
  deleteJob(id: string): Promise<void>;
  backfillProblems(): Promise<string[]>;
}

/** Long enough for a busy client, short enough never to hold up a page. */
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
 * What a client's signed-in session is kept under: its address and the
 * sign-in, the password only as a digest. Another password signs in afresh
 * rather than riding on the session the saved one opened, so testing a
 * wrong one fails.
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
