import type {
  DownloadClient,
  LiveDownload,
} from '@server/api/downloadclients/types';
import {
  CLIENT_TIMEOUT_MS,
  clientBaseUrl,
  isTorrentHash,
} from '@server/api/downloadclients/types';
import type { DownloadClientSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';
import axios from 'axios';

/*
 * The part of Deluge's Web UI JSON-RPC Seerr reads: the torrents Radarr and
 * Sonarr sent, by hash, which is how they record a torrent as its download
 * id. Deluge signs in with its Web UI password alone, into a session kept in
 * a cookie between passes and renewed when Deluge forgets it; the Web UI is
 * connected to its daemon first if it is not already, as Sonarr does.
 */

export interface DelugeTorrent {
  /** Downloading, Seeding, Paused, Checking, Queued, Error, Allocating,
   * Moving. */
  state: string;
  total_wanted: number;
  total_done: number;
  /** Seconds; 0 when Deluge has no estimate. */
  eta: number;
  is_finished?: boolean;
  num_seeds?: number;
  num_peers?: number;
}

const FIELDS = [
  'state',
  'total_wanted',
  'total_done',
  'eta',
  'is_finished',
  'num_seeds',
  'num_peers',
];

export const delugeDownload = (torrent: DelugeTorrent): LiveDownload => {
  const size = Math.max(0, Number(torrent.total_wanted) || 0);
  const sizeLeft = Math.max(0, size - (Number(torrent.total_done) || 0));
  const base = { size, sizeLeft };
  const done = !!torrent.is_finished || (size > 0 && sizeLeft === 0);

  switch (torrent.state) {
    case 'Downloading':
      if (!torrent.num_seeds && !torrent.num_peers) {
        return { ...base, stage: 'stalled', step: 'noPeers' };
      }
      return {
        ...base,
        stage: 'downloading',
        secondsLeft: torrent.eta > 0 ? torrent.eta : undefined,
      };
    case 'Seeding':
      return { ...base, stage: 'importing' };
    case 'Paused':
      return { ...base, stage: done ? 'importing' : 'paused' };
    case 'Queued':
      return { ...base, stage: done ? 'importing' : 'queued' };
    case 'Allocating':
      return { ...base, stage: 'queued' };
    case 'Checking':
      return done
        ? { ...base, stage: 'finishing', step: 'checking' }
        : { ...base, stage: 'queued', step: 'checking' };
    case 'Moving':
      return { ...base, stage: 'finishing', step: 'moving' };
    case 'Error':
      return { ...base, stage: done ? 'needsAttention' : 'stalled' };
    default:
      return { ...base, stage: done ? 'importing' : 'downloading' };
  }
};

interface RpcAnswer<T> {
  result: T;
  error: { message?: string; code?: number } | null;
  id: number;
}

/** Signed-in sessions, by client address, kept between passes. */
const sessions = new Map<string, string>();

class DelugeAPI implements DownloadClient {
  private axios: AxiosInstance;
  private sessionKey: string;
  private password: string;
  private requestId = 0;

  constructor(
    settings: Pick<
      DownloadClientSettings,
      'hostname' | 'port' | 'useSsl' | 'urlBase' | 'password'
    >
  ) {
    const base = clientBaseUrl(settings);
    this.sessionKey = base;
    this.password = settings.password ?? '';
    this.axios = axios.create({
      baseURL: `${base}/json`,
      timeout: CLIENT_TIMEOUT_MS,
    });
  }

  private async raw<T>(
    method: string,
    params: unknown[]
  ): Promise<RpcAnswer<T>> {
    const { data } = await this.axios.post<RpcAnswer<T>>(
      '',
      { method, params, id: ++this.requestId },
      {
        headers: sessions.has(this.sessionKey)
          ? { Cookie: sessions.get(this.sessionKey) }
          : {},
      }
    );
    return data;
  }

  private async signIn(): Promise<void> {
    const response = await this.axios.post<RpcAnswer<boolean>>('', {
      method: 'auth.login',
      params: [this.password],
      id: ++this.requestId,
    });
    const cookies = (response.headers['set-cookie'] ?? [])
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    if (response.data?.result !== true || !cookies) {
      throw new Error('Deluge did not accept the password.');
    }
    sessions.set(this.sessionKey, cookies);
    await this.ensureConnected();
  }

  /** The Web UI talks to a daemon; connect it to the first one if needed. */
  private async ensureConnected(): Promise<void> {
    const connected = await this.raw<boolean>('web.connected', []);
    if (connected.result) return;
    const hosts = await this.raw<[string, ...unknown[]][]>('web.get_hosts', []);
    const host = hosts.result?.[0]?.[0];
    if (!host) {
      throw new Error('Deluge: its Web UI is not connected to a daemon.');
    }
    await this.raw('web.connect', [host]);
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    if (!sessions.has(this.sessionKey)) {
      await this.signIn();
    }
    let answer = await this.raw<T>(method, params);
    // Code 1: not signed in, the session having expired or Deluge restarted.
    if (answer.error?.code === 1) {
      sessions.delete(this.sessionKey);
      await this.signIn();
      answer = await this.raw<T>(method, params);
    }
    if (answer.error) {
      throw new Error(`Deluge: ${answer.error.message ?? 'error'}`);
    }
    return answer.result;
  }

  public async getVersion(): Promise<string> {
    const version = await this.call<string>('daemon.info', []);
    return version || 'unknown';
  }

  public async getDownloads(ids: string[]): Promise<Map<string, LiveDownload>> {
    const found = new Map<string, LiveDownload>();
    const mine = ids.filter(isTorrentHash).map((id) => id.toLowerCase());
    if (!mine.length) {
      return found;
    }
    const torrents = await this.call<Record<string, DelugeTorrent>>(
      'core.get_torrents_status',
      [{ id: mine }, FIELDS]
    );
    const wanted = new Set(mine);
    for (const [hash, torrent] of Object.entries(torrents ?? {})) {
      if (wanted.has(hash.toLowerCase())) {
        found.set(hash.toLowerCase(), delugeDownload(torrent));
      }
    }
    return found;
  }
}

export default DelugeAPI;
