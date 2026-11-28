import type {
  ClientTorrent,
  ClientTorrentFile,
  LiveDownload,
  TorrentClient,
} from '@server/api/downloadclients/types';
import {
  CLIENT_TIMEOUT_MS,
  assertAddedHash,
  clientBaseUrl,
  dataRoot,
  isTorrentHash,
  sharesData,
} from '@server/api/downloadclients/types';
import type { DownloadClientSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';
import axios, { isAxiosError } from 'axios';

/*
 * Reads the torrents Radarr and Sonarr sent via Transmission's RPC, by hash
 * (their download id).
 *
 * The RPC needs a session id: the first call gets a 409 carrying the id,
 * which is kept between passes and renewed whenever refused again. Username
 * and password, when set, go with every call.
 *
 * Transmission 4.1 moved to JSON-RPC 2.0 with snake_case names; older
 * versions speak only the earlier format. The first call asks the RPC
 * version in the earlier format, which both understand, and the client is
 * spoken to in its own format from then on.
 *
 * For Backfill it also adds torrents, picks their files and removes them.
 * Backfill's category is a label (Transmission 3.0+). Transmission cannot
 * stop a magnet once its file list is in, so its download speed is held at
 * 1 KB/s until Backfill chooses the files.
 */

export interface TransmissionTorrent {
  hashString: string;
  /**
   * 0 stopped, 1 waiting to check, 2 checking, 3 waiting to download,
   * 4 downloading, 5 waiting to seed, 6 seeding.
   */
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

  // A local error (disk full, files gone) needs a person; a tracker error
  // doesn't while peers can still supply the rest.
  if (torrent.error === 3) {
    return { ...base, stage: done ? 'needsAttention' : 'stalled' };
  }
  if ((torrent.metadataPercentComplete ?? 1) < 1) {
    return { ...base, stage: 'queued', step: 'metadata' };
  }
  switch (torrent.status) {
    case 0:
      // Stopped and complete is Transmission's "finished": ready for Radarr
      // or Sonarr to import, as when seeding.
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

/** The torrent fields Backfill reads. */
export interface TransmissionTorrentInfo {
  hashString: string;
  name: string;
  status: number;
  error: number;
  errorString?: string;
  /** 0 to 1, of the wanted files. */
  percentDone: number;
  rateDownload: number;
  eta: number;
  downloadDir: string;
  /** Seconds. */
  addedDate?: number;
  sizeWhenDone: number;
  leftUntilDone: number;
  /** Wanted bytes some connected peer has. */
  desiredAvailable?: number;
  /** Web seeds have everything but aren't counted as peers. */
  webseedsSendingToUs?: number;
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
  'desiredAvailable',
  'webseedsSendingToUs',
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
    unavailable:
      typeof torrent.desiredAvailable === 'number' &&
      !torrent.webseedsSendingToUs
        ? Math.max(
            0,
            (Number(torrent.leftUntilDone) || 0) - torrent.desiredAvailable
          )
        : undefined,
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

/** Labels need RPC version 16 (Transmission 3.0). */
const LABELS_RPC_VERSION = 16;

/**
 * Transmission 4.1 (RPC version 18, RPC semver 6.0.0) speaks JSON-RPC 2.0,
 * with every method and field in snake_case. It still answers the older
 * format, deprecated there; 3.x and 4.0 know only the older one.
 */
const JSON_RPC_VERSION = 18;
const JSON_RPC_SEMVER_MAJOR = 6;

type Protocol = 'jsonrpc' | 'legacy';

interface SessionInfo {
  version?: string;
  'rpc-version'?: number;
}

const SESSION_FIELDS = ['version', 'rpc-version'];

interface LegacyAnswer<T> {
  result?: string;
  arguments?: T;
}

interface JsonRpcAnswer<T> {
  jsonrpc?: string;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: { error_string?: string };
  };
}

/** JSON-RPC's "invalid request" and "method not found". */
const JSON_RPC_WRONG_FORMAT = [-32600, -32601];
/** What the older format says to a method it doesn't know. */
const LEGACY_WRONG_FORMAT = /^(method name not recognized|no method name)$/i;

/** The answer was in the other format, or refused the one sent. */
class WrongFormat extends Error {}

/** `torrent-get`, `hashString`, `delete-local-data` to their 4.1 names. */
export const snakeCase = (name: string): string =>
  name.replace(/-/g, '_').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Every older-format key read back, by its 4.1 name. */
const FROM_SNAKE = new Map(
  [
    ...FIELDS,
    ...INFO_FIELDS,
    ...SESSION_FIELDS,
    'torrents',
    'files',
    'length',
    'bytesCompleted',
    'torrent-added',
    'torrent-duplicate',
  ].map((key) => [snakeCase(key), key])
);

const toJsonRpc = (args: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      snakeCase(key),
      key === 'fields' && Array.isArray(value)
        ? value.map((field) => snakeCase(String(field)))
        : value,
    ])
  );

const fromJsonRpc = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(fromJsonRpc);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      FROM_SNAKE.get(key) ?? key,
      fromJsonRpc(inner),
    ])
  );
};

