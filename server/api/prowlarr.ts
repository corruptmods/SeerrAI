import { clientBaseUrl } from '@server/api/downloadclients/types';
import type { ServarrHealthIssue } from '@server/api/servarr/base';
import { infoHashHex, magnetHash } from '@server/lib/backfill/bencode';
import {
  LocalAddressRefused,
  assertPublicUrl,
  publicLookup,
} from '@server/utils/publicHost';
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import axios from 'axios';
import { createHash, timingSafeEqual } from 'node:crypto';

/*
 * Backfill searches every Prowlarr indexer and fetches a result's .torrent or
 * .nzb through Prowlarr. It searches Prowlarr directly, not via Sonarr: a
 * pack whose name Sonarr can't parse never reaches Sonarr's results, so
 * Backfill judges it here by the files inside. Releases from Sonarr's,
 * Radarr's or Lidarr's search are fetched the same way, with or without
 * Prowlarr set up.
 */

export interface ProwlarrSettings {
  hostname: string;
  port: number;
  useSsl: boolean;
  urlBase: string;
  apiKey: string;
}

export interface ProwlarrRelease {
  guid: string;
  title: string;
  size: number;
  indexerId: number;
  indexer: string;
  protocol: 'torrent' | 'usenet';
  seeders?: number;
  leechers?: number;
  downloadUrl?: string;
  magnetUrl?: string;
  infoHash?: string;
  publishDate?: string;
  categories?: { id: number }[];
}

export type FetchedRelease =
  | { kind: 'torrent'; data: Buffer }
  | { kind: 'magnet'; uri: string }
  | { kind: 'nzb'; data: Buffer };

/** TV and anime Newznab categories. */
export const TV_CATEGORIES = [5000, 5070];
/** Movies, plus anime: anime trackers file films under TV/Anime. */
export const MOVIE_CATEGORIES = [2000, 5070];
/** Music albums, any format. */
export const AUDIO_CATEGORIES = [3000];

