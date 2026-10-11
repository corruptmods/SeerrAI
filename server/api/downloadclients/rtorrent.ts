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
import { parseStringPromise } from 'xml2js';

/*
 * The part of rTorrent's XML-RPC Seerr reads: every torrent in its main
 * view, of which the ones Radarr and Sonarr sent are kept, by hash, which is
 * how they record a torrent as its download id. rTorrent is reached through
 * whatever web server exposes its XML-RPC (ruTorrent's, usually at "RPC2"),
 * with that server's basic auth when it has one.
 *
 * For Backfill it also adds, picks the files of, and removes torrents.
 * Backfill's category is the label ruTorrent shows (custom1). rTorrent's
 * RPC cannot delete a torrent's files; they are deleted through its
 * "execute" command, one known file at a time, as ruTorrent's own
 * "erase data" does. rTorrent cannot stop a magnet link once its file list
 * is in; Backfill watches it closely until it is.
 */

/** One torrent, in the order FIELDS asks for them. */
export interface RtorrentTorrent {
  hash: string;
  /** 0 stopped, 1 started. */
  state: number;
  /** 0 when paused (open but not active). */
  isActive: number;
  isOpen: number;
  complete: number;
  sizeBytes: number;
  leftBytes: number;
  /** Bytes a second. */
  downRate: number;
  isHashChecking: number;
  peersConnected: number;
}

const FIELDS = [
  'd.hash=',
  'd.state=',
  'd.is_active=',
  'd.is_open=',
  'd.complete=',
  'd.size_bytes=',
  'd.left_bytes=',
  'd.down.rate=',
  'd.is_hash_checking=',
  'd.peers_connected=',
];

export const rtorrentDownload = (torrent: RtorrentTorrent): LiveDownload => {
  const size = Math.max(0, Number(torrent.sizeBytes) || 0);
  const sizeLeft = Math.max(0, Number(torrent.leftBytes) || 0);
  const base = { size, sizeLeft };
  const done = !!torrent.complete || (size > 0 && sizeLeft === 0);

  if (torrent.isHashChecking) {
    return done
      ? { ...base, stage: 'finishing', step: 'checking' }
      : { ...base, stage: 'queued', step: 'checking' };
  }
  if (done) {
    return { ...base, stage: 'importing' };
  }
  if (!torrent.state || !torrent.isOpen || !torrent.isActive) {
    return { ...base, stage: 'paused' };
  }
  if (!torrent.peersConnected) {
    return { ...base, stage: 'stalled', step: 'noPeers' };
  }
  const rate = Number(torrent.downRate) || 0;
  return {
    ...base,
    stage: 'downloading',
    secondsLeft: rate > 0 ? Math.round(sizeLeft / rate) : undefined,
  };
};

type XmlValue =
  | string
  | number
  | boolean
  | XmlValue[]
  | { [name: string]: XmlValue }
  | null;

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type XmlParam =
  | string
  | number
  | boolean
  | Buffer
  | XmlParam[]
  | { [name: string]: XmlParam };

const toValue = (param: XmlParam): string => {
  if (typeof param === 'string') return `<string>${escape(param)}</string>`;
  if (typeof param === 'boolean') return `<boolean>${param ? 1 : 0}</boolean>`;
  if (typeof param === 'number') {
    const whole = Math.trunc(param);
    return Math.abs(whole) < 2 ** 31
      ? `<i4>${whole}</i4>`
      : `<i8>${whole}</i8>`;
  }
  if (Buffer.isBuffer(param))
    return `<base64>${param.toString('base64')}</base64>`;
  if (Array.isArray(param)) {
    return `<array><data>${param
      .map((p) => `<value>${toValue(p)}</value>`)
      .join('')}</data></array>`;
  }
  return `<struct>${Object.entries(param)
    .map(
      ([name, value]) =>
        `<member><name>${escape(name)}</name><value>${toValue(value)}</value></member>`
    )
    .join('')}</struct>`;
};

/** An XML-RPC call. */
export const xmlRpcCall = (method: string, params: XmlParam[]): string =>
  `<?xml version="1.0"?><methodCall><methodName>${escape(method)}</methodName><params>${params
    .map((p) => `<param><value>${toValue(p)}</value></param>`)
    .join('')}</params></methodCall>`;

type Node = Record<string, unknown[]> | string;

