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
import axios, { isAxiosError } from 'axios';

/*
 * The part of Transmission's RPC Seerr reads: the torrents Radarr and Sonarr
 * sent, by hash, which is how they record a torrent as its download id.
 *
 * Transmission guards its RPC with a session id: the first call is refused
 * with 409 and the id to use, which is kept between passes and renewed
 * whenever Transmission refuses it again. A username and password, when
 * set, are sent with every call.
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

interface RpcAnswer<T> {
  result: string;
  arguments?: T;
}

/** Session ids, by client address, kept between passes. */
const sessions = new Map<string, string>();

class TransmissionAPI implements DownloadClient {
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