/** A search fans out to every indexer; slow ones take most of a minute. */
const SEARCH_TIMEOUT_MS = 90_000;
const FETCH_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;
/** No real .torrent or .nzb for a TV pack comes near this. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

class ProwlarrAPI {
  private axios: AxiosInstance;

  constructor(private settings: ProwlarrSettings) {
    this.axios = axios.create({
      baseURL: `${clientBaseUrl(settings)}/api/v1`,
      headers: { 'X-Api-Key': settings.apiKey, Accept: 'application/json' },
      timeout: STATUS_TIMEOUT_MS,
    });
  }

  public async getVersion(): Promise<string> {
    const { data } = await this.axios.get<{ version?: string }>(
      '/system/status'
    );
    return data?.version ?? 'unknown';
  }

  /** Issues from Prowlarr's health page. */
  public async getHealth(): Promise<ServarrHealthIssue[]> {
    const { data } = await this.axios.get<ServarrHealthIssue[]>('/health');
    return data ?? [];
  }

  /** Failing indexers, which Prowlarr disables until the given time. */
  public async getFailingIndexers(): Promise<
    { name: string; disabledTill?: string; failedAt?: string }[]
  > {
    const [{ data: indexers }, { data: statuses }] = await Promise.all([
      this.axios.get<{ id: number; name: string; enable: boolean }[]>(
        '/indexer'
      ),
      this.axios.get<
        {
          indexerId: number;
          disabledTill?: string;
          mostRecentFailure?: string;
        }[]
      >('/indexerstatus'),
    ]);
    const byId = new Map(
      (Array.isArray(indexers) ? indexers : []).map((i) => [i.id, i])
    );
    return (Array.isArray(statuses) ? statuses : [])
      .filter((status) => byId.get(status.indexerId)?.enable !== false)
      .map((status) => ({
        name: byId.get(status.indexerId)?.name ?? `Indexer ${status.indexerId}`,
        disabledTill: status.disabledTill,
        failedAt: status.mostRecentFailure,
      }));
  }

  /**
   * Indexers to search for music: enabled, with a music category, and not
   * disabled after failures (Prowlarr refuses those, and a search waits on
   * every indexer).
   */
  public async musicIndexerIds(now = Date.now()): Promise<number[]> {
    const [{ data: indexers }, { data: statuses }] = await Promise.all([
      this.axios.get<
        {
          id: number;
          enable?: boolean;
          capabilities?: {
            categories?: { id: number; subCategories?: { id: number }[] }[];
          };
        }[]
      >('/indexer'),
      this.axios.get<{ indexerId: number; disabledTill?: string }[]>(
        '/indexerstatus'
      ),
    ]);
    const resting = new Set(
      (Array.isArray(statuses) ? statuses : [])
        .filter(
          (status) =>
            !!status.disabledTill && Date.parse(status.disabledTill) > now
        )
        .map((status) => status.indexerId)
    );
    const music = (id: number) => id >= 3000 && id < 4000;
    return (Array.isArray(indexers) ? indexers : [])
      .filter(
        (indexer) =>
          indexer.enable !== false &&
          !resting.has(indexer.id) &&
          (indexer.capabilities?.categories ?? []).some(
            (category) =>
              music(category.id) ||
              (category.subCategories ?? []).some((sub) => music(sub.id))
          )
      )
      .map((indexer) => indexer.id);
  }

  public async search(
    query: string,
    options: {
      categories?: number[];
      limit?: number;
      /** Only these indexers; all when omitted. */
      indexerIds?: number[];
    } = {}
  ): Promise<ProwlarrRelease[]> {
    const params = new URLSearchParams({
      query,
      type: 'search',
      limit: String(options.limit ?? 100),
    });
    for (const category of options.categories ?? TV_CATEGORIES) {
      params.append('categories', String(category));
    }
    for (const id of options.indexerIds ?? []) {
      params.append('indexerIds', String(id));
    }
    const { data } = await this.axios.get<ProwlarrRelease[]>('/search', {
      params,
      timeout: SEARCH_TIMEOUT_MS,
    });
    return (Array.isArray(data) ? data : []).filter(
      (release) =>
        release &&
        typeof release.title === 'string' &&
        (release.protocol === 'torrent' || release.protocol === 'usenet')
    );
  }

  /**
   * Fetches a result's .torrent or .nzb through Prowlarr. Many torrent
   * indexers only have a magnet, returned as such: its files come only from
   * the swarm.
   */
  public async fetchRelease(
    release: ProwlarrRelease,
    {
      indexerOrigins,
    }: {
      /**
       * Indexers Sonarr, Radarr or Lidarr have set up, by `originKey`; read
       * only for a link to a local address.
       */
      indexerOrigins?: () => Promise<ReadonlySet<string>>;
    } = {}
  ): Promise<FetchedRelease> {
    let url = release.downloadUrl ?? release.magnetUrl;
    if (!url) {
      // No link: the guid is often the magnet, or the hash makes one.
      if (release.guid?.startsWith('magnet:')) {
        return magnetOf(release.guid);
      }
      const hash = release.infoHash && infoHashHex(release.infoHash);
      if (hash) {
        return {
          kind: 'magnet',
          uri: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(release.title)}`,
        };
      }
      throw new Error('The result has no download link.');
    }
    // Prowlarr usually serves magnets as its own link that redirects to the
    // magnet; a bare magnet needs no fetching.
    if (url.startsWith('magnet:')) {
      return magnetOf(url);
    }
    // Without Prowlarr set up (Backfill searching the *arrs only), no link
    // is Prowlarr's and no key is sent.
    const own = this.settings.hostname
      ? new URL(clientBaseUrl(this.settings)).origin
      : null;
    // Send the API key only to Prowlarr, never to an indexer it redirects to
    // nor back to Prowlarr from one: an indexer must not pick what is asked
    // of Prowlarr with the key.
    let keyed = own !== null;
    for (let hop = 0; hop < 4; hop++) {
      const target = new URL(url);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('The download link is not a web address.');
      }
      keyed &&= target.origin === own;
      // Prowlarr, and indexers the *arr apps have set up, are often on this
      // network; anything else must be public.
      const link = url;
      const get = (known: boolean) => {
        if (!known) assertPublicUrl(target);
        return axios.get<ArrayBuffer>(link, {
          responseType: 'arraybuffer',
          maxRedirects: 0,
          timeout: FETCH_TIMEOUT_MS,
          maxContentLength: MAX_FILE_BYTES,
          headers: keyed ? { 'X-Api-Key': this.settings.apiKey } : {},
          validateStatus: (status) => status >= 200 && status < 400,
          ...(known
            ? {}
            : { lookup: publicLookup as AxiosRequestConfig['lookup'] }),
        });
      };
      let response: AxiosResponse<ArrayBuffer>;
      try {
        response = await get(this.isProwlarr(target));
      } catch (e) {
        if (
          !isUnusableLink(e) ||
          !indexerOrigins ||
          !(await indexerOrigins()).has(originKey(target))
        ) {
          throw e;
        }
        response = await get(true);
      }
      if (response.status >= 300) {
        const location: string = String(response.headers.location ?? '');
        if (location.startsWith('magnet:')) {
          return magnetOf(location);
        }
        if (!location) {
          throw new Error('The indexer redirected nowhere.');
        }
        url = new URL(location, url).toString();
        continue;
      }
      const data = Buffer.from(response.data);
      return { kind: detectKind(data, release.protocol), data } as
        | { kind: 'torrent'; data: Buffer }
        | { kind: 'nzb'; data: Buffer };
    }
    throw new Error('The indexer redirected too many times.');
  }

  /**
   * Whether a link is Prowlarr's: its own address, or its download path as
   * Sonarr, Radarr or Lidarr know it by another name, either on its port or,
   * through a proxy, on another port carrying its API key.
   */
  private isProwlarr(target: URL): boolean {
    if (!this.settings.hostname) return false;
    const own = new URL(clientBaseUrl(this.settings));
    if (originKey(target) === originKey(own)) return true;
    if (!/\/\d+\/download$/.test(target.pathname)) return false;
    const base = own.pathname.replace(/\/+$/, '');
    if (
      portOf(target) === portOf(own) &&
      target.pathname.startsWith(`${base}/`) &&
      /^\/\d+\/download$/.test(target.pathname.slice(base.length))
    ) {
      return true;
    }
    const key = target.searchParams.get('apikey');
    return (
      !!key && !!this.settings.apiKey && sameSecret(key, this.settings.apiKey)
    );
  }
}

const portOf = (url: URL): string =>
  url.port || (url.protocol === 'https:' ? '443' : '80');

/** A host and port, the default port written out. */
export const originKey = (url: URL): string =>
  `${url.hostname.toLowerCase()}:${portOf(url)}`;

const sameSecret = (a: string, b: string): boolean => {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
};

/** A magnet link that can't be added: it doesn't name one valid hash. */
export class UnusableMagnet extends Error {
  constructor() {
    super('The magnet link has no single valid info hash.');
  }
}

/**
 * Whether a release's own link can't be used: it leads to a local address
 * that isn't Prowlarr or a known indexer, or is a magnet without one hash.
 */
export const isUnusableLink = (e: unknown): boolean => {
  let at: unknown = e;
  for (let depth = 0; at && depth < 5; depth++) {
    if (at instanceof LocalAddressRefused || at instanceof UnusableMagnet) {
      return true;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return false;
};

/** A magnet link as given, once it names a single valid info hash. */
const magnetOf = (uri: string): FetchedRelease => {
  if (!magnetHash(uri)) {
    throw new UnusableMagnet();
  }
  return { kind: 'magnet', uri };
};

/** Detects a downloaded file's kind from its content, not its headers. */
export const detectKind = (
  data: Buffer,
  protocol: ProwlarrRelease['protocol']
): 'torrent' | 'nzb' => {
  const head = data.subarray(0, 512).toString('latin1').trimStart();
  if (head.startsWith('d') && data.includes('4:info')) {
    return 'torrent';
  }
  if (/<nzb[\s>]/i.test(data.subarray(0, 4096).toString('latin1'))) {
    return 'nzb';
  }
  throw new Error(
    protocol === 'usenet'
      ? 'The indexer did not send an NZB.'
      : 'The indexer did not send a torrent file.'
  );
};

export default ProwlarrAPI;