/** One parsed <value>, as xml2js gives it (every child in an array). */
const fromValue = (value: Node): XmlValue => {
  if (typeof value === 'string') return value; // untyped means string
  const [type, inner] = Object.entries(value).find(([key]) => key !== '$') ?? [
    'string',
    [''],
  ];
  const first = (inner as unknown[])?.[0];
  switch (type) {
    case 'string':
      return typeof first === 'string' ? first : '';
    case 'i4':
    case 'i8':
    case 'int':
    case 'double':
      return Number(first);
    case 'boolean':
      return String(first) === '1';
    case 'array': {
      const data = (first as { data?: { value?: Node[] }[] } | undefined)
        ?.data?.[0];
      return (data?.value ?? []).map(fromValue);
    }
    case 'struct': {
      const members =
        (first as { member?: { name: string[]; value: Node[] }[] } | undefined)
          ?.member ?? [];
      return Object.fromEntries(
        members.map((m) => [String(m.name?.[0]), fromValue(m.value?.[0] ?? '')])
      );
    }
    default:
      return typeof first === 'string' ? first : null;
  }
};

/** The result of an XML-RPC answer, or the fault it reports. */
export const xmlRpcResult = async (xml: string): Promise<XmlValue> => {
  const doc = await parseStringPromise(xml);
  const response = doc?.methodResponse;
  if (!response) throw new Error('rTorrent: not an XML-RPC answer.');
  if (response.fault) {
    const members =
      response.fault[0]?.value?.[0]?.struct?.[0]?.member ??
      ([] as { name: string[]; value: Node[] }[]);
    const reason = members.find(
      (m: { name: string[] }) => m.name?.[0] === 'faultString'
    );
    throw new Error(
      `rTorrent: ${reason ? String(fromValue(reason.value[0])) : 'fault'}`
    );
  }
  return fromValue(response.params?.[0]?.param?.[0]?.value?.[0] ?? '');
};

/** What Backfill reads of each torrent, in the order the values come. */
const INFO_FIELDS = [
  'd.hash=',
  'd.name=',
  'd.state=',
  'd.is_open=',
  'd.is_active=',
  'd.complete=',
  'd.size_bytes=',
  'd.completed_bytes=',
  'd.down.rate=',
  'd.is_hash_checking=',
  'd.message=',
  'd.directory=',
  'd.is_multi_file=',
  'd.custom1=',
  'd.custom=seerr_added',
];

export interface RtorrentInfo {
  hash: string;
  name: string;
  state: number;
  isOpen: number;
  isActive: number;
  complete: number;
  sizeBytes: number;
  completedBytes: number;
  downRate: number;
  isHashChecking: number;
  message: string;
  /** A multi-file torrent's own folder; a single file's parent folder. */
  directory: string;
  isMultiFile: number;
  label: string;
  /** When Seerr added it, in seconds; empty for another's. */
  addedBySeerr: string;
}

const infoOf = (row: XmlValue[]): RtorrentInfo => {
  const [
    hash,
    name,
    state,
    isOpen,
    isActive,
    complete,
    sizeBytes,
    completedBytes,
    downRate,
    isHashChecking,
    message,
    directory,
    isMultiFile,
    label,
    addedBySeerr,
  ] = row;
  return {
    hash: String(hash ?? ''),
    name: String(name ?? ''),
    state: Number(state),
    isOpen: Number(isOpen),
    isActive: Number(isActive),
    complete: Number(complete),
    sizeBytes: Number(sizeBytes),
    completedBytes: Number(completedBytes),
    downRate: Number(downRate),
    isHashChecking: Number(isHashChecking),
    message: String(message ?? ''),
    directory: String(directory ?? ''),
    isMultiFile: Number(isMultiFile),
    label: decodeLabel(String(label ?? '')),
    addedBySeerr: String(addedBySeerr ?? ''),
  };
};

/** ruTorrent keeps labels URL-encoded. */
const decodeLabel = (label: string) => {
  try {
    return decodeURIComponent(label);
  } catch {
    return label;
  }
};

/** A magnet link's stand-in until its file list is in: "<HASH>.meta". */
const isMeta = (name: string) => /^[0-9a-f]{40}\.meta$/i.test(name);

