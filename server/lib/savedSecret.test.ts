import { keptSecret, sameAddress } from '@server/lib/savedSecret';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const saved = {
  hostname: 'nas.local',
  port: 9696,
  useSsl: false,
  urlBase: '/prowlarr',
};

describe('saved secrets', () => {
  it('uses the key entered over the saved one', () => {
    assert.equal(keptSecret('new', saved, saved, 'old'), 'new');
  });

  it('keeps the saved key for the same address, however it is written', () => {
    assert.equal(
      keptSecret(
        '',
        { hostname: 'NAS.local', port: 9696, urlBase: 'prowlarr/' },
        saved,
        'old'
      ),
      'old'
    );
    assert.equal(
      sameAddress(
        { hostname: 'a', port: 1, urlBase: '/' },
        {
          hostname: 'a',
          port: 1,
        }
      ),
      true
    );
  });

  it('keeps no key for a different host, port, scheme or URL base', () => {
    for (const moved of [
      { ...saved, hostname: 'elsewhere' },
      { ...saved, port: 9697 },
      { ...saved, useSsl: true },
      { ...saved, urlBase: '' },
    ]) {
      assert.equal(
        keptSecret('', moved, saved, 'old'),
        '',
        JSON.stringify(moved)
      );
    }
    assert.equal(keptSecret('', saved, undefined, 'old'), '');
  });
});
