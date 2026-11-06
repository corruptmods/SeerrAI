import { LRUCache } from 'lru-cache';

export type AvailableCacheIds =
  | 'tmdb'
  | 'tmdbscan'
  | 'radarr'
  | 'sonarr'
  | 'lidarr'
  | 'musicbrainz'
  | 'listenbrainz'
  | 'applecharts'
  | 'rt'
  | 'imdb'
  | 'github'
  | 'plextv'
  | 'plexwatchlist'
  | 'libraryaccess'
  | 'tvdb';

const DEFAULT_TTL = 300;

const OBJECT_VALUE_SIZE = 80;
const PROMISE_VALUE_SIZE = 80;
const ARRAY_VALUE_SIZE = 40;

const TMDB_MAX_KEYS = 1000;

// Backstop only; the 15 minute TTL bounds this tier.
const TMDB_SCAN_MAX_KEYS = 2000;

// Credits rosters are uncapped, so TMDB answers are also capped by their size
// (as JSON); the least recently used go first.
const TMDB_MAX_BYTES = 64 * 1024 * 1024;

// Only profile, root folder and language lookups land here, keyed by server
// url: a few keys per server.
const RADARR_MAX_KEYS = 64;
const SONARR_MAX_KEYS = 64;
const LIDARR_MAX_KEYS = 64;

// Viewed artists, albums and track lists. MusicMetadata keeps them longer;
// this skips the database read.
const MUSICBRAINZ_MAX_KEYS = 2000;

// A few Discover rows, the same for everyone.
const LISTENBRAINZ_MAX_KEYS = 32;
/** Two charts (songs, albums) for a country or two. */
const APPLE_CHARTS_MAX_KEYS = 8;

// One key per searched title, each holding twenty search hits.
const RT_MAX_KEYS = 500;

// One key per IMDb id, requested from the same endpoint as the RT ratings.
const IMDB_MAX_KEYS = 500;

// Releases and commits, varying only by page size and branch.
const GITHUB_MAX_KEYS = 16;

// Watchlist item metadata; the token isn't in the key, so users share entries.
const PLEX_TV_MAX_KEYS = 5000;

// Keyed by auth token, so one key per Plex linked user.
const PLEX_WATCHLIST_MAX_KEYS = 500;

// One key per person and media server (lib/libraryVisibility).
const LIBRARY_ACCESS_MAX_KEYS = 2000;

// Several keys per show; the largest payloads, as the extended series lookup
// carries every episode.
const TVDB_MAX_KEYS = 500;

export interface CacheStats {
  hits: number;
  misses: number;
  keys: number;
  ksize: number;
  vsize: number;
}

export interface CacheStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttl?: number): boolean;
  del(key: string): number;
  getTtl(key: string): number | undefined;
  getStats(): CacheStats;
  flushAll(): void;
}

const keyLength = (key: string): number => key.toString().length;

const valueLength = (value: unknown): number => {
  if (typeof value === 'string') {
    return value.length;
  }
  if (Array.isArray(value)) {
    return ARRAY_VALUE_SIZE * value.length;
  }
  if (typeof value === 'number') {
    return 8;
  }
  if (
    typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
  ) {
    return PROMISE_VALUE_SIZE;
  }
  if (Buffer.isBuffer(value)) {
    return value.length;
  }
  if (value != null && typeof value === 'object') {
    return OBJECT_VALUE_SIZE * Object.keys(value).length;
  }
  if (typeof value === 'boolean') {
    return 8;
  }
  return 0;
};

/** An answer's size as JSON, or as bytes for a buffer. */
const bytesOf = (value: unknown): number => {
  if (Buffer.isBuffer(value)) {
    return value.length;
  }
  try {
    return Math.max(1, JSON.stringify(value)?.length ?? 1);
  } catch {
    return 1;
  }
};

interface LruEntry {
  value: unknown;
  ksize: number;
  vsize: number;
}

class LruCacheStore implements CacheStore {
  private cache: LRUCache<string, LruEntry>;
  private stdTtl: number;
  private hits = 0;
  private misses = 0;
  private ksize = 0;
  private vsize = 0;

  constructor({
    max,
    maxBytes,
    stdTtl,
  }: {
    max: number;
    maxBytes?: number;
    stdTtl: number;
  }) {
    this.stdTtl = stdTtl;
    this.cache = new LRUCache<string, LruEntry>({
      max,
      ...(maxBytes && {
        maxSize: maxBytes,
        sizeCalculation: (entry) => bytesOf(entry.value),
      }),
      ttl: stdTtl * 1000,
      // Otherwise expired entries are dropped only when read.
      ttlAutopurge: true,
      // Runs on every removal path.
      dispose: (entry) => {
        this.ksize -= entry.ksize;
        this.vsize -= entry.vsize;
      },
    });
  }

