import type { NetworkSettings } from '@server/lib/settings';
import logger from '@server/logger';
import express from 'express';
import net from 'node:net';

/**
 * The proxies whose word on someone's address is always taken when
 * Settings → Network → Enable Proxy Support is on: those on this machine
 * (loopback), on its link (link-local), on the private network (10.x,
 * 172.16-31.x, 192.168.x, fc00::/7), which is where a reverse proxy or a
 * Docker network sits, and in the shared address space 100.64.0.0/10. That
 * last one is where Tailscale gives out addresses (its IPv6 ones are under
 * fc00::/7 already), and carrier-grade NAT; nobody on the internet can
 * connect from it.
 *
 * Not every proxy: X-Forwarded-For is a list anyone can start, and with
 * every hop trusted the address used is its first entry, whatever the
 * person sending the request wrote there. The sign-in limits count wrong
 * passwords per address, so that would let someone guess without limit by
 * writing a new address each time. Trusting only known proxies, the
 * address used is the last one a trusted proxy added: the one it really
 * saw.
 */
export const LOCAL_PROXIES = [
  'loopback',
  'linklocal',
  'uniquelocal',
  '100.64.0.0/10',
];

/**
 * The addresses Cloudflare's proxy (the orange cloud) connects from,
 * trusted only with Trust Cloudflare on. As published at
 * https://cloudflare.com/ips, checked on 15 October 2026. Cloudflare Tunnel
 * needs none of this: the tunnel connects from this machine or the local
 * network.
 */
export const CLOUDFLARE_PROXIES = [
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '108.162.192.0/18',
  '131.0.72.0/22',
  '141.101.64.0/18',
  '162.158.0.0/15',
  '172.64.0.0/13',
  '173.245.48.0/20',
  '188.114.96.0/20',
  '190.93.240.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

// Only used to have Express check an entry exactly as it will read it.
const checker = express();

/**
 * Whether an entry in Also Trust These Proxies is an address or a range
 * (IPv4 or IPv6, with a /prefix or an IPv4 netmask) that Express takes.
 * Names Express knows, such as "loopback", are left out: those are trusted
 * already or are not what the field is for.
 */
export const isProxyAddress = (entry: string): boolean => {
  if (net.isIP(entry.split('/')[0]) === 0) {
    return false;
  }
  try {
    checker.set('trust proxy', [entry]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Every proxy trusted with Enable Proxy Support on: those always trusted,
 * Cloudflare's if Trust Cloudflare is on, then the ones the admin listed.
 * A listed entry Express would refuse (only possible by editing
 * settings.json by hand, since saving checks them) is left out with a
 * warning, so the server still starts.
 */
export const trustedProxies = (
  network: Pick<NetworkSettings, 'trustCloudflare' | 'trustedProxies'>
): string[] => {
  const listed = (network.trustedProxies ?? []).filter((entry) => {
    if (isProxyAddress(entry)) {
      return true;
    }
    logger.warn('Ignoring a trusted proxy that is not an address or range', {
      label: 'Server',
      entry,
    });
    return false;
  });
  return [
    ...LOCAL_PROXIES,
    ...(network.trustCloudflare ? CLOUDFLARE_PROXIES : []),
    ...listed,
  ];
};
