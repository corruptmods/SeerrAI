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
  sessionKeyOf,
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
 *
 * For Backfill it also adds, picks the files of, and removes torrents.
 * Backfill's category is a label, from Deluge's Label plugin when it is on.
 * Deluge cannot stop a magnet link once its file list is in, so until
 * Backfill has chosen the files the torrent's download speed is held at
 * 1 KiB/s.
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

/** What Backfill reads of a torrent. */
export interface DelugeTorrentInfo {
  name: string;
  state: string;
  /** 0 to 100. */
  progress: number;
  download_payload_rate: number;
  eta: number;
  save_path: string;
  /** Seconds. */
  time_added?: number;
  message?: string;
  is_finished?: boolean;
  total_wanted: number;
  total_done: number;
}

const INFO_FIELDS = [
  'name',
  'state',
  'progress',
  'download_payload_rate',
  'eta',
  'save_path',
  'time_added',
  'message',
  'is_finished',
  'total_wanted',
  'total_done',
];

export const delugeTorrent = (
  hash: string,
  torrent: DelugeTorrentInfo
): ClientTorrent => {
  const base = {
    hash: hash.toLowerCase(),
    name: torrent.name,
    progress: (Number(torrent.progress) || 0) / 100,
    speed: Number(torrent.download_payload_rate) || 0,
    secondsLeft: torrent.eta > 0 ? torrent.eta : undefined,
    savePath: torrent.save_path ?? '',
    addedAt: torrent.time_added ? torrent.time_added * 1000 : undefined,
  };
  const wanted = Number(torrent.total_wanted) || 0;
  const done =
    !!torrent.is_finished ||
    (wanted > 0 && (Number(torrent.total_done) || 0) >= wanted);
  switch (torrent.state) {
    case 'Error':
      return {
        ...base,
        state: 'error',
        error:
          torrent.message && torrent.message !== 'OK'
            ? torrent.message
            : 'Deluge stopped it on an error',
      };
    case 'Checking':
    case 'Allocating':
      return { ...base, state: 'checking' };
    case 'Moving':
      return { ...base, state: 'moving' };
    case 'Seeding':
      return { ...base, state: 'done' };
    case 'Paused':
      return { ...base, state: done ? 'done' : 'paused' };
    case 'Queued':
      return { ...base, state: done ? 'done' : 'queued' };
    default:
      // A magnet link has nothing to want until its file list is in.
      if (!wanted) return { ...base, state: 'metadata' };
      return { ...base, state: done ? 'done' : 'downloading' };
  }
};

/** Deluge's labels: lower case letters, digits, "_" and "-". */
export const delugeLabel = (category: string): string =>
  category.toLowerCase().replace(/[^a-z0-9_-]/g, '_');

interface RpcAnswer<T> {
  result: T;
  error: { message?: string; code?: number } | null;
  id: number;
}

/** Signed-in sessions, by client address and password, kept between passes. */
const sessions = new Map<string, string>();

class DelugeAPI implements TorrentClient {
  public readonly product = 'Deluge';
  public readonly stopsAtMetadata = false;
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
    this.password = settings.password ?? '';
    this.sessionKey = sessionKeyOf(base, '', this.password);
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

  private async labelsOn(): Promise<boolean> {
    const plugins = await this.call<string[]>('core.get_enabled_plugins', []);
    return (plugins ?? []).includes('Label');
  }

  public async addTorrent(options: {
    torrent?: Buffer;
    magnet?: string;
    category: string;
    metadataOnly?: boolean;
  }): Promise<void> {
    const settings = {
      // A paused magnet never fetches its file list.
      add_paused: !!options.torrent,
      stop_at_ratio: true,
      stop_ratio: 0,
      // Stopped once done, never removed: Deluge set to remove torrents at
      // their ratio would otherwise take this one before it is imported.
      remove_at_ratio: false,
      max_download_speed: options.metadataOnly ? 1 : -1,
    };
    let hash: string | null;
    if (options.torrent) {
      hash = await this.call<string | null>('core.add_torrent_file', [
        'backfill.torrent',
        options.torrent.toString('base64'),
        settings,
      ]);
    } else if (options.magnet) {
      hash = await this.call<string | null>('core.add_torrent_magnet', [
        options.magnet,
        settings,
      ]);
    } else {
      throw new Error('A torrent file or magnet link is needed.');
    }
    if (!hash) {
      throw new Error('Deluge would not add the torrent.');
    }
    if (await this.labelsOn()) {
      await this.call('label.set_torrent', [
        hash,
        delugeLabel(options.category),
      ]);
    }
  }

