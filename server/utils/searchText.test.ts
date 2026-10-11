import {
  matchesSearch,
  normalizeSearchText,
  searchWords,
} from '@server/utils/searchText';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('filter matching', () => {
  const text = normalizeSearchText(
    'Star Wars Harrison Ford Han Solo Scarlett Johansson Amélie Spider-Man'
  );
  const find = (query: string) => matchesSearch(text, searchWords(query));

  it('matches whole names and the start of words', () => {
    assert.ok(find('harrison ford'));
    assert.ok(find('harr'));
    assert.ok(find('han'));
  });

  it('does not match the middle of a word', () => {
    // "han" is inside Johansson, but only the start of a word counts.
    assert.ok(
      !matchesSearch(normalizeSearchText('Scarlett Johansson'), ['han'])
    );
  });

  it('ignores case, accents and punctuation', () => {
    assert.ok(find('AMELIE'));
    assert.ok(find('spider man'));
    assert.ok(find('spiderman') === false);
  });

  it('needs every word', () => {
    assert.ok(find('ford solo'));
    assert.ok(!find('ford batman'));
  });

  it('treats an empty or blank filter as no words', () => {
    assert.deepEqual(searchWords('   '), []);
    assert.deepEqual(searchWords(' Tom  Hanks! '), ['tom', 'hanks']);
  });
});
