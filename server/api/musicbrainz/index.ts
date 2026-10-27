import ExternalAPI from '@server/api/externalapi';
import { PROJECT_NAME, PROJECT_URL } from '@server/constants/project';
import { getRepository } from '@server/datasource';
import MusicMetadata from '@server/entity/MusicMetadata';
import type { CacheStore } from '@server/lib/cache';
import cacheManager from '@server/lib/cache';
import { MUSICBRAINZ_URL, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getAppVersion } from '@server/utils/appVersion';
import { Like } from 'typeorm';
import type {
  MbArtist,
  MbArtistSearchResponse,
  MbMedium,
  MbRecording,
  MbRecordingSearchResponse,
  MbRelease,
  MbReleaseGroup,
  MbReleaseGroupBrowseResponse,
  MbReleaseGroupSearchResponse,
  MbReleaseSummary,
  MbWikipediaExtractResponse,
} from './interfaces';
import type { MbPriority, StillWanted } from './queue';
import {
  MusicBrainzBusyError,
  MusicBrainzUnwantedError,
  RequestQueue,
} from './queue';

export { MusicBrainzBusyError, MusicBrainzUnwantedError };
export type { MbPriority };

/*
 * MusicBrainz: artists, albums (release groups) and track lists.
 *
 * Every request goes through one queue shared by the whole server (see
 * ./queue), and what comes back is kept twice: in memory, and in the
 * database (MusicMetadata) so a restart does not have to ask again. Kept
 * answers past their time are still served while a fresh copy is fetched
 * in the background.
 *
 * Use musicBrainz() rather than making a client: the limit is per server,
 * not per client.
 */

const LABEL = 'MusicBrainz';

const DAY = 24 * 60 * 60 * 1000;

/** How long each kind of answer is kept before it is asked for again. */
export const MB_LIFETIMES = {
  artist: 7 * DAY,
  releaseGroup: 30 * DAY,
  releaseGroupList: 7 * DAY,
  /** Which album a release belongs to never changes. */
  releaseGroupOfRelease: null,
  tracks: 30 * DAY,
  recording: 30 * DAY,
  wikipedia: 30 * DAY,
} as const;

/** Searches are kept in memory only, for an hour. */
const SEARCH_TTL_SECONDS = 3600;

/** Kept answers stay in memory this long; the database keeps them longer. */
const MEMORY_TTL_SECONDS = 6 * 3600;

/** Requests to the public MusicBrainz start at least this far apart. */
export const MB_SPACING_MS = 1100;

/** A person is told MusicBrainz is busy rather than wait longer than this. */
export const MB_MAX_WAIT_MS = 8000;

const TIMEOUT_MS = 15_000;

/** The most release groups MusicBrainz gives in one page. */
export const MB_PAGE_SIZE = 100;

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A MusicBrainz id: a lower-case UUID. */
export const isMbid = (value: unknown): value is string =>
  typeof value === 'string' && MBID.test(value);

const requireMbid = (value: string): string => {
  if (!isMbid(value)) {
    throw new Error(`Not a MusicBrainz id: ${value}`);
  }
  return value;
};

/**
 * What someone typed, as words to look for: MusicBrainz reads its search
 * as Lucene, where `AC/DC`, `!!!` or `Sunn O)))` are syntax (and an
 * unbalanced bracket fails the search), and AND, OR and NOT are operators
 * ("Simon AND Garfunkel"). Each of those is matched as text instead.
 */
export const searchText = (typed: string): string =>
  typed
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&')
    .replace(/\b(AND|OR|NOT)\b/g, (word) => word.toLowerCase());

const trimSlashes = (url: string): string => url.trim().replace(/\/+$/, '');

/** The public MusicBrainz, which allows a request a second. */
export const isPublicMusicBrainz = (baseUrl: string): boolean => {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'musicbrainz.org' || host.endsWith('.musicbrainz.org');
  } catch {
    return true;
  }
};

