import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  firstNonAddress,
  proxyListFromText,
  proxyListToText,
} from './proxyList';

/*
 * Also Trust These Proxies on Settings → Network: typed as one line, saved
 * as a list.
 */

describe('the Also Trust These Proxies field', () => {
  it('takes entries separated by commas, spaces or both', () => {
    assert.deepEqual(
      proxyListFromText('198.51.100.20, 2001:db8::/32 10.1.0.0/16,,  '),
      ['198.51.100.20', '2001:db8::/32', '10.1.0.0/16']
    );
    assert.deepEqual(proxyListFromText('198.51.100.20\n198.51.100.21'), [
      '198.51.100.20',
      '198.51.100.21',
    ]);
  });

  it('is an empty list when left blank', () => {
    assert.deepEqual(proxyListFromText(''), []);
    assert.deepEqual(proxyListFromText('  , '), []);
    assert.deepEqual(proxyListFromText(undefined), []);
  });

  it('shows the saved entries back as they were entered', () => {
    assert.equal(
      proxyListToText(['198.51.100.20', '2001:db8::/32']),
      '198.51.100.20, 2001:db8::/32'
    );
    assert.equal(proxyListToText([]), '');
    assert.equal(proxyListToText(undefined), '');
  });

  it('points out the first entry that is not an address or range', () => {
    assert.equal(
      firstNonAddress(
        '198.51.100.20, 198.51.100.0/24 10.0.0.0/255.0.0.0 2001:db8::1 2001:db8::/32 ::ffff:198.51.100.20'
      ),
      undefined
    );
    assert.equal(firstNonAddress(''), undefined);
    assert.equal(firstNonAddress(undefined), undefined);
    for (const bad of [
      'proxy.example.com',
      'loopback',
      '198.51.100',
      '198.51.100.256',
      '198.51.100.0/33',
      '198.51.100.0/0',
      '198.51.100.0/',
      '198.51.100.0/255.0.255.0',
      '198.51.100.0/0.0.0.0',
      '2001:db8::/129',
      '2001:db8:::1',
    ]) {
      assert.equal(firstNonAddress(`198.51.100.20, ${bad}, nonsense`), bad);
    }
  });
});
