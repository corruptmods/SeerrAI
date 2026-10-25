import { clientBaseUrl } from '@server/api/downloadclients/types';
import type { ServarrHealthIssue } from '@server/api/servarr/base';
import type { AxiosInstance, AxiosResponse } from 'axios';
import axios from 'axios';

/*
 * The part of Prowlarr's API Backfill uses: one search across every indexer
 * Prowlarr has, and fetching a result's .torrent or .nzb through Prowlarr.
 * Searching Prowlarr directly, rather than through Sonarr, is the point: a
 * pack whose name Sonarr can't parse never reaches Sonarr's results at all,
 * so Backfill has to see it here and judge it by the files inside.
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

/** TV, and anime, in Prowlarr's Newznab categories. */
export const TV_CATEGORIES = [5000, 5070];
/** Movies, and anime, which anime trackers file under TV/Anime. */
export const MOVIE_CATEGORIES = [2000, 5070];
/** Music: albums, in any format. */
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

  /** What Prowlarr says is wrong on its own health page. */
  public async getHealth(): Promise<ServarrHealthIssue[]> {
    const { data } = await this.axios.get<ServarrHealthIssue[]>('/health');
    return data ?? [];
  }

  /**
   * Indexers that are failing: Prowlarr stops asking one for a while after
   * it fails, and says until when.
   */
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

  public async search(
    query: string,
    options: { categories?: number[]; limit?: number } = {}
  ): Promise<ProwlarrRelease[]> {
    const params = new URLSearchParams({
      query,
      type: 'search',
      limit: String(options.limit ?? 100),
    });
    for (const category of options.categories ?? TV_CATEGORIES) {
      params.append('categories', String(category));
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
   * A result's .torrent or .nzb, fetched through Prowlarr. Many torrent
   * indexers only have a magnet link, which comes back as one: its files
   * can only be learned from the swarm.
   */
  public async fetchRelease(release: ProwlarrRelease): Promise<FetchedRelease> {
    let url = release.downloadUrl ?? release.magnetUrl;
    if (!url) {
      // No link at all: the guid is often the magnet, or the hash makes one.
      if (release.guid?.startsWith('magnet:')) {
        return { kind: 'magnet', uri: release.guid };
      }
      if (release.infoHash) {
        return {
          kind: 'magnet',
          uri: `magnet:?xt=urn:btih:${release.infoHash}&dn=${encodeURIComponent(release.title)}`,
        };
      }
      throw new Error('The result has no download link.');
    }
    // Prowlarr hands most magnets over as its own link, which redirects to
    // the magnet itself; a bare magnet needs no fetching.
    if (url.startsWith('magnet:')) {
      return { kind: 'magnet', uri: url };
    }
    const own = new URL(clientBaseUrl(this.settings)).origin;
    for (let hop = 0; hop < 4; hop++) {
      const target = new URL(url);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('The download link is not a web address.');
      }
      // The key only goes to Prowlarr, never to an indexer it redirects to.
      const response: AxiosResponse<ArrayBuffer> = await axios.get<ArrayBuffer>(
        url,
        {
          responseType: 'arraybuffer',
          maxRedirects: 0,
          timeout: FETCH_TIMEOUT_MS,
          maxContentLength: MAX_FILE_BYTES,
          headers:
            target.origin === own ? { 'X-Api-Key': this.settings.apiKey } : {},
          validateStatus: (status) => status >= 200 && status < 400,
        }
      );
      if (response.status >= 300) {
        const location: string = String(response.headers.location ?? '');
        if (location.startsWith('magnet:')) {
          return { kind: 'magnet', uri: location };
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
}

/** What a downloaded file is, by its content rather than its headers. */
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
