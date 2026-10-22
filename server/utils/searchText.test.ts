import {
  matchesSearch,
  normalizeSearchText,
  searchWords,
} from '@server/utils/searchText';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('filter matching', () => {
  const text = normalizeSearchText(
    'Nova Rift Garrick Holt Tam Vexley Vivian Rustamson Rosélie Web-Weaver'
  );
  const find = (query: string) => matchesSearch(text, searchWords(query));

  it('matches whole names and the start of words', () => {
    assert.ok(find('garrick holt'));
    assert.ok(find('garr'));
    assert.ok(find('tam'));
  });

  it('does not match the middle of a word', () => {
    // "tam" is inside Rustamson, but only the start of a word counts.
    assert.ok(!matchesSearch(normalizeSearchText('Vivian Rustamson'), ['tam']));
  });

  it('ignores case, accents and punctuation', () => {
    assert.ok(find('ROSELIE'));
    assert.ok(find('web weaver'));
    assert.ok(find('webweaver') === false);
  });

  it('needs every word', () => {
    assert.ok(find('holt vexley'));
    assert.ok(!find('holt batman'));
  });

  it('treats an empty or blank filter as no words', () => {
    assert.deepEqual(searchWords('   '), []);
    assert.deepEqual(searchWords(' Ned  Barlow! '), ['ned', 'barlow']);
  });
});
