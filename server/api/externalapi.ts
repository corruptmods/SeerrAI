import type { CacheStore } from '@server/lib/cache';
import logger from '@server/logger';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import axios from 'axios';
import rateLimit from 'axios-rate-limit';

// Seconds.
const DEFAULT_TTL = 300;

// Milliseconds.
const DEFAULT_ROLLING_BUFFER = 10000;

/**
 * Default request timeout. Without one, a request that never answers stalls
 * its caller (a scan, a watchlist sync) forever.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Cache keys refreshing in the background; one refresh per key at a time. */
const refreshing = new Set<string>();

export interface ExternalAPIOptions {
  nodeCache?: CacheStore;
  headers?: Record<string, unknown>;
  timeout?: number;
  rateLimit?: {
    maxRPS: number;
    maxRequests: number;
  };
}

class ExternalAPI {
  protected axios: AxiosInstance;
  private baseUrl: string;
  private cache?: CacheStore;

  constructor(
    baseUrl: string,
    params: Record<string, unknown>,
    options: ExternalAPIOptions = {}
  ) {
    this.axios = axios.create({
      baseURL: baseUrl,
      params,
      timeout: options.timeout,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...options.headers,
      },
    });
    this.axios.interceptors.request.use(proxyRequestInterceptor);
    this.axios.interceptors.request.use(userAgentRequestInterceptor);

    if (options.rateLimit) {
      this.axios = rateLimit(this.axios, {
        maxRequests: options.rateLimit.maxRequests,
        maxRPS: options.rateLimit.maxRPS,
      });
    }

    this.baseUrl = baseUrl;
    this.cache = options.nodeCache;
  }

  // transform runs before the cache write; data `keep` rejects is returned
  // but not cached, so the next call fetches again.
  protected async get<T>(
    endpoint: string,
    config?: AxiosRequestConfig,
    ttl?: number,
    options?: {
      cache?: CacheStore;
      transform?: (data: T) => T;
      keep?: (data: T) => boolean;
    }
  ): Promise<T> {
    const cache = options?.cache ?? this.cache;
    const cacheKey = this.serializeCacheKey(endpoint, {
      ...config?.params,
      headers: config?.headers,
    });
    const cachedItem = cache?.get<T>(cacheKey);
    if (cachedItem) {
      return cachedItem;
    }

    const response = await this.axios.get<T>(endpoint, config);
    const data = options?.transform
      ? options.transform(response.data)
      : response.data;

    if (cache && ttl !== 0 && (options?.keep?.(data) ?? true)) {
      cache.set(cacheKey, data, ttl ?? DEFAULT_TTL);
    }

    return data;
  }

  /**
   * Cached only when the caller passes a ttl: most POSTs change something or
   * sign in, and a stale answer would hide that the service is down.
   */
  protected async post<T>(
    endpoint: string,
    data?: Record<string, unknown>,
    config?: AxiosRequestConfig,
    ttl?: number
  ): Promise<T> {
    const cache = ttl ? this.cache : undefined;
    const cacheKey = this.serializeCacheKey(endpoint, {
      config: config?.params,
      ...(data ? { data } : {}),
    });

    const cachedItem = cache?.get<T>(cacheKey);
    if (cachedItem) {
      return cachedItem;
    }

    const response = await this.axios.post<T>(endpoint, data, config);

    if (cache && ttl) {
      cache.set(cacheKey, response.data, ttl);
    }

    return response.data;
  }

  protected async getRolling<T>(
    endpoint: string,
    config?: AxiosRequestConfig,
    ttl?: number
  ): Promise<T> {
    const cacheKey = this.serializeCacheKey(endpoint, {
      ...config?.params,
      headers: config?.headers,
    });
    const cachedItem = this.cache?.get<T>(cacheKey);

    if (cachedItem) {
      const keyTtl = this.cache?.getTtl(cacheKey) ?? 0;

      // Past the rolling buffer: refresh in the background.
      if (
        keyTtl - (ttl ?? DEFAULT_TTL) * 1000 <
          Date.now() - DEFAULT_ROLLING_BUFFER &&
        !refreshing.has(cacheKey)
      ) {
        refreshing.add(cacheKey);
        this.axios
          .get<T>(endpoint, config)
          .then((response) => {
            this.cache?.set(cacheKey, response.data, ttl ?? DEFAULT_TTL);
          })
          .catch((e) => {
            // Keep the cached answer. Log only the message: the request
            // carries API keys and tokens.
            logger.warn('Could not refresh a cached answer', {
              label: 'External API',
              endpoint,
              errorMessage: e instanceof Error ? e.message : String(e),
            });
          })
          .finally(() => refreshing.delete(cacheKey));
      }
      return cachedItem;
    }

    const response = await this.axios.get<T>(endpoint, config);

    if (this.cache && ttl !== 0) {
      this.cache.set(cacheKey, response.data, ttl ?? DEFAULT_TTL);
    }

    return response.data;
  }

  protected removeCache(endpoint: string, options?: Record<string, unknown>) {
    const cacheKey = this.serializeCacheKey(endpoint, {
      ...options,
    });
    this.cache?.del(cacheKey);
  }

  private serializeCacheKey(
    endpoint: string,
    options?: Record<string, unknown>
  ) {
    if (!options) {
      return `${this.baseUrl}${endpoint}`;
    }

    return `${this.baseUrl}${endpoint}${JSON.stringify(options)}`;
  }
}

export default ExternalAPI;
