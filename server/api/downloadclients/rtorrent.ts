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
import { parseStringPromise } from 'xml2js';

/*
 * The part of rTorrent's XML-RPC Seerr reads: every torrent in its main
 * view, of which the ones Radarr and Sonarr sent are kept, by hash, which is
 * how they record a torrent as its download id. rTorrent is reached through
 * whatever web server exposes its XML-RPC (ruTorrent's, usually at "RPC2"),
 * with that server's basic auth when it has one.
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

type XmlValue = string | number | boolean | XmlValue[] | null;

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An XML-RPC call with string parameters, which is all Seerr sends. */
export const xmlRpcCall = (method: string, params: string[]): string =>
  `<?xml version="1.0"?><methodCall><methodName>${escape(method)}</methodName><params>${params
    .map((p) => `<param><value><string>${escape(p)}</string></value></param>`)
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

class RtorrentAPI implements DownloadClient {
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

  private async call(method: string, params: string[] = []) {
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
