import {
  addressPolicy,
  assertPublicUrl,
  publicLookup,
  publicRedirectGuard,
} from '@server/utils/publicHost';
import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import dns from 'node:dns';
import { afterEach, describe, it, mock } from 'node:test';

const lookup = (hostname: string) =>
  new Promise<LookupAddress[]>((resolve, reject) =>
    publicLookup(hostname, { all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses as LookupAddress[])
    )
  );

const resolvesTo = (...addresses: string[]) =>
  mock.method(
    dns,
    'lookup',
    (
      _host: string,
      _options: unknown,
      cb: (e: null, a: LookupAddress[]) => void
    ) =>
      cb(
        null,
        addresses.map((address) => ({
          address,
          family: address.includes(':') ? 6 : 4,
        }))
      )
  );

describe('outbound hosts', () => {
  afterEach(() => mock.restoreAll());

  it('knows local addresses from public ones', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::1]',
    ]) {
      assert.equal(addressPolicy.isLocal(address), true, address);
    }
    for (const address of ['192.0.2.10', '2001:db8::1', '::ffff:192.0.2.10']) {
      assert.equal(addressPolicy.isLocal(address), false, address);
    }
  });

  it('refuses a link written with a local address', () => {
    assert.throws(
      () => assertPublicUrl(new URL('http://[::1]:8080/x')),
      /local address/
    );
    assert.throws(
      () => assertPublicUrl(new URL('http://0x7f.1/x')),
      /local address/
    );
    assert.doesNotThrow(() =>
      assertPublicUrl(new URL('http://indexer.example.invalid/x'))
    );
  });

  it('refuses a name resolving to any local address', async () => {
    resolvesTo('192.0.2.10', '10.0.0.4');
    await assert.rejects(lookup('indexer.example.invalid'), /local address/);
    mock.restoreAll();
    resolvesTo('192.0.2.10');
    assert.deepEqual(await lookup('indexer.example.invalid'), [
      { address: '192.0.2.10', family: 4 },
    ]);
  });

  it('follows a redirect within the host asked, else only to a public address', () => {
    const from = { url: 'http://jellyfin.example.invalid:8096/UserImage' };
    const same: Record<string, unknown> = {
      protocol: 'https:',
      hostname: 'jellyfin.example.invalid',
    };
    publicRedirectGuard(same, {}, from);
    assert.equal(same.lookup, undefined);

    const away: Record<string, unknown> = {
      protocol: 'https:',
      hostname: 'images.example.invalid',
    };
    publicRedirectGuard(away, {}, from);
    assert.equal(away.lookup, publicLookup);

    for (const hostname of [
      '127.0.0.1',
      '10.0.0.2',
      '169.254.169.254',
      '::1',
    ]) {
      assert.throws(
        () => publicRedirectGuard({ protocol: 'http:', hostname }, {}, from),
        /local address/
      );
    }
  });
});
