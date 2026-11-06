import type { LookupAddress } from 'node:dns';
import dns from 'node:dns';
import net from 'node:net';

/*
 * Outbound requests to addresses chosen by others (indexer links, avatar
 * redirects) go only to public hosts. Loopback, private, link-local,
 * shared, multicast and reserved addresses are refused, checked on the
 * address actually connected to, so a public name resolving locally is
 * refused too.
 */

const local = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  local.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  local.addSubnet(address, prefix, 'ipv6');
}

export const addressPolicy = {
  /** Whether an IP address is on this machine or a local network. */
  isLocal(address: string): boolean {
    const bare = address.replace(/^\[|\]$/g, '');
    const family = net.isIP(bare);
    if (family === 4) return local.check(bare, 'ipv4');
    if (family !== 6) return true;
    // IPv4 written as IPv6 (::ffff:127.0.0.1) is checked as IPv4.
    const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return local.check(mapped[1], 'ipv4');
    const hex = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return local.check(
        [high >> 8, high & 255, low >> 8, low & 255].join('.'),
        'ipv4'
      );
    }
    return local.check(bare, 'ipv6');
  },
};

export class LocalAddressRefused extends Error {
  constructor(host: string) {
    super(`Not fetched: ${host} is a local address.`);
  }
}

/** The host of a URL as an IP address, or undefined for a name. */
const ipOf = (hostname: string): string | undefined => {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return net.isIP(bare) ? bare : undefined;
};

/** Refuses a URL whose host is a local IP address written out. */
export const assertPublicUrl = (url: URL): void => {
  const ip = ipOf(url.hostname);
  if (ip && addressPolicy.isLocal(ip)) {
    throw new LocalAddressRefused(url.hostname);
  }
};

type LookupCallback = (
  err: Error | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/**
 * A DNS lookup, for Node's http options or axios, that refuses names
 * resolving to a local address. IP literals skip lookups, so pair it with
 * assertPublicUrl.
 */
export const publicLookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback
): void => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (
      !addresses.length ||
      addresses.some((a) => addressPolicy.isLocal(a.address))
    ) {
      return callback(new LocalAddressRefused(hostname), []);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

/**
 * A redirect check for requests made by full address: a move within the
 * host asked is followed; anywhere else only to a public address.
 */
export const publicRedirectGuard = (
  options: Record<string, unknown> & {
    hostname?: string | null;
    protocol?: string | null;
  },
  _response?: unknown,
  request?: { url?: string }
): void => {
  let from: string | undefined;
  try {
    from = request?.url ? new URL(request.url).hostname : undefined;
  } catch {
    from = undefined;
  }
  const host = String(options.hostname ?? '').toLowerCase();
  if (from && host === from.toLowerCase().replace(/^\[|\]$/g, '')) return;
  const ip = ipOf(host);
  if (ip && addressPolicy.isLocal(ip)) throw new LocalAddressRefused(host);
  options.lookup = publicLookup;
};