  public async ensureCategory(category: string): Promise<void> {
    if (!(await this.labelsOn())) return;
    const label = delugeLabel(category);
    const labels = await this.call<string[]>('label.get_labels', []);
    if (!(labels ?? []).includes(label)) {
      await this.call('label.add', [label]);
    }
  }

  public async findTorrent(hash: string): Promise<ClientTorrent | undefined> {
    let torrent: DelugeTorrentInfo | Record<string, never>;
    try {
      torrent = await this.call('core.get_torrent_status', [
        hash.toLowerCase(),
        INFO_FIELDS,
      ]);
    } catch (e) {
      // Deluge 1.3 answers an unknown hash with an error.
      if (/KeyError|InvalidTorrent/i.test(String((e as Error).message))) {
        return undefined;
      }
      throw e;
    }
    // Deluge 2 answers it with no fields at all.
    return torrent && 'state' in torrent
      ? delugeTorrent(hash, torrent as DelugeTorrentInfo)
      : undefined;
  }

  public async listCategory(category: string): Promise<ClientTorrent[]> {
    if (!(await this.labelsOn())) return [];
    const torrents = await this.call<Record<string, DelugeTorrentInfo>>(
      'core.get_torrents_status',
      [{ label: delugeLabel(category) }, INFO_FIELDS]
    );
    return Object.entries(torrents ?? {}).map(([hash, torrent]) =>
      delugeTorrent(hash, torrent)
    );
  }

  public async getFiles(hash: string): Promise<ClientTorrentFile[]> {
    const status = await this.call<{
      files?: { index: number; path: string; size: number }[];
      file_progress?: number[];
    }>('core.get_torrent_status', [
      hash.toLowerCase(),
      ['files', 'file_progress'],
    ]);
    return (status?.files ?? []).map((file, position) => {
      const index = Number.isInteger(file.index) ? file.index : position;
      return {
        index,
        name: file.path,
        size: Number(file.size) || 0,
        progress: Number(status?.file_progress?.[index]) || 0,
      };
    });
  }

  public async setFilePriority(
    hash: string,
    indexes: number[],
    priority: 0 | 1
  ): Promise<void> {
    if (!indexes.length) return;
    const id = hash.toLowerCase();
    const status = await this.call<{ file_priorities?: number[] }>(
      'core.get_torrent_status',
      [id, ['file_priorities']]
    );
    const priorities = [...(status?.file_priorities ?? [])];
    // Deluge 2's "normal" is 4; Deluge 1.3's is 1.
    const normal = (await this.getVersion()).startsWith('1.') ? 1 : 4;
    for (const index of indexes) {
      if (index < priorities.length) priorities[index] = priority ? normal : 0;
    }
    try {
      await this.call('core.set_torrent_options', [
        [id],
        { file_priorities: priorities },
      ]);
    } catch {
      await this.call('core.set_torrent_file_priorities', [id, priorities]);
    }
  }

  /** Starts it, at full speed again if it was added to fetch its files. */
  public async startTorrent(hash: string): Promise<void> {
    const id = hash.toLowerCase();
    await this.call('core.set_torrent_options', [
      [id],
      { max_download_speed: -1 },
    ]);
    await this.call('core.resume_torrent', [[id]]);
  }

  public async stopTorrent(hash: string): Promise<void> {
    await this.call('core.pause_torrent', [[hash.toLowerCase()]]);
  }

  public async deleteTorrent(hash: string): Promise<void> {
    await this.call('core.remove_torrent', [hash.toLowerCase(), true]);
  }

  public async backfillProblems(): Promise<string[]> {
    return (await this.labelsOn())
      ? []
      : [
          "Deluge's Label plugin is off, so Backfill's downloads carry no label, and a magnet link Backfill was reading when Seerr AI stopped is not cleared away by it. Turn it on under Preferences → Plugins.",
        ];
  }

  /**
   * The daemon's version. Deluge 2 answers daemon.get_version, and has no
   * daemon.info; Deluge 1.3 has only daemon.info.
   */
  public async getVersion(): Promise<string> {
    let version: string;
    try {
      version = await this.call<string>('daemon.get_version', []);
    } catch (e) {
      if (!(e instanceof Error) || !/unknown method/i.test(e.message)) throw e;
      version = await this.call<string>('daemon.info', []);
    }
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
