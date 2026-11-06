import { applyNetworkSettings } from '@server/lib/networkSettings';
import type { NetworkSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { dnsCache } from '@server/utils/dnsCache';
import { liveProxyTrust } from '@server/utils/trustedProxies';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { after, describe, it } from 'node:test';

/* Settings → Network put into effect without a restart. */

const nativeLookup = dns.lookup;
const network = (over: Partial<NetworkSettings>): NetworkSettings => ({
  ...structuredClone(getSettings().network),
  ...over,
});

after(() =>
  applyNetworkSettings(
    network({ dnsCache: { enabled: false, forceMinTtl: 0, forceMaxTtl: -1 } })
  )
);

describe('the network settings, applied', () => {
  it('start and stop the DNS cache, and put back Node’s own lookups', async () => {
    const off = network({
      dnsCache: { enabled: false, forceMinTtl: 0, forceMaxTtl: -1 },
    });
    const on = network({
      dnsCache: { enabled: true, forceMinTtl: 0, forceMaxTtl: -1 },
    });

    await applyNetworkSettings(on, off);
    assert.ok(dnsCache);
    assert.notEqual(dns.lookup, nativeLookup);
    const first = dnsCache;

    // New TTLs start it again; the same ones leave it as it is.
    await applyNetworkSettings(on, on);
    assert.equal(dnsCache, first);
    const longer = network({
      dnsCache: { enabled: true, forceMinTtl: 60, forceMaxTtl: -1 },
    });
    await applyNetworkSettings(longer, on);
    assert.notEqual(dnsCache, first);

    await applyNetworkSettings(off, longer);
    assert.equal(dnsCache, undefined);
    assert.equal(dns.lookup, nativeLookup);
  });

  it('trust proxies as saved', async () => {
    await applyNetworkSettings(
      network({ trustProxy: true, trustedProxies: ['198.51.100.20'] })
    );
    assert.equal(liveProxyTrust('198.51.100.20', 1), true);
    await applyNetworkSettings(network({ trustProxy: false }));
    assert.equal(liveProxyTrust('198.51.100.20', 1), false);
  });
});
