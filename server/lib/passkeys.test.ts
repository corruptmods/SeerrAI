import { relyingParty } from '@server/lib/passkeys';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

/*
 * Which site a passkey belongs to, and which page addresses may use it.
 */

const request = (host: string, protocol: 'http' | 'https') =>
  ({
    hostname: host.split(':')[0],
    protocol,
    get: (header: string) => (header.toLowerCase() === 'host' ? host : ''),
  }) as never;

describe('the site a passkey belongs to', () => {
  const saved = getSettings().main.applicationUrl;
  afterEach(() => {
    getSettings().main.applicationUrl = saved;
  });

  it('uses the Application URL when it is set', () => {
    getSettings().main.applicationUrl = 'https://requests.example.com/';
    const rp = relyingParty(request('10.0.0.5:5055', 'http'));
    assert.equal(rp.rpID, 'requests.example.com');
    assert.equal(rp.origin, 'https://requests.example.com');
  });

  it('works behind an HTTPS proxy Seerr was not told to trust', () => {
    getSettings().main.applicationUrl = '';
    // The browser is on https; the proxy forwards plain http.
    const rp = relyingParty(request('requests.example.com', 'http'));
    assert.equal(rp.rpID, 'requests.example.com');
    assert.ok(
      ([] as string[])
        .concat(rp.origin)
        .includes('https://requests.example.com')
    );
  });

  it('never accepts a page on another host', () => {
    getSettings().main.applicationUrl = '';
    const rp = relyingParty(request('requests.example.com:8443', 'https'));
    assert.deepEqual(([] as string[]).concat(rp.origin).sort(), [
      'http://requests.example.com:8443',
      'https://requests.example.com:8443',
    ]);
  });
});