/**
 * How Seerr names itself to MusicBrainz, as it asks: an application name,
 * version and a way to reach whoever runs it. Every install sends the same
 * name, so an admin's own address keeps one busy server from slowing the
 * others down.
 */
export const musicBrainzUserAgent = (contactEmail?: string): string => {
  const contact = [PROJECT_URL, contactEmail?.trim()]
    .filter(Boolean)
    .join('; ');
  return `${PROJECT_NAME.replace(/\s+/g, '')}/${getAppVersion()} ( ${contact} )`;
};

/** The shared line: spaced for the public server, not for a mirror. */
const queue = new RequestQueue({
  spacingMs: () =>
    isPublicMusicBrainz(getSettings().music.musicbrainzUrl || MUSICBRAINZ_URL)
      ? MB_SPACING_MS
      : 0,
  maxWaitMs: MB_MAX_WAIT_MS,
});

/** The queue itself, for Health and for tests. */
export const musicBrainzQueue = queue;

/** Answers being worked out, by cache key, shared by everyone asking. */
const inFlight = new Map<string, Promise<unknown>>();

interface Kept<T> {
  data: T;
  /** Epoch ms; null is kept for good. */
  expiresAt: number | null;
}

const isStale = (kept: Kept<unknown>, now = Date.now()): boolean =>
  kept.expiresAt !== null && kept.expiresAt <= now;

/** The release a track list is read from: official first, then earliest. */
const representative = (
  releases: MbReleaseSummary[]
): MbReleaseSummary | undefined =>
  [...releases].sort((a, b) => {
    const official =
      Number(b.status === 'Official') - Number(a.status === 'Official');
    if (official) {
      return official;
    }
    // A release without a date goes after every dated one.
    return (a.date || '9999').localeCompare(b.date || '9999');
  })[0];

/** Text from the Wikipedia extract's HTML: tags out, entities decoded. */
export const plainText = (html: string): string =>
  html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();

export class MusicBrainz extends ExternalAPI {
  private memory: CacheStore;
  private base: string;

  constructor({
    baseUrl = MUSICBRAINZ_URL,
    contactEmail,
  }: { baseUrl?: string; contactEmail?: string } = {}) {
    const base = trimSlashes(baseUrl || MUSICBRAINZ_URL);
    super(
      base,
      {},
      {
        headers: { 'User-Agent': musicBrainzUserAgent(contactEmail) },
        timeout: TIMEOUT_MS,
      }
    );
    this.base = base;
    this.memory = cacheManager.getCache('musicbrainz').data;
  }

