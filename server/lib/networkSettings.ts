import type { NetworkSettings } from '@server/lib/settings';
import createCustomProxyAgent, {
  setForceIpv4First,
} from '@server/utils/customProxyAgent';
import { applyDnsCache } from '@server/utils/dnsCache';
import { applyProxyTrust } from '@server/utils/trustedProxies';

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Puts Settings → Network into effect: at startup (no previous settings), and
 * after each save, so none of them needs a restart. CSRF protection and the
 * API request timeout are read on each request, so need nothing here.
 */
export const applyNetworkSettings = async (
  network: NetworkSettings,
  previous?: NetworkSettings
): Promise<void> => {
  applyProxyTrust(network);
  if (!previous || previous.forceIpv4First !== network.forceIpv4First) {
    setForceIpv4First(network.forceIpv4First);
  }
  applyDnsCache({
    enabled: !!network.dnsCache?.enabled,
    forceMinTtl: network.dnsCache?.forceMinTtl,
    forceMaxTtl: network.dnsCache?.forceMaxTtl,
  });
  if (
    !previous ||
    !same(previous.proxy, network.proxy) ||
    previous.forceIpv4First !== network.forceIpv4First
  ) {
    await createCustomProxyAgent(network.proxy, network.forceIpv4First);
  }
};