/** Session ids by client address, kept between passes. */
const sessions = new Map<string, string>();
/**
 * The format each client address speaks, found once and kept between
 * passes. Forgotten when the client can't be reached, comes back without
 * saying its version, or refuses the format.
 */
const protocols = new Map<string, Protocol>();
let requestId = 0;

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
    // The RPC is "rpc" under its base, "/transmission/" by default.
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

  /**
   * One call by its older-format method and argument names, sent in the
   * format the client speaks. Answers come back under the older names too.
   */
  private async call<T>(
    method: string,
    args: Record<string, unknown> = {}
  ): Promise<T> {
    try {
      return await this.post<T>(method, args, await this.protocol());
    } catch (e) {
      if (!(e instanceof WrongFormat)) throw e;
      // Upgraded or downgraded since: find out again, and try once more.
      protocols.delete(this.sessionKey);
      return this.post<T>(method, args, await this.protocol());
    }
  }

  private async protocol(): Promise<Protocol> {
    const known = protocols.get(this.sessionKey);
    if (known) return known;
    await this.detect();
    return protocols.get(this.sessionKey) ?? 'legacy';
  }

  /** Asks in the older format, which every version so far answers. */
  private async detect(): Promise<SessionInfo> {
    try {
      const session = await this.post<SessionInfo>(
        'session-get',
        { fields: SESSION_FIELDS },
        'legacy',
        true
      );
      protocols.set(
        this.sessionKey,
        Number(session?.['rpc-version'] ?? 0) >= JSON_RPC_VERSION
          ? 'jsonrpc'
          : 'legacy'
      );
      return session;
    } catch (e) {
      // A version that no longer takes the older format.
      if (!(e instanceof WrongFormat)) throw e;
      protocols.set(this.sessionKey, 'jsonrpc');
      return this.post<SessionInfo>(
        'session-get',
        { fields: SESSION_FIELDS },
        'jsonrpc',
        true
      );
    }
  }

  /** The version and RPC version, finding the format if not yet known. */
  private async session(): Promise<SessionInfo> {
    if (!protocols.has(this.sessionKey)) {
      return this.detect();
    }
    return this.call<SessionInfo>('session-get', { fields: SESSION_FIELDS });
  }

  private async post<T>(
    method: string,
    args: Record<string, unknown>,
    sentAs: Protocol,
    /** Detection asks in one format whatever a 409 says. */
    pinned = false
  ): Promise<T> {
    let protocol = sentAs;
    const send = () =>
      this.axios.post<unknown>(
        '',
        protocol === 'jsonrpc'
          ? {
              jsonrpc: '2.0',
              method: snakeCase(method),
              params: toJsonRpc(args),
              id: ++requestId,
            }
          : { method, arguments: args },
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
      if (!isAxiosError(e)) throw e;
      if (e.response?.status === 401) {
        throw new Error(
          'Transmission did not accept the username or password.'
        );
      }
      if (!e.response) {
        // Unreachable: it may come back as another version.
        protocols.delete(this.sessionKey);
      }
      const sessionId =
        e.response?.status === 409
          ? e.response.headers['x-transmission-session-id']
          : undefined;
      if (!sessionId) throw e;
      sessions.set(this.sessionKey, String(sessionId));
      // From 4.1 the 409 also carries the RPC version; before, it doesn't.
      const semver = e.response?.headers['x-transmission-rpc-version'];
      if (semver) {
        protocols.set(
          this.sessionKey,
          parseInt(String(semver), 10) >= JSON_RPC_SEMVER_MAJOR
            ? 'jsonrpc'
            : 'legacy'
        );
      } else if (protocols.get(this.sessionKey) === 'jsonrpc') {
        protocols.delete(this.sessionKey);
      }
      // Restarted as another version: resend in its format.
      if (!pinned) {
        protocol = protocols.get(this.sessionKey) ?? protocol;
      }
      answer = await send();
    }
    return protocol === 'jsonrpc'
      ? this.readJsonRpc<T>(answer.data)
      : this.readLegacy<T>(answer.data);
  }

  private readJsonRpc<T>(data: unknown): T {
    if (!data || typeof data !== 'object') {
      throw new Error('Transmission: no answer');
    }
    const answer = data as JsonRpcAnswer<T>;
    if (!('jsonrpc' in answer)) {
      throw new WrongFormat(
        `Transmission: ${(data as LegacyAnswer<T>).result ?? 'no answer'}`
      );
    }
    if (answer.error) {
      const reason =
        answer.error.data?.error_string ||
        answer.error.message ||
        `error ${answer.error.code}`;
      if (JSON_RPC_WRONG_FORMAT.includes(Number(answer.error.code))) {
        throw new WrongFormat(`Transmission: ${reason}`);
      }
      throw new Error(`Transmission: ${reason}`);
    }
    return fromJsonRpc(answer.result) as T;
  }

  private readLegacy<T>(data: unknown): T {
    if (data && typeof data === 'object' && 'jsonrpc' in data) {
      const error = (data as JsonRpcAnswer<T>).error;
      throw new WrongFormat(
        `Transmission: ${error?.message ?? 'answered in JSON-RPC'}`
      );
    }
    const answer = (data ?? {}) as LegacyAnswer<T>;
    if (answer.result !== 'success') {
      const reason = answer.result ?? 'no answer';
      if (LEGACY_WRONG_FORMAT.test(reason)) {
        throw new WrongFormat(`Transmission: ${reason}`);
      }
      throw new Error(`Transmission: ${reason}`);
    }
    return answer.arguments as T;
  }

  public async addTorrent(options: {
    torrent?: Buffer;
    magnet?: string;
    hash: string;
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
    // One already there is someone else's: leave it as it is.
    if (added?.['torrent-duplicate']) {
      throw new Error('The torrent is already in Transmission.');
    }
    const hash = added?.['torrent-added']?.hashString;
    if (!hash) {
      throw new Error('Transmission would not add the torrent.');
    }
    try {
      assertAddedHash(this.product, hash, options.hash);
    } catch (e) {
      await this.call('torrent-remove', { ids: [hash] }).catch(() => undefined);
      throw e;
    }
    await this.call('torrent-set', {
      ids: [hash],
      // Per-torrent ratio limit 0: it stops as soon as it is complete.
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

  /** Labels need no setup. */
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

  /** Starts it, restoring full speed if added to fetch its files. */
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
    const id = hash.toLowerCase();
    const answer = await this.call<{
      torrents?: Pick<
        TransmissionTorrentInfo,
        'hashString' | 'name' | 'downloadDir'
      >[];
    }>('torrent-get', { fields: ['hashString', 'name', 'downloadDir'] });
    const all = answer?.torrents ?? [];
    const own = all.find((t) => String(t.hashString).toLowerCase() === id);
    const others = all
      .filter((t) => t !== own)
      .map((t) => dataRoot(t.downloadDir ?? '', t.name ?? ''));
    await this.call('torrent-remove', {
      ids: [id],
      'delete-local-data': !(
        own &&
        sharesData(dataRoot(own.downloadDir ?? '', own.name ?? ''), others)
      ),
    });
  }

  public async backfillProblems(): Promise<string[]> {
    const session = await this.session();
    return Number(session?.['rpc-version'] ?? 0) < LABELS_RPC_VERSION
      ? [
          `Transmission${session?.version ? ` ${session.version}` : ''} has no labels (3.0 and newer do), so a magnet link Backfill was reading when Seerr AI stopped is not cleared away by it.`,
        ]
      : [];
  }

  public async getVersion(): Promise<string> {
    return (await this.session())?.version ?? 'unknown';
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
