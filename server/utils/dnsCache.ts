import logger from '@server/logger';
import { DnsCacheManager } from 'dns-caching';
import dns from 'node:dns';

export let dnsCache: DnsCacheManager | undefined;

// Node's own lookups, put back when the cache is turned off: the cache
// replaces them while it runs.
const nativeLookup = dns.lookup;
const nativePromisesLookup = dns.promises.lookup;

let applied: { forceMinTtl?: number; forceMaxTtl?: number } | undefined;

const stopDnsCache = () => {
  if (!dnsCache) {
    return;
  }
  dns.lookup = nativeLookup;
  dns.promises.lookup = nativePromisesLookup;
  dnsCache = undefined;
  applied = undefined;
  logger.info('DNS Cache turned off', { label: 'DNS Cache' });
};

/**
 * Settings → Network → DNS Cache, from the next lookup on: started, stopped,
 * or started again with new TTLs (which empties it).
 */
export function applyDnsCache({
  enabled,
  forceMinTtl,
  forceMaxTtl,
}: {
  enabled: boolean;
  forceMinTtl?: number;
  forceMaxTtl?: number;
}) {
  if (!enabled) {
    stopDnsCache();
    return;
  }
  if (
    dnsCache &&
    applied?.forceMinTtl === forceMinTtl &&
    applied?.forceMaxTtl === forceMaxTtl
  ) {
    return;
  }
  stopDnsCache();

  logger.info('Initializing DNS Cache', { label: 'DNS Cache' });

  dnsCache = new DnsCacheManager({
    logger,
    forceMinTtl: typeof forceMinTtl === 'number' ? forceMinTtl * 1000 : 0,
    forceMaxTtl: typeof forceMaxTtl === 'number' ? forceMaxTtl * 1000 : -1,
  });
  dnsCache.initialize();
  applied = { forceMinTtl, forceMaxTtl };
}