  // Cloned because callers mutate results (getTvSeason rewrites still_path).
  public get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (entry === undefined) {
      this.misses++;
      return undefined;
    }

    this.hits++;
    return structuredClone(entry.value) as T;
  }

  public set<T>(key: string, value: T, ttl?: number): boolean {
    const entry: LruEntry = {
      value: structuredClone(value),
      ksize: keyLength(key),
      vsize: valueLength(value),
    };

    // A ttl of 0 means the entry never expires.
    this.cache.set(key, entry, { ttl: (ttl ?? this.stdTtl) * 1000 });

    // An answer larger than the whole size limit isn't kept.
    if (this.cache.peek(key) !== entry) {
      return false;
    }
    this.ksize += entry.ksize;
    this.vsize += entry.vsize;

    return true;
  }

  public del(key: string): number {
    return this.cache.delete(key) ? 1 : 0;
  }

  public getTtl(key: string): number | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }

    const remaining = this.cache.getRemainingTTL(key);

    // Keys with no expiry report 0.
    return remaining === Infinity ? 0 : Date.now() + remaining;
  }

  public getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      keys: this.cache.size,
      ksize: this.ksize,
      vsize: this.vsize,
    };
  }

  public flushAll(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.ksize = 0;
    this.vsize = 0;
  }
}

export class Cache {
  public id: AvailableCacheIds;
  public data: CacheStore;
  public name: string;

  constructor(
    id: AvailableCacheIds,
    name: string,
    options: { max: number; maxBytes?: number; stdTtl?: number }
  ) {
    this.id = id;
    this.name = name;

    this.data = new LruCacheStore({
      max: options.max,
      maxBytes: options.maxBytes,
      stdTtl: options.stdTtl ?? DEFAULT_TTL,
    });
  }

  public getStats() {
    return this.data.getStats();
  }

  public flush(): void {
    this.data.flushAll();
  }
}

class CacheManager {
  private availableCaches: Record<AvailableCacheIds, Cache> = {
    tmdb: new Cache('tmdb', 'The Movie Database API', {
      stdTtl: 21600,
      max: TMDB_MAX_KEYS,
      maxBytes: TMDB_MAX_BYTES,
    }),
    tmdbscan: new Cache('tmdbscan', 'The Movie Database API (Library Scans)', {
      stdTtl: 900,
      max: TMDB_SCAN_MAX_KEYS,
      maxBytes: TMDB_MAX_BYTES,
    }),
    radarr: new Cache('radarr', 'Radarr API', { max: RADARR_MAX_KEYS }),
    sonarr: new Cache('sonarr', 'Sonarr API', { max: SONARR_MAX_KEYS }),
    lidarr: new Cache('lidarr', 'Lidarr API', { max: LIDARR_MAX_KEYS }),
    musicbrainz: new Cache('musicbrainz', 'MusicBrainz API', {
      stdTtl: 21600,
      max: MUSICBRAINZ_MAX_KEYS,
    }),
    listenbrainz: new Cache('listenbrainz', 'ListenBrainz API', {
      stdTtl: 21600,
      max: LISTENBRAINZ_MAX_KEYS,
    }),
    applecharts: new Cache('applecharts', 'Apple Music Charts', {
      stdTtl: 21600,
      max: APPLE_CHARTS_MAX_KEYS,
    }),
    rt: new Cache('rt', 'Rotten Tomatoes API', {
      stdTtl: 43200,
      max: RT_MAX_KEYS,
    }),
    imdb: new Cache('imdb', 'IMDB Radarr Proxy', {
      stdTtl: 43200,
      max: IMDB_MAX_KEYS,
    }),
    github: new Cache('github', 'GitHub API', {
      stdTtl: 21600,
      max: GITHUB_MAX_KEYS,
    }),
    plextv: new Cache('plextv', 'Plex TV', {
      stdTtl: 86400 * 7, // 1 week cache
      max: PLEX_TV_MAX_KEYS,
    }),
    plexwatchlist: new Cache('plexwatchlist', 'Plex Watchlist', {
      max: PLEX_WATCHLIST_MAX_KEYS,
    }),
    libraryaccess: new Cache('libraryaccess', 'Library Access', {
      stdTtl: 600,
      max: LIBRARY_ACCESS_MAX_KEYS,
    }),
    tvdb: new Cache('tvdb', 'The TVDB API', {
      stdTtl: 21600,
      max: TVDB_MAX_KEYS,
    }),
  };

  public getCache(id: AvailableCacheIds): Cache {
    return this.availableCaches[id];
  }

  public getAllCaches(): Record<string, Cache> {
    return this.availableCaches;
  }
}

const cacheManager = new CacheManager();

export default cacheManager;