const parentOf = (path: string) => path.replace(/\/+[^/]*\/*$/, '') || '/';
const lastPart = (path: string) =>
  path.replace(/\/+$/, '').split('/').pop() ?? '';

export const rtorrentTorrent = (info: RtorrentInfo): ClientTorrent => {
  const size = Math.max(0, info.sizeBytes || 0);
  const left = Math.max(0, size - (info.completedBytes || 0));
  const speed = Math.max(0, info.downRate || 0);
  const added = Number(info.addedBySeerr);
  const base = {
    hash: info.hash.toLowerCase(),
    name: info.name,
    progress: size ? (size - left) / size : 0,
    speed,
    secondsLeft: speed > 0 && left > 0 ? Math.round(left / speed) : undefined,
    // Files are named with a multi-file torrent's folder in front, so they
    // sit under the folder that holds it.
    savePath: info.isMultiFile ? parentOf(info.directory) : info.directory,
    addedAt: added > 0 ? added * 1000 : undefined,
  };
  if (isMeta(info.name)) return { ...base, state: 'metadata' };
  if (info.isHashChecking) return { ...base, state: 'checking' };
  if (info.complete) return { ...base, state: 'done' };
  // rTorrent closes a torrent it hits an error with, and says why.
  if (!info.state && info.message && !/tracker/i.test(info.message)) {
    return { ...base, state: 'error', error: info.message };
  }
  if (!info.state || !info.isOpen || !info.isActive) {
    return { ...base, state: 'paused' };
  }
  return { ...base, state: 'downloading' };
};

class RtorrentAPI implements TorrentClient {
  public readonly product = 'rTorrent';
  public readonly stopsAtMetadata = false;
  private axios: AxiosInstance;

  constructor(
    settings: Pick<
      DownloadClientSettings,
      'hostname' | 'port' | 'useSsl' | 'urlBase' | 'username' | 'password'
    >
  ) {
    this.axios = axios.create({
      baseURL: clientBaseUrl({
        ...settings,
        urlBase: settings.urlBase || 'RPC2',
      }),
      timeout: CLIENT_TIMEOUT_MS,
      headers: { 'Content-Type': 'text/xml' },
      responseType: 'text',
      auth: settings.username
        ? { username: settings.username, password: settings.password ?? '' }
        : undefined,
    });
  }

  private async call(method: string, params: XmlParam[] = []) {
    try {
      const { data } = await this.axios.post<string>(
        '',
        xmlRpcCall(method, params)
      );
      return await xmlRpcResult(String(data));
    } catch (e) {
      if (isAxiosError(e) && e.response?.status === 401) {
        throw new Error('rTorrent did not accept the username or password.');
      }
      throw e;
    }
  }

  /** Several calls in one; throws on the first that fails. */
  private async multicall(
    calls: { method: string; params: XmlParam[] }[]
  ): Promise<XmlValue[]> {
    if (!calls.length) return [];
    const answers = await this.call('system.multicall', [
      calls.map((c) => ({ methodName: c.method, params: c.params })),
    ]);
    return (Array.isArray(answers) ? answers : []).map((answer) => {
      if (Array.isArray(answer)) return answer[0];
      const fault = answer as { faultString?: XmlValue } | null;
      throw new Error(`rTorrent: ${String(fault?.faultString ?? 'fault')}`);
    });
  }

  private async torrents(): Promise<RtorrentInfo[]> {
    const rows = await this.call('d.multicall2', ['', 'main', ...INFO_FIELDS]);
    return (Array.isArray(rows) ? rows : [])
      .filter((row): row is XmlValue[] => Array.isArray(row))
      .map(infoOf);
  }

  private async info(hash: string): Promise<RtorrentInfo | undefined> {
    return (await this.torrents()).find(
      (t) => t.hash.toLowerCase() === hash.toLowerCase()
    );
  }

  public async addTorrent(options: {
    torrent?: Buffer;
    magnet?: string;
    category: string;
    metadataOnly?: boolean;
  }): Promise<void> {
    const commands = [
      `d.custom1.set=${encodeURIComponent(options.category)}`,
      `d.custom.set=seerr_added,${Math.floor(Date.now() / 1000)}`,
    ];
    if (options.torrent) {
      // Loaded stopped, so its files can be chosen first.
      await this.call('load.raw_verbose', ['', options.torrent, ...commands]);
    } else if (options.magnet) {
      // A stopped magnet never fetches its file list.
      await this.call('load.start_verbose', ['', options.magnet, ...commands]);
    } else {
      throw new Error('A torrent file or magnet link is needed.');
    }
  }

  /** A label needs no setting up. */
  public async ensureCategory(): Promise<void> {
    return;
  }

  public async findTorrent(hash: string): Promise<ClientTorrent | undefined> {
    const info = await this.info(hash);
    return info ? rtorrentTorrent(info) : undefined;
  }

  public async listCategory(category: string): Promise<ClientTorrent[]> {
    return (await this.torrents())
      .filter((t) => t.label === category)
      .map(rtorrentTorrent);
  }

  public async getFiles(hash: string): Promise<ClientTorrentFile[]> {
    const info = await this.info(hash);
    if (!info || isMeta(info.name)) return [];
    const rows = await this.call('f.multicall', [
      info.hash,
      '',
      'f.path=',
      'f.size_bytes=',
      'f.completed_chunks=',
      'f.size_chunks=',
    ]);
    const folder = info.isMultiFile ? `${lastPart(info.directory)}/` : '';
    return (Array.isArray(rows) ? rows : [])
      .filter((row): row is XmlValue[] => Array.isArray(row))
      .map(([path, size, completed, chunks], index) => ({
        index,
        name: `${folder}${String(path ?? '')}`,
        size: Number(size) || 0,
        progress: Number(chunks) ? Number(completed) / Number(chunks) : 1,
      }));
  }

  public async setFilePriority(
    hash: string,
    indexes: number[],
    priority: 0 | 1
  ): Promise<void> {
    if (!indexes.length) return;
    const target = hash.toUpperCase();
    await this.multicall([
      ...indexes.map((index) => ({
        method: 'f.priority.set',
        params: [`${target}:f${index}`, priority] as XmlParam[],
      })),
      { method: 'd.update_priorities', params: [target] },
    ]);
  }

  public async startTorrent(hash: string): Promise<void> {
    const target = hash.toUpperCase();
    await this.multicall([
      { method: 'd.open', params: [target] },
      { method: 'd.start', params: [target] },
    ]);
  }

  public async stopTorrent(hash: string): Promise<void> {
    const target = hash.toUpperCase();
    await this.multicall([
      { method: 'd.stop', params: [target] },
      { method: 'd.close', params: [target] },
    ]);
  }

  /**
   * Removes the torrent, then deletes its files one by one, and the folders
   * of a multi-file torrent that are left empty: never anything else.
   */
  public async deleteTorrent(hash: string): Promise<void> {
    const info = await this.info(hash);
    if (!info) return;
    const files = isMeta(info.name) ? [] : await this.getFiles(info.hash);
    await this.call('d.erase', [info.hash]);
    const base = info.isMultiFile ? parentOf(info.directory) : info.directory;
    const failed: string[] = [];
    for (const file of files) {
      await this.call('execute.throw', [
        '',
        'rm',
        '-f',
        '--',
        `${base}/${file.name}`,
      ]).catch((e) => failed.push((e as Error).message));
    }
    if (info.isMultiFile) {
      const folders = new Set<string>();
      for (const file of files) {
        let dir = parentOf(`${base}/${file.name}`);
        while (dir.length > base.length) {
          folders.add(dir);
          dir = parentOf(dir);
        }
      }
      // Deepest first; rmdir leaves a folder alone unless it is empty.
      for (const dir of [...folders].sort((a, b) => b.length - a.length)) {
        await this.call('execute.throw', ['', 'rmdir', '--', dir]).catch(
          () => undefined
        );
      }
    }
    if (failed.length) {
      throw new Error(
        `rTorrent removed the torrent but could not delete its files: ${failed[0]}`
      );
    }
  }

  public async backfillProblems(): Promise<string[]> {
    try {
      await this.call('execute.throw', ['', 'true']);
      return [];
    } catch {
      return [
        'rTorrent will not run commands (its execute command), so Backfill cannot delete what is left of a download it removes. ruTorrent\'s own "erase data" needs it too.',
      ];
    }
  }

  public async getVersion(): Promise<string> {
    return String((await this.call('system.client_version')) || 'unknown');
  }

  public async getDownloads(ids: string[]): Promise<Map<string, LiveDownload>> {
    const found = new Map<string, LiveDownload>();
    const mine = new Set(
      ids.filter(isTorrentHash).map((id) => id.toLowerCase())
    );
    if (!mine.size) {
      return found;
    }
    // rTorrent has no "these hashes only": the whole view is read, once.
    const rows = await this.call('d.multicall2', ['', 'main', ...FIELDS]);
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!Array.isArray(row)) continue;
      const [hash, ...rest] = row;
      const id = String(hash ?? '').toLowerCase();
      if (!mine.has(id)) continue;
      const [
        state,
        isActive,
        isOpen,
        complete,
        sizeBytes,
        leftBytes,
        downRate,
        isHashChecking,
        peersConnected,
      ] = rest.map(Number);
      found.set(
        id,
        rtorrentDownload({
          hash: id,
          state,
          isActive,
          isOpen,
          complete,
          sizeBytes,
          leftBytes,
          downRate,
          isHashChecking,
          peersConnected,
        })
      );
    }
    return found;
  }
}

export default RtorrentAPI;
