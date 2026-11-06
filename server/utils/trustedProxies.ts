import type { NetworkSettings } from '@server/lib/settings';
import logger from '@server/logger';
import express from 'express';
import net from 'node:net';

/**
 * Proxies always trusted for client addresses when Settings → Network → Enable
 * Proxy Support is on: loopback, link-local, private networks (10.x,
 * 172.16-31.x, 192.168.x, fc00::/7, where reverse proxies and Docker networks
 * sit), and shared address space 100.64.0.0/10 (Tailscale's IPv4 range, plus
 * carrier-grade NAT; unreachable from the internet).
 *
 * Not every proxy: anyone can start an X-Forwarded-For list, and with every hop
 * trusted its first entry is used, whatever the client wrote. Sign-in limits
 * count failed passwords per address, so that would allow unlimited guessing
 * with a new address each time. Trusting only known proxies uses the last
 * address a trusted proxy added: the one it actually saw.
 *
 * Local addresses other than loopback are trusted only as the proxy that
 * connects to Seerr AI: further along the list a local address is as likely a
 * visitor on the local network or Tailscale as another proxy. A local proxy
 * behind another one is listed under Also Trust These Proxies.
 */
export const LOCAL_PROXIES = [
  'loopback',
  'linklocal',
  'uniquelocal',
  '100.64.0.0/10',
];

/**
 * Cloudflare proxy (orange cloud) addresses, trusted only with Trust Cloudflare
 * on. From https://cloudflare.com/ips, checked 15 October 2026. Cloudflare
 * Tunnel needs none: it connects from this machine or the local network.
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

// Only used to validate an entry exactly as Express will parse it.
const checker = express();

/**
 * Whether an Also Trust These Proxies entry is an address or range Express
 * accepts (IPv4 or IPv6, with a /prefix or IPv4 netmask). Express names such as
 * "loopback" are rejected: already trusted or not what the field is for.
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
 * Cloudflare's proxies if Trust Cloudflare is on, then the admin's list. An
 * entry Express would reject (possible only by hand-editing settings.json,
 * since saving validates) is skipped with a warning so the server still
 * starts.
 */
const otherProxies = (
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
  return [...(network.trustCloudflare ? CLOUDFLARE_PROXIES : []), ...listed];
};

/**
 * Every proxy trusted with Enable Proxy Support on: the local ones,
 * Cloudflare's if Trust Cloudflare is on, then the admin's list.
 */
export const trustedProxies = (
  network: Pick<NetworkSettings, 'trustCloudflare' | 'trustedProxies'>
): string[] => [...LOCAL_PROXIES, ...otherProxies(network)];

type ProxyTrust = (address: string, hop: number) => boolean;

const compileTrust = (list: string[]): ProxyTrust =>
  express().set('trust proxy', list).get('trust proxy fn');

/**
 * Express's "trust proxy" with Enable Proxy Support on. Hop 0, the address
 * connecting to Seerr AI, is trusted if in trustedProxies(); addresses further
 * along X-Forwarded-For only on loopback, Cloudflare's (with Trust Cloudflare)
 * or the admin's list.
 */
export const proxyTrust = (
  network: Pick<NetworkSettings, 'trustCloudflare' | 'trustedProxies'>
): ProxyTrust => {
  const others = otherProxies(network);
  const connecting = compileTrust([...LOCAL_PROXIES, ...others]);
  const further = compileTrust(['loopback', ...others]);
  return (address, hop) =>
    hop === 0 ? connecting(address, hop) : further(address, hop);
};

let current: ProxyTrust = () => false;

/**
 * Express's "trust proxy" for the whole server: follows Settings → Network as
 * it is saved (applyProxyTrust), so a change needs no restart.
 */
export const liveProxyTrust: ProxyTrust = (address, hop) =>
  current(address, hop);

/** Trusts proxies as these network settings say, from the next request on. */
export const applyProxyTrust = (
  network: Pick<
    NetworkSettings,
    'trustProxy' | 'trustCloudflare' | 'trustedProxies'
  >
): void => {
  current = network.trustProxy ? proxyTrust(network) : () => false;
};
