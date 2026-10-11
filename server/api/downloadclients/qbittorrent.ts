import type {
  ClientTorrent,
  LiveDownload,
  TorrentClient,
  TorrentState,
} from '@server/api/downloadclients/types';
import {
  CLIENT_TIMEOUT_MS,
  clientBaseUrl,
  isTorrentHash,
} from '@server/api/downloadclients/types';
import type { DownloadClientSettings } from '@server/lib/settings';
import type { AxiosInstance, AxiosResponse } from 'axios';
import axios, { isAxiosError } from 'axios';

/*
 * The part of qBittorrent's Web API (v2) Seerr reads: the torrents Radarr and
 * Sonarr sent, by hash, which is how they record a torrent as its download
 * id. qBittorrent signs a session in with a cookie; it is kept between
 * passes and renewed only when qBittorrent turns it down, so a busy page
 * doesn't sign in every few seconds.
 */

interface Torrent {
  hash: string;
  state: string;
  size: number;
  amount_left: number;
  eta: number;
  num_seeds?: number;
}

/** What Backfill reads of a torrent. */
export interface QbitTorrentInfo {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  amount_left: number;
  eta: number;
  dlspeed: number;
  save_path: string;
  content_path: string;
  num_seeds?: number;
}

/** One file of a torrent; `name` is its path inside the torrent. */
export interface QbitFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}

/** qBittorrent's "no estimate". */
const ETA_UNKNOWN = 8_640_000;

/** qBittorrent's states; one not listed is downloading or waiting for peers. */
const QBIT_STATES: Record<string, TorrentState> = {
  metaDL: 'metadata',
  forcedMetaDL: 'metadata',
  checkingDL: 'checking',
  checkingUP: 'checking',
  checkingResumeData: 'checking',
  allocating: 'checking',
  queuedDL: 'queued',
  pausedDL: 'paused',
  stoppedDL: 'paused',
  moving: 'moving',
  uploading: 'done',
  forcedUP: 'done',
  stalledUP: 'done',
  queuedUP: 'done',
  pausedUP: 'done',
  stoppedUP: 'done',
  error: 'error',
  missingFiles: 'error',
};

/** A torrent as Backfill follows it, in every client's terms. */
export const qbitTorrent = (
  torrent: QbitTorrentInfo & { added_on?: number }
): ClientTorrent => {
  const state = QBIT_STATES[torrent.state] ?? 'downloading';
  const eta = Number(torrent.eta);
  return {
    hash: String(torrent.hash ?? '').toLowerCase(),
    name: torrent.name,
    state,
    error:
      state !== 'error'
        ? undefined
        : torrent.state === 'missingFiles'
          ? 'its files are missing'
          : 'qBittorrent stopped it on an error',
    progress: Number(torrent.progress) || 0,
    speed: Number(torrent.dlspeed) || 0,
    secondsLeft: eta > 0 && eta < ETA_UNKNOWN ? eta : undefined,
    savePath: torrent.save_path ?? '',
    addedAt: torrent.added_on ? torrent.added_on * 1000 : undefined,
  };
};

export const qbitDownload = (torrent: Torrent): LiveDownload => {
  const size = Number(torrent.size) || 0;
  const sizeLeft = Math.max(0, Number(torrent.amount_left) || 0);
  const secondsLeft =
    torrent.eta > 0 && torrent.eta < ETA_UNKNOWN ? torrent.eta : undefined;
  const base = { size, sizeLeft };

  switch (torrent.state) {
    case 'downloading':
    case 'forcedDL':
      return { ...base, stage: 'downloading', secondsLeft };
    case 'stalledDL':
      return { ...base, stage: 'stalled', step: 'noPeers' };
    case 'pausedDL':
    case 'stoppedDL':
      return { ...base, stage: 'paused' };
    case 'queuedDL':
    case 'allocating':
      return { ...base, stage: 'queued' };
    case 'metaDL':
    case 'forcedMetaDL':
      return { ...base, stage: 'queued', step: 'metadata' };
    case 'checkingDL':
    case 'checkingResumeData':
      return { ...base, stage: 'queued', step: 'checking' };
    case 'checkingUP':
      return { ...base, stage: 'finishing', step: 'checking' };
    case 'moving':
      return { ...base, stage: 'finishing', step: 'moving' };
    case 'uploading':
    case 'forcedUP':
    case 'stalledUP':
    case 'queuedUP':
    case 'pausedUP':
    case 'stoppedUP':
      // Downloaded; seeding or not, it is Radarr's or Sonarr's to import.
      return { ...base, stage: 'importing' };
    case 'error':
      return {
        ...base,
        stage: sizeLeft > 0 ? 'stalled' : 'needsAttention',
      };
    case 'missingFiles':
      return { ...base, stage: 'needsAttention' };
    default:
      return { ...base, stage: sizeLeft > 0 ? 'downloading' : 'importing' };
  }
};

