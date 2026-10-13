import { MediaType } from '@server/constants/media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { itemKeys } from './itemKeys';

describe('itemKeys', () => {
  it('keys an item by what it is, wherever it sits in the list', () => {
    const film = {
      title: 'Film',
      searchable: { mediaId: 7, is4k: false, mediaType: MediaType.MOVIE },
    };
    const other = { title: 'Other', href: '/tv/3' };
    const [first] = itemKeys([film, other]);
    const [, moved] = itemKeys([other, film]);
    assert.equal(first, moved);
    assert.notEqual(
      itemKeys([film])[0],
      itemKeys([{ ...film, searchable: { ...film.searchable, is4k: true } }])[0]
    );
  });

  it('gives the same item twice different keys', () => {
    const keys = itemKeys([{ title: 'A' }, { title: 'A' }, { title: 'B' }]);
    assert.equal(new Set(keys).size, 3);
  });
});