  /**
   * One GET through the shared queue. Each queued job is a single request:
   * work made of several (a track list) queues each in turn, so nothing
   * queued ever waits on the queue itself.
   */
  private request<T>(
    priority: MbPriority,
    path: string,
    params: Record<string, string | number> = {},
    wanted?: StillWanted
  ): Promise<T> {
    const query = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    );
    return queue.add(
      `${this.base}${path}?${query}`,
      priority,
      async () => {
        const response = await this.axios.get<T>(path, {
          params: { ...params, fmt: 'json' },
        });
        return response.data;
      },
      wanted
    );
  }

  /** The same work asked for again while under way is shared. */
  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const promise = work().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  private async readStored<T>(key: string): Promise<Kept<T> | undefined> {
    try {
      const row = await getRepository(MusicMetadata).findOne({
        where: { key },
      });
      return row
        ? {
            data: JSON.parse(row.data) as T,
            expiresAt: row.expiresAt ? new Date(row.expiresAt).getTime() : null,
          }
        : undefined;
    } catch (e) {
      logger.debug('Could not read a kept MusicBrainz answer', {
        label: LABEL,
        key,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }
  }

  private async keep<T>(
    key: string,
    data: T,
    lifetime: number | null
  ): Promise<void> {
    const now = Date.now();
    const kept: Kept<T> = {
      data,
      expiresAt: lifetime === null ? null : now + lifetime,
    };
    this.memory.set(key, kept, MEMORY_TTL_SECONDS);
    try {
      await getRepository(MusicMetadata).upsert(
        {
          key,
          data: JSON.stringify(data),
          fetchedAt: new Date(now),
          expiresAt: kept.expiresAt === null ? null : new Date(kept.expiresAt),
        },
        ['key']
      );
    } catch (e) {
      // Still kept in memory; the database copy comes next time.
      logger.warn('Could not keep a MusicBrainz answer', {
        label: LABEL,
        key,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * An answer from memory, else the database, else MusicBrainz. One past its
   * time is still answered with, and fetched again behind the scenes.
   */
  private async cached<T>(
    key: string,
    lifetime: number | null,
    priority: MbPriority,
    fetch: (priority: MbPriority) => Promise<T>
  ): Promise<T> {
    const inMemory = this.memory.get<Kept<T>>(key);
    if (inMemory && !isStale(inMemory)) {
      return inMemory.data;
    }

    const kept = inMemory ?? (await this.readStored<T>(key));
    if (kept) {
      if (!inMemory) {
        this.memory.set(key, kept, MEMORY_TTL_SECONDS);
      }
      if (isStale(kept)) {
        this.once(`refresh:${key}`, async () =>
          this.keep(key, await fetch('background'), lifetime)
        ).catch((e) =>
          logger.debug('Could not refresh a MusicBrainz answer', {
            label: LABEL,
            key,
            errorMessage: e instanceof Error ? e.message : String(e),
          })
        );
      }
      return kept.data;
    }

    return this.once(key, async () => {
      const data = await fetch(priority);
      await this.keep(key, data, lifetime);
      return data;
    });
  }

  private async searched<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    const inMemory = this.memory.get<T>(key);
    if (inMemory) {
      return inMemory;
    }
    const data = await fetch();
    this.memory.set(key, data, SEARCH_TTL_SECONDS);
    return data;
  }

  /**
   * Searches take `wanted`: asked before each request starts, and a search
   * no one wants any more (typed past) is dropped while it waits.
   */
  public searchArtists(
    query: string,
    {
      limit = 8,
      offset = 0,
      wanted,
    }: { limit?: number; offset?: number; wanted?: StillWanted } = {},
    priority: MbPriority = 'interactive'
  ): Promise<MbArtistSearchResponse> {
    const key = `search-artist:${limit}:${offset}:${query.trim().toLowerCase()}`;
    return this.searched(key, () =>
      this.request<MbArtistSearchResponse>(
        priority,
        '/ws/2/artist',
        { query: searchText(query), limit, offset },
        wanted
      )
    );
  }

  public searchReleaseGroups(
    query: string,
    {
      limit = 12,
      offset = 0,
      wanted,
    }: { limit?: number; offset?: number; wanted?: StillWanted } = {},
    priority: MbPriority = 'interactive'
  ): Promise<MbReleaseGroupSearchResponse> {
    const key = `search-rg:${limit}:${offset}:${query.trim().toLowerCase()}`;
    return this.searched(key, () =>
      this.request<MbReleaseGroupSearchResponse>(
        priority,
        '/ws/2/release-group',
        { query: searchText(query), limit, offset },
        wanted
      )
    );
  }

  /**
   * Albums (release groups) by one of these artists whose title holds this
   * one, as a phrase: a chart's album found among its artist's.
   */
  public searchReleaseGroupsBy(
    title: string,
    artistIds: string[],
    { limit = 25 }: { limit?: number } = {},
    priority: MbPriority = 'background'
  ): Promise<MbReleaseGroupSearchResponse> {
    const artists = [...new Set(artistIds.map(requireMbid))].sort();
    const phrase = title.trim().replace(/["\\]/g, '\\$&');
    const key = `search-rg-by:${limit}:${artists.join(',')}:${title.trim().toLowerCase()}`;
    return this.searched(key, () =>
      this.request<MbReleaseGroupSearchResponse>(
        priority,
        '/ws/2/release-group',
        {
          query: `releasegroup:"${phrase}" AND (${artists
            .map((id) => `arid:${id}`)
            .join(' OR ')})`,
          limit,
        }
      )
    );
  }

  /**
   * Recordings whose title holds what was typed, as a phrase, by any of
   * these artists. MusicBrainz scores every exact title the same, and a
   * well-known song has hundreds of covers, so a search by title alone
   * rarely reaches the original: the artists narrow it to the ones meant.
   */
  public searchRecordings(
    query: string,
    artistIds: string[],
    { limit = 100, wanted }: { limit?: number; wanted?: StillWanted } = {},
    priority: MbPriority = 'interactive'
  ): Promise<MbRecordingSearchResponse> {
    const artists = [...new Set(artistIds.map(requireMbid))].sort();
    const phrase = query.trim().replace(/["\\]/g, '\\$&');
    const key = `search-rec:${limit}:${artists.join(',')}:${query.trim().toLowerCase()}`;
    return this.searched(key, () =>
      this.request<MbRecordingSearchResponse>(
        priority,
        '/ws/2/recording',
        {
          query: `recording:"${phrase}" AND (${artists
            .map((id) => `arid:${id}`)
            .join(' OR ')})`,
          limit,
        },
        wanted
      )
    );
  }

  /**
   * A recording as kept from an earlier lookup, without asking MusicBrainz:
   * undefined when none is kept (or it is past its time).
   */
  public async keptRecording(
    id: string
  ): Promise<MbRecording | null | undefined> {
    requireMbid(id);
    const key = `recording:${id}`;
    const kept =
      this.memory.get<Kept<{ recording: MbRecording | null }>>(key) ??
      (await this.readStored<{ recording: MbRecording | null }>(key));
    return kept && !isStale(kept) ? kept.data.recording : undefined;
  }

  /**
   * One recording, with every release it is on and their albums. Asked as
   * a search by id: a lookup lists only the first 25 releases, and a hit
   * song is on far more.
   */
  public async getRecording(
    id: string,
    priority: MbPriority = 'interactive'
  ): Promise<MbRecording | null> {
    requireMbid(id);
    const found = await this.cached<{ recording: MbRecording | null }>(
      `recording:${id}`,
      MB_LIFETIMES.recording,
      priority,
      async (p) => {
        const data = await this.request<MbRecordingSearchResponse>(
          p,
          '/ws/2/recording',
          { query: `rid:${id}`, limit: 1 }
        );
        return {
          recording:
            (data.recordings ?? []).find((recording) => recording.id === id) ??
            null,
        };
      }
    );
    return found.recording;
  }

  public async getArtist(
    id: string,
    priority: MbPriority = 'interactive'
  ): Promise<MbArtist> {
    const path = `/ws/2/artist/${requireMbid(id)}`;
    return this.cached(`artist:${id}`, MB_LIFETIMES.artist, priority, (p) =>
      this.request<MbArtist>(p, path, { inc: 'url-rels+genres+aliases' })
    );
  }

  /**
   * One page (of MB_PAGE_SIZE) of an artist's albums of the given kinds,
   * e.g. ['album', 'ep']; every kind when none are given.
   */
  public async getArtistReleaseGroups(
    artistId: string,
    { types = [], page = 0 }: { types?: string[]; page?: number } = {},
    priority: MbPriority = 'interactive'
  ): Promise<MbReleaseGroupBrowseResponse> {
    requireMbid(artistId);
    const kinds = types.map((t) => t.toLowerCase()).sort();
    const key = `rg-list:${artistId}:${kinds.join('|') || 'all'}:${page}`;
    return this.cached(key, MB_LIFETIMES.releaseGroupList, priority, (p) =>
      this.request<MbReleaseGroupBrowseResponse>(p, '/ws/2/release-group', {
        artist: artistId,
        ...(kinds.length ? { type: kinds.join('|') } : {}),
        limit: MB_PAGE_SIZE,
        offset: page * MB_PAGE_SIZE,
      })
    );
  }

  /**
   * The artist's albums MusicBrainz has already been asked for (any page,
   * any kinds), without asking again: for an artist picture to fall back
   * on, where a request in the queue would be one too many.
   */
  public async keptArtistReleaseGroups(
    artistId: string
  ): Promise<MbReleaseGroup[]> {
    requireMbid(artistId);
    try {
      const rows = await getRepository(MusicMetadata).find({
        where: { key: Like(`rg-list:${artistId}:%`) },
      });
      const seen = new Set<string>();
      return rows.flatMap((row) =>
        (
          (JSON.parse(row.data) as MbReleaseGroupBrowseResponse)[
            'release-groups'
          ] ?? []
        ).filter((group) => !seen.has(group.id) && !!seen.add(group.id))
      );
    } catch {
      return [];
    }
  }

  public async getReleaseGroup(
    id: string,
    priority: MbPriority = 'interactive'
  ): Promise<MbReleaseGroup> {
    const path = `/ws/2/release-group/${requireMbid(id)}`;
    return this.cached(`rg:${id}`, MB_LIFETIMES.releaseGroup, priority, (p) =>
      this.request<MbReleaseGroup>(p, path, {
        inc: 'artist-credits+releases+genres',
      })
    );
  }

  /**
   * The album a release belongs to. Media servers often know a release
   * (one pressing) rather than the album; this never changes, so it is
   * kept for good. Background by default: scans are what ask.
   */
  public async getReleaseGroupOfRelease(
    releaseId: string,
    priority: MbPriority = 'background'
  ): Promise<string | null> {
    const path = `/ws/2/release/${requireMbid(releaseId)}`;
    const found = await this.cached<{ releaseGroupId: string | null }>(
      `release-rg:${releaseId}`,
      MB_LIFETIMES.releaseGroupOfRelease,
      priority,
      async (p) => {
        const release = await this.request<MbRelease>(p, path, {
          inc: 'release-groups',
        });
        return { releaseGroupId: release['release-group']?.id ?? null };
      }
    );
    return found.releaseGroupId;
  }

  /**
   * An album's track list, from one of its releases: an official one,
   * the earliest.
   */
  public async getTracks(
    releaseGroupId: string,
    priority: MbPriority = 'interactive'
  ): Promise<MbMedium[]> {
    requireMbid(releaseGroupId);
    return this.cached(
      `tracks:${releaseGroupId}`,
      MB_LIFETIMES.tracks,
      priority,
      async (p) => {
        const group = await this.getReleaseGroup(releaseGroupId, p);
        const release = representative(group.releases ?? []);
        if (!release || !isMbid(release.id)) {
          return [];
        }
        const full = await this.request<MbRelease>(
          p,
          `/ws/2/release/${release.id}`,
          { inc: 'recordings' }
        );
        return full.media ?? [];
      }
    );
  }

  /**
   * The start of an artist's Wikipedia article, as plain text, or null when
   * there is none. From the MusicBrainz website, which a mirror may not
   * serve.
   */
  public async getWikipediaExtract(
    artistId: string,
    priority: MbPriority = 'interactive'
  ): Promise<string | null> {
    const path = `/artist/${requireMbid(artistId)}/wikipedia-extract`;
    const found = await this.cached<{ text: string | null }>(
      `wikipedia:${artistId}`,
      MB_LIFETIMES.wikipedia,
      priority,
      async (p) => {
        const data = await this.request<MbWikipediaExtractResponse>(p, path);
        const html = data?.wikipediaExtract?.content;
        return { text: html ? plainText(html) || null : null };
      }
    );
    return found.text;
  }
}

let shared: { client: MusicBrainz; settings: string } | undefined;

/** The server's MusicBrainz client, following Settings → Music. */
export const musicBrainz = (): MusicBrainz => {
  const { musicbrainzUrl, contactEmail } = getSettings().music;
  const settings = JSON.stringify([musicbrainzUrl, contactEmail]);
  if (!shared || shared.settings !== settings) {
    shared = {
      client: new MusicBrainz({ baseUrl: musicbrainzUrl, contactEmail }),
      settings,
    };
  }
  return shared.client;
};

export default MusicBrainz;
