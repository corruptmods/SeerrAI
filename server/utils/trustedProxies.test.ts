import type { NetworkSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  CLOUDFLARE_PROXIES,
  LOCAL_PROXIES,
  isProxyAddress,
  trustedProxies,
} from '@server/utils/trustedProxies';
import express from 'express';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * Settings → Network → Enable Proxy Support: which proxies' word on
 * someone's address is taken. The sign-in limits count by address, so an
 * address anyone can make up would let them guess without limit.
 */

const CLOUDFLARE_ADDRESS = '172.68.1.5';

/**
 * An app set up the way the server sets itself up from the settings, with
 * one page that says which address it took for the request.
 */
const appFor = (network: NetworkSettings) => {
  const app = express();
  if (network.trustProxy) {
    app.set('trust proxy', trustedProxies(network));
  }
  app.get('/', (req, res) => {
    res.json({ ip: req.ip });
  });
  return app;
};

const ipFor = async (forwardedFor?: string) => {
  const req = request(appFor(getSettings().network)).get('/');
  if (forwardedFor) {
    req.set('X-Forwarded-For', forwardedFor);
  }
  return (await req).body.ip as string;
};

beforeEach(() => {
  const network = getSettings().network;
  network.trustProxy = true;
  network.trustCloudflare = false;
  network.trustedProxies = [];
});

describe('the list of trusted proxies', () => {
  it('is this machine, the local network and Tailscale by default', () => {
    assert.deepEqual(trustedProxies(getSettings().network), [
      'loopback',
      'linklocal',
      'uniquelocal',
      '100.64.0.0/10',
    ]);
    assert.deepEqual(trustedProxies(getSettings().network), LOCAL_PROXIES);
  });

  it("adds Cloudflare's published ranges when asked", () => {
    getSettings().network.trustCloudflare = true;
    const list = trustedProxies(getSettings().network);
    assert.deepEqual(list, [...LOCAL_PROXIES, ...CLOUDFLARE_PROXIES]);
    assert.ok(list.includes('173.245.48.0/20'));
    assert.ok(list.includes('2a06:98c0::/29'));
    assert.equal(CLOUDFLARE_PROXIES.length, 22);
  });

  it('adds the proxies the admin listed, after the rest', () => {
    getSettings().network.trustCloudflare = true;
    getSettings().network.trustedProxies = ['198.51.100.20', '2001:db8::/32'];
    assert.deepEqual(trustedProxies(getSettings().network), [
      ...LOCAL_PROXIES,
      ...CLOUDFLARE_PROXIES,
      '198.51.100.20',
      '2001:db8::/32',
    ]);
  });

  it('leaves out a listed entry Express would refuse, rather than not starting', () => {
    getSettings().network.trustedProxies = ['198.51.100.20', 'nonsense'];
    assert.deepEqual(trustedProxies(getSettings().network), [
      ...LOCAL_PROXIES,
      '198.51.100.20',
    ]);
  });

  it('works with settings saved before these choices existed', () => {
    const {
      trustCloudflare,
      trustedProxies: listed,
      ...older
    } = getSettings().network;
    void trustCloudflare;
    void listed;
    assert.deepEqual(
      trustedProxies(older as unknown as NetworkSettings),
      LOCAL_PROXIES
    );
  });
});

describe('an address or range of a proxy', () => {
  it('is an IPv4 or IPv6 address, with or without a range', () => {
    for (const entry of [
      '198.51.100.20',
      '198.51.100.0/24',
      '10.0.0.0/255.0.0.0',
      '2001:db8::1',
      '2001:db8::/32',
      '::ffff:198.51.100.20',
    ]) {
      assert.equal(isProxyAddress(entry), true, entry);
    }
  });

  it('is not a name, a bad range or anything else', () => {
    for (const entry of [
      '',
      'loopback',
      'proxy.example.com',
      '198.51.100',
      '198.51.100.0/33',
      '198.51.100.0/0',
      '198.51.100.0/0.0.0.0',
      '198.51.100.0/',
      '2001:db8::/129',
      ' 198.51.100.20',
      '198.51.100.20, 198.51.100.21',
    ]) {
      assert.equal(isProxyAddress(entry), false, entry);
    }
  });
});

describe('the address a request is taken to come from', () => {
  it('is the one a proxy on this machine or network passes on', async () => {
    assert.equal(await ipFor('198.51.100.7'), '198.51.100.7');
    // Two proxies on the local network, one behind the other.
    assert.equal(
      await ipFor('198.51.100.7, 10.0.0.2, 172.17.0.1'),
      '198.51.100.7'
    );
  });

  it('is never one the person sending the request made up', async () => {
    // What someone outside puts in the header comes first; the proxy adds
    // the address it really saw after it.
    assert.equal(await ipFor('203.0.113.1, 198.51.100.7'), '198.51.100.7');
    assert.equal(
      await ipFor('203.0.113.1, 203.0.113.2, 198.51.100.7, 10.0.0.2'),
      '198.51.100.7'
    );
  });

  it('is the connection itself when no proxy says anything', async () => {
    assert.match(await ipFor(), /127\.0\.0\.1|::1/);
  });

  it('is passed on by a proxy reached over Tailscale', async () => {
    assert.equal(await ipFor('fake, 203.0.113.9, 100.64.1.2'), '203.0.113.9');
    assert.equal(
      await ipFor('fake, 203.0.113.9, 100.127.255.254'),
      '203.0.113.9'
    );
    // Just outside the shared address space: an address on the internet.
    assert.equal(await ipFor('fake, 203.0.113.9, 100.128.0.1'), '100.128.0.1');
  });

  it("is Cloudflare's own unless Trust Cloudflare is on", async () => {
    const forwarded = `fake, 203.0.113.9, ${CLOUDFLARE_ADDRESS}`;
    assert.equal(await ipFor(forwarded), CLOUDFLARE_ADDRESS);

    getSettings().network.trustCloudflare = true;
    assert.equal(await ipFor(forwarded), '203.0.113.9');
    assert.equal(
      await ipFor('fake, 203.0.113.9, 2606:4700:10::6816:1'),
      '203.0.113.9'
    );
  });

  it('is passed on by a proxy the admin listed', async () => {
    const forwarded = 'fake, 203.0.113.9, 198.51.100.20';
    assert.equal(await ipFor(forwarded), '198.51.100.20');

    getSettings().network.trustedProxies = ['198.51.100.0/24'];
    assert.equal(await ipFor(forwarded), '203.0.113.9');

    getSettings().network.trustedProxies = ['198.51.100.20'];
    assert.equal(await ipFor(forwarded), '203.0.113.9');
  });

  it('is the connection whatever the header says with proxy support off', async () => {
    const network = getSettings().network;
    network.trustProxy = false;
    network.trustCloudflare = true;
    network.trustedProxies = ['198.51.100.0/24'];
    assert.match(
      await ipFor(`203.0.113.9, ${CLOUDFLARE_ADDRESS}`),
      /127\.0\.0\.1|::1/
    );
  });
});
