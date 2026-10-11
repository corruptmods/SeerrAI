import type {
  ClientTorrent,
  ClientTorrentFile,
  LiveDownload,
  TorrentClient,
} from '@server/api/downloadclients/types';
import {
  CLIENT_TIMEOUT_MS,
  clientBaseUrl,
  isTorrentHash,
} from '@server/api/downloadclients/types';
import type { DownloadClientSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';
import axios, { isAxiosError } from 'axios';

/*
 * The part of Transmission's RPC Seerr reads: the torrents Radarr and Sonarr
 * sent, by hash, which is how they record a torrent as its download id.
 *
 * Transmission guards its RPC with a session id: the first call is refused
 * with 409 and the id to use, which is kept between passes and renewed
 * whenever Transmission refuses it again. A username and password, when
 * set, are sent with every call.
 *
 * For Backfill it also adds, picks the files of, and removes torrents.
 * Backfill's category is a label (Transmission 3.0 and newer). Transmission
 * cannot stop a magnet link once its file list is in, so until Backfill has
 * chosen the files the torrent's download speed is held at 1 KB/s.
 */

export interface TransmissionTorrent {
  hashString: string;
  /** 0 stopped, 1 waiting to check, 2 checking, 3 waiting to download,
   * 4 downloading, 5 waiting to seed, 6 seeding. */
  status: number;
  sizeWhenDone: number;
  leftUntilDone: number;
  /** Seconds; -1 not available, -2 unknown. */
  eta: number;
  /** 0 none, 1 tracker warning, 2 tracker error, 3 local error. */
  error: number;
  peersSendingToUs?: number;
  webseedsSendingToUs?: number;
  metadataPercentComplete?: number;
}

const FIELDS = [
  'hashString',
  'status',
  'sizeWhenDone',
  'leftUntilDone',
  'eta',
  'error',
  'peersSendingToUs',
  'webseedsSendingToUs',
  'metadataPercentComplete',
];

export const transmissionDownload = (
  torrent: TransmissionTorrent
): LiveDownload => {
  const size = Math.max(0, Number(torrent.sizeWhenDone) || 0);
  const sizeLeft = Math.max(0, Number(torrent.leftUntilDone) || 0);
  const base = { size, sizeLeft };
  const done = size > 0 && sizeLeft === 0;

  // A local error (disk full, files gone) needs someone; a tracker's does
  // not, as long as the torrent can still get the rest from its peers.
  if (torrent.error === 3) {
    return { ...base, stage: done ? 'needsAttention' : 'stalled' };
  }
  if ((torrent.metadataPercentComplete ?? 1) < 1) {
    return { ...base, stage: 'queued', step: 'metadata' };
  }
  switch (torrent.status) {
    case 0:
      // Stopped once complete is Transmission's "finished": Radarr's or
      // Sonarr's to import, as when it seeds.
      return { ...base, stage: done ? 'importing' : 'paused' };
    case 1:
    case 2:
      return done
        ? { ...base, stage: 'finishing', step: 'checking' }
        : { ...base, stage: 'queued', step: 'checking' };
    case 3:
      return { ...base, stage: 'queued' };
    case 4: {
      const sources =
        (torrent.peersSendingToUs ?? 0) + (torrent.webseedsSendingToUs ?? 0);
      if (!sources) {
        return { ...base, stage: 'stalled', step: 'noPeers' };
      }
      return {
        ...base,
        stage: 'downloading',
        secondsLeft: torrent.eta > 0 ? torrent.eta : undefined,
      };
    }
    case 5:
    case 6:
      return { ...base, stage: 'importing' };
    default:
      return { ...base, stage: done ? 'importing' : 'downloading' };
  }
};

/** What Backfill reads of a torrent. */
export interface TransmissionTorrentInfo {
  hashString: string;
  name: string;
  status: number;
  error: number;
  errorString?: string;
  /** 0 to 1, of the files wanted. */
  percentDone: number;
  rateDownload: number;
  eta: number;
  downloadDir: string;
  /** Seconds. */
  addedDate?: number;
  sizeWhenDone: number;
  leftUntilDone: number;
  metadataPercentComplete?: number;
  labels?: string[];
}

const INFO_FIELDS = [
  'hashString',
  'name',
  'status',
  'error',
  'errorString',
  'percentDone',
  'rateDownload',
  'eta',
  'downloadDir',
  'addedDate',
  'sizeWhenDone',
  'leftUntilDone',
  'metadataPercentComplete',
  'labels',
];

export const transmissionTorrent = (
  torrent: TransmissionTorrentInfo
): ClientTorrent => {
  const base = {
    hash: String(torrent.hashString ?? '').toLowerCase(),
    name: torrent.name,
    progress: Number(torrent.percentDone) || 0,
    speed: Number(torrent.rateDownload) || 0,
    secondsLeft: torrent.eta > 0 ? torrent.eta : undefined,
    savePath: torrent.downloadDir ?? '',
    addedAt: torrent.addedDate ? torrent.addedDate * 1000 : undefined,
  };
  if (torrent.error === 3) {
    return {
      ...base,
      state: 'error',
      error: torrent.errorString || 'Transmission stopped it on an error',
    };
  }
  if ((torrent.metadataPercentComplete ?? 1) < 1) {
    return { ...base, state: 'metadata' };
  }
  const done = torrent.sizeWhenDone > 0 && torrent.leftUntilDone === 0;
  switch (torrent.status) {
    case 0:
      return { ...base, state: done ? 'done' : 'paused' };
    case 1:
    case 2:
      return { ...base, state: 'checking' };
    case 3:
      return { ...base, state: 'queued' };
    case 5:
    case 6:
      return { ...base, state: 'done' };
    default:
      return { ...base, state: done ? 'done' : 'downloading' };
  }
};

/** Labels came with RPC version 16, Transmission 3.0. */
const LABELS_RPC_VERSION = 16;

interface RpcAnswer<T> {
  result: string;
  arguments?: T;
}

/** Session ids, by client address, kept between passes. */
const sessions = new Map<string, string>();

class TransmissionAPI implements TorrentClient {
  public readonly product = 'Transmission';
  public readonly stopsAtMetadata = false;
  private axios: AxiosInstance;
  private sessionKey: string;

  constructor(
    settings: Pick<
      DownloadClientSettings,
      'hostname' | 'port' | 'useSsl' | 'urlBase' | 'username' | 'password'
    >
  ) {
    // Transmission's RPC is "rpc" under its base, "/transmission/" unless
    // it was changed.
    const base = clientBaseUrl({
      ...settings,
      urlBase: settings.urlBase || '/transmission',
    });
    this.sessionKey = base;
    this.axios = axios.create({
      baseURL: `${base}/rpc`,
      timeout: CLIENT_TIMEOUT_MS,
      auth: settings.username
        ? { username: settings.username, password: settings.password ?? '' }
        : undefined,
    });
  }

  private async call<T>(
    method: string,
    args: Record<string, unknown> = {}
  ): Promise<T> {
    const send = () =>
      this.axios.post<RpcAnswer<T>>(
        '',
        { method, arguments: args },
        {
          headers: sessions.has(this.sessionKey)
            ? { 'X-Transmission-Session-Id': sessions.get(this.sessionKey) }
            : {},
        }
      );
    let answer;
    try {
      answer = await send();
    } catch (e) {
      const sessionId =
        isAxiosError(e) && e.response?.status === 409
          ? e.response.headers['x-transmission-session-id']
          : undefined;
      if (isAxiosError(e) && e.response?.status === 401) {
        throw new Error(
          'Transmission did not accept the username or password.'
        );
      }
      if (!sessionId) throw e;
      sessions.set(this.sessionKey, String(sessionId));
      answer = await send();
    }
    if (answer.data?.result !== 'success') {
      throw new Error(`Transmission: ${answer.data?.result ?? 'no answer'}`);
    }
    return answer.data.arguments as T;
  }

  public async addTorrent(options: {
    torrent?: Buffer;
    magnet?: string;
    category: string;
    metadataOnly?: boolean;
  }): Promise<void> {
    if (!options.torrent && !options.magnet) {
      throw new Error('A torrent file or magnet link is needed.');
    }
    const added = await this.call<
      Record<'torrent-added' | 'torrent-duplicate', { hashString?: string }>
    >(
      'torrent-add',
      options.torrent
        ? { metainfo: options.torrent.toString('base64'), paused: true }
        : // A stopped magnet never fetches its file list.
          { filename: options.magnet, paused: false }
    );
    const hash = (added?.['torrent-added'] ?? added?.['torrent-duplicate'])
      ?.hashString;
    if (!hash) {
      throw new Error('Transmission would not add the torrent.');
    }
    await this.call('torrent-set', {
      ids: [hash],
      // Its own ratio limit of 0: it stops as soon as it is complete.
      seedRatioMode: 1,
      seedRatioLimit: 0,
      ...(options.metadataOnly
        ? { downloadLimited: true, downloadLimit: 1 }
        : {}),
    });
    await this.call('torrent-set', {
      ids: [hash],
      labels: [options.category],
    }).catch(() => undefined); // before 3.0, no labels
  }

  /** A label needs no setting up. */
  public async ensureCategory(): Promise<void> {
    return;
  }

  public async findTorrent(hash: string): Promise<ClientTorrent | undefined> {
    const answer = await this.call<{ torrents?: TransmissionTorrentInfo[] }>(
      'torrent-get',
      { ids: [hash.toLowerCase()], fields: INFO_FIELDS }
    );
    const torrent = (answer?.torrents ?? []).find(
      (t) => String(t.hashString).toLowerCase() === hash.toLowerCase()
    );
    return torrent ? transmissionTorrent(torrent) : undefined;
  }

  public async listCategory(category: string): Promise<ClientTorrent[]> {
    const answer = await this.call<{ torrents?: TransmissionTorrentInfo[] }>(
      'torrent-get',
      { fields: INFO_FIELDS }
    );
    return (answer?.torrents ?? [])
      .filter((t) => (t.labels ?? []).includes(category))
      .map(transmissionTorrent);
  }

  public async getFiles(hash: string): Promise<ClientTorrentFile[]> {
    const answer = await this.call<{
      torrents?: {
        hashString: string;
        files?: { name: string; length: number; bytesCompleted: number }[];
      }[];
    }>('torrent-get', {
      ids: [hash.toLowerCase()],
      fields: ['hashString', 'files'],
    });
    const torrent = (answer?.torrents ?? []).find(
      (t) => String(t.hashString).toLowerCase() === hash.toLowerCase()
    );
    return (torrent?.files ?? []).map((file, index) => ({
      index,
      name: file.name,
      size: Number(file.length) || 0,
      progress: file.length ? file.bytesCompleted / file.length : 1,
    }));
  }

  public async setFilePriority(
    hash: string,
    indexes: number[],
    priority: 0 | 1
  ): Promise<void> {
    if (!indexes.length) return;
    await this.call('torrent-set', {
      ids: [hash.toLowerCase()],
      [priority ? 'files-wanted' : 'files-unwanted']: indexes,
    });
  }

  /** Starts it, at full speed again if it was added to fetch its files. */
  public async startTorrent(hash: string): Promise<void> {
    await this.call('torrent-set', {
      ids: [hash.toLowerCase()],
      downloadLimited: false,
    });
    await this.call('torrent-start', { ids: [hash.toLowerCase()] });
  }

  public async stopTorrent(hash: string): Promise<void> {
    await this.call('torrent-stop', { ids: [hash.toLowerCase()] });
  }

  public async deleteTorrent(hash: string): Promise<void> {
    await this.call('torrent-remove', {
      ids: [hash.toLowerCase()],
      'delete-local-data': true,
    });
  }

  public async backfillProblems(): Promise<string[]> {
    const session = await this.call<{
      version?: string;
      'rpc-version'?: number;
    }>('session-get', { fields: ['version', 'rpc-version'] });
    return Number(session?.['rpc-version'] ?? 0) < LABELS_RPC_VERSION
      ? [
          `Transmission${session?.version ? ` ${session.version}` : ''} has no labels (3.0 and newer do), so a magnet link Backfill was reading when Seerr AI stopped is not cleared away by it.`,
        ]
      : [];
  }

  public async getVersion(): Promise<string> {
    const answer = await this.call<{ version?: string }>('session-get', {
      fields: ['version'],
    });
    return answer?.version ?? 'unknown';
  }

  public async getDownloads(ids: string[]): Promise<Map<string, LiveDownload>> {
    const found = new Map<string, LiveDownload>();
    const mine = ids.filter(isTorrentHash).map((id) => id.toLowerCase());
    if (!mine.length) {
      return found;
    }
    const answer = await this.call<{ torrents?: TransmissionTorrent[] }>(
      'torrent-get',
      { ids: mine, fields: FIELDS }
    );
    const wanted = new Set(mine);
    for (const torrent of answer?.torrents ?? []) {
      const hash = String(torrent.hashString ?? '').toLowerCase();
      if (wanted.has(hash)) {
        found.set(hash, transmissionDownload(torrent));
      }
    }
    return found;
  }
}

export default TransmissionAPI;