/** Signed-in sessions, by client address and user, kept between passes. */
const sessions = new Map<string, string>();

class QBittorrentAPI implements TorrentClient {
  public readonly product = 'qBittorrent';
  /** Its "stop condition": a magnet stops once its file list is in. */
  public readonly stopsAtMetadata = true;
  private axios: AxiosInstance;
  private baseUrl: string;
  private username: string;
  private password: string;
  private sessionKey: string;

  constructor(
    settings: Pick<
      DownloadClientSettings,
      'hostname' | 'port' | 'useSsl' | 'urlBase' | 'username' | 'password'
    >
  ) {
    this.baseUrl = clientBaseUrl(settings);
    this.username = settings.username ?? '';
    this.password = settings.password ?? '';
    this.sessionKey = `${this.baseUrl}|${this.username}`;
    this.axios = axios.create({
      baseURL: `${this.baseUrl}/api/v2`,
      timeout: CLIENT_TIMEOUT_MS,
      // qBittorrent refuses requests whose Referer is another site.
      headers: { Referer: this.baseUrl },
    });
  }

  private async signIn(): Promise<void> {
    const response = await this.axios.post<string>(
      '/auth/login',
      new URLSearchParams({
        username: this.username,
        password: this.password,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const cookies = (response.headers['set-cookie'] ?? [])
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    if (String(response.data).trim() !== 'Ok.' || !cookies) {
      throw new Error('qBittorrent did not accept the username or password.');
    }
    sessions.set(this.sessionKey, cookies);
  }

  private async get<T>(
    path: string,
    params?: Record<string, string>
  ): Promise<AxiosResponse<T>> {
    const send = () =>
      this.axios.get<T>(path, {
        params,
        headers: sessions.has(this.sessionKey)
          ? { Cookie: sessions.get(this.sessionKey) }
          : {},
      });
    // With no username, qBittorrent is expected to let this address in
    // without signing in (its "bypass authentication" settings).
    if (!sessions.has(this.sessionKey) && this.username) {
      await this.signIn();
    }
    try {
      return await send();
    } catch (e) {
      if (isAxiosError(e) && e.response?.status === 403 && this.username) {
        sessions.delete(this.sessionKey);
        await this.signIn();
        return send();
      }
      throw e;
    }
  }

  private async post<T>(
    path: string,
    body: Record<string, string> | FormData
  ): Promise<AxiosResponse<T>> {
    const form =
      body instanceof FormData ? body : new URLSearchParams(body).toString();
    const send = () =>
      this.axios.post<T>(path, form, {
        headers: {
          ...(body instanceof FormData
            ? {}
            : { 'Content-Type': 'application/x-www-form-urlencoded' }),
          ...(sessions.has(this.sessionKey)
            ? { Cookie: sessions.get(this.sessionKey) }
            : {}),
        },
      });
    if (!sessions.has(this.sessionKey) && this.username) {
      await this.signIn();
    }
    try {
      return await send();
    } catch (e) {
      if (isAxiosError(e) && e.response?.status === 403 && this.username) {
        sessions.delete(this.sessionKey);
        await this.signIn();
        return send();
      }
      throw e;
    }
  }

  /*
   * Writing, for Backfill: it adds a pack it found, picks the files it needs,
   * and removes the torrent once Sonarr has imported them. qBittorrent 5
   * renamed pause/resume to stop/start; both names are tried.
   */

  /**
   * Adds a torrent from its .torrent file or a magnet link. It is added
   * stopped, so its files can be chosen before anything downloads, and with
   * seeding switched off, so it stops once the chosen files are in.
   */
  public async addTorrent(options: {
    torrent?: Buffer;
    magnet?: string;
    category: string;
    savePath?: string;
    /**
     * Start at once and stop when the file list is in: how a magnet link's
     * files are learned without downloading any of them.
     */
    metadataOnly?: boolean;
  }): Promise<void> {
    const form = new FormData();
    if (options.torrent) {
      form.append(
        'torrents',
        new Blob([new Uint8Array(options.torrent)], {
          type: 'application/x-bittorrent',
        }),
        'backfill.torrent'
      );
    } else if (options.magnet) {
      form.append('urls', options.magnet);
    } else {
      throw new Error('A torrent file or magnet link is needed.');
    }
    form.append('category', options.category);
    if (options.metadataOnly) {
      form.append('stopCondition', 'MetadataReceived');
    } else {
      form.append('paused', 'true');
      form.append('stopped', 'true');
    }
    form.append('ratioLimit', '0');
    form.append('seedingTimeLimit', '0');
    if (options.savePath) {
      form.append('savepath', options.savePath);
    }
    const { data } = await this.post<string>('/torrents/add', form);
    if (String(data).trim().toLowerCase().startsWith('fails')) {
      throw new Error('qBittorrent would not add the torrent.');
    }
  }

  /** Makes sure the category exists; qBittorrent answers 409 if it does. */
  public async ensureCategory(category: string): Promise<void> {
    try {
      await this.post('/torrents/createCategory', { category, savePath: '' });
    } catch (e) {
      if (isAxiosError(e) && e.response?.status === 409) {
        return;
      }
      throw e;
    }
  }

  /** The torrent with this hash, or undefined if qBittorrent has none. */
  public async getTorrent(hash: string): Promise<QbitTorrentInfo | undefined> {
    const { data } = await this.get<QbitTorrentInfo[]>('/torrents/info', {
      hashes: hash.toLowerCase(),
    });
    // Only that torrent: a client that ignored the filter would otherwise
    // hand back the first of all of them, and its speed for every job.
    return Array.isArray(data)
      ? data.find((t) => t.hash?.toLowerCase() === hash.toLowerCase())
      : undefined;
  }

  /** The torrents in a category, with when each was added. */
  public async getCategoryTorrents(
    category: string
  ): Promise<(QbitTorrentInfo & { added_on: number })[]> {
    const { data } = await this.get<(QbitTorrentInfo & { added_on: number })[]>(
      '/torrents/info',
      { category }
    );
    return Array.isArray(data) ? data : [];
  }

  public async findTorrent(hash: string): Promise<ClientTorrent | undefined> {
    const torrent = await this.getTorrent(hash);
    return torrent ? qbitTorrent(torrent) : undefined;
  }

  public async listCategory(category: string): Promise<ClientTorrent[]> {
    return (await this.getCategoryTorrents(category)).map(qbitTorrent);
  }

  public async backfillProblems(): Promise<string[]> {
    return [];
  }

  /** A torrent's files, in index order; empty until its metadata is in. */
  public async getFiles(hash: string): Promise<QbitFile[]> {
    const { data } = await this.get<QbitFile[]>('/torrents/files', {
      hash: hash.toLowerCase(),
    });
    // Older Web APIs leave the index out; it is the position in the list.
    return (Array.isArray(data) ? data : []).map((file, position) => ({
      ...file,
      index: Number.isInteger(file.index) ? file.index : position,
    }));
  }

  /** Priority 0 skips a file; 1 downloads it. */
  public async setFilePriority(
    hash: string,
    indexes: number[],
    priority: 0 | 1
  ): Promise<void> {
    if (!indexes.length) {
      return;
    }
    await this.post('/torrents/filePrio', {
      hash: hash.toLowerCase(),
      id: indexes.join('|'),
      priority: String(priority),
    });
  }

  public async startTorrent(hash: string): Promise<void> {
    await this.either('/torrents/start', '/torrents/resume', hash);
  }

  public async stopTorrent(hash: string): Promise<void> {
    await this.either('/torrents/stop', '/torrents/pause', hash);
  }

  /** Removes the torrent and whatever of it is still on disk. */
  public async deleteTorrent(hash: string): Promise<void> {
    await this.post('/torrents/delete', {
      hashes: hash.toLowerCase(),
      deleteFiles: 'true',
    });
  }

  private async either(current: string, older: string, hash: string) {
    try {
      await this.post(current, { hashes: hash.toLowerCase() });
    } catch (e) {
      if (isAxiosError(e) && e.response?.status === 404) {
        await this.post(older, { hashes: hash.toLowerCase() });
        return;
      }
      throw e;
    }
  }

  public async getVersion(): Promise<string> {
    const { data } = await this.get<string>('/app/version');
    return String(data).trim() || 'unknown';
  }

  public async getDownloads(ids: string[]): Promise<Map<string, LiveDownload>> {
    const found = new Map<string, LiveDownload>();
    const mine = ids.filter(isTorrentHash);
    if (!mine.length) {
      return found;
    }
    const { data } = await this.get<Torrent[]>('/torrents/info', {
      hashes: mine.map((id) => id.toLowerCase()).join('|'),
    });
    for (const torrent of Array.isArray(data) ? data : []) {
      found.set(torrent.hash.toLowerCase(), qbitDownload(torrent));
    }
    return found;
  }
}

export default QBittorrentAPI;
