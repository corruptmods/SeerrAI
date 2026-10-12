import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultDiscoverNetworks,
  isDefaultDiscoverNetworks,
  networkLogoUrl,
  parseDiscoverNetworks,
  serializeDiscoverNetworks,
} from './networks';

/*
 * The Networks row as the page reads it: the admin's list when it is a good
 * one, the default list otherwise, and an empty list kept as empty.
 */

describe('the Networks row’s list', () => {
  it('is the default list when none is set or the one set is no good', () => {
    for (const data of [undefined, null, '', 'not json', '{}', '[{"id":1}]']) {
      assert.equal(parseDiscoverNetworks(data), defaultDiscoverNetworks);
    }
    // Over the limit is no good either.
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      id: i + 1,
      name: `N${i + 1}`,
      logoPath: '/l.png',
    }));
    assert.equal(
      parseDiscoverNetworks(JSON.stringify(tooMany)),
      defaultDiscoverNetworks
    );
  });

  it('is the admin’s own list, trimmed and without repeats, or empty', () => {
    assert.deepEqual(
      parseDiscoverNetworks(
        JSON.stringify([
          { id: 2697, name: ' Acorn TV ', logoPath: '/acorn.png' },
          { id: 2697, name: 'Again', logoPath: '/again.png' },
        ])
      ),
      [{ id: 2697, name: 'Acorn TV', logoPath: '/acorn.png' }]
    );
    assert.deepEqual(parseDiscoverNetworks('[]'), []);
  });

  it('saves the default list as nothing, and any other as itself', () => {
    assert.equal(serializeDiscoverNetworks(defaultDiscoverNetworks), null);
    assert.ok(isDefaultDiscoverNetworks([...defaultDiscoverNetworks]));
    const mine = [{ id: 2697, name: 'Acorn TV', logoPath: '/acorn.png' }];
    assert.equal(serializeDiscoverNetworks(mine), JSON.stringify(mine));
    assert.equal(serializeDiscoverNetworks([]), '[]');
  });

  it('every default network passes the rules the server saves by', () => {
    assert.deepEqual(
      parseDiscoverNetworks(JSON.stringify(defaultDiscoverNetworks)),
      defaultDiscoverNetworks
    );
  });

  it('draws logos the way the image proxy fetches them', () => {
    assert.match(
      networkLogoUrl('/wwemzKWzjKYJFfCeiB57q3r4Bcm.png'),
      /^https:\/\/image\.tmdb\.org\/t\/p\/[\w(),]+\/[\w-]+\.(?:jpe?g|png|svg|webp)$/
    );
  });
});
