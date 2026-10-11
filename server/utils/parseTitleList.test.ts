import { parseTitleList } from '@server/utils/parseTitleList';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * The parser takes whatever someone pasted out of a notes app. The cases here
 * are the shapes real lists actually contain — bullets, checkboxes, numbering,
 * years written either way, and personal asides after a dash.
 */
describe('parseTitleList', () => {
  it('strips bullets, numbering and checkboxes', () => {
    const parsed = parseTitleList(
      ['- The Matrix', '• Practical Magic', '1. Heat', '[x] Arrival'].join('\n')
    );

    assert.deepEqual(
      parsed.map((line) => line.title),
      ['The Matrix', 'Practical Magic', 'Heat', 'Arrival']
    );
  });

  it('reads a year in brackets or bare, and removes it from the title', () => {
    const [bracketed, bare] = parseTitleList('The Matrix (1999)\nHeat 1995');

    assert.equal(bracketed.title, 'The Matrix');
    assert.equal(bracketed.year, 1999);
    assert.equal(bare.title, 'Heat');
    assert.equal(bare.year, 1995);
  });

  it('drops a personal note after a dash', () => {
    const [line] = parseTitleList('Insidious — want to watch with Jordan');

    assert.equal(line.title, 'Insidious');
  });

  it('keeps a hyphen that is part of the title', () => {
    const [line] = parseTitleList('Spider-Man: Brand New Day');

    assert.equal(line.title, 'Spider-Man: Brand New Day');
  });

  it('ignores section headings and blank lines', () => {
    const parsed = parseTitleList(
      ['Movies:', '', 'The Matrix', '   ', 'Arrival'].join('\n')
    );

    assert.deepEqual(
      parsed.map((line) => line.title),
      ['The Matrix', 'Arrival']
    );
  });

  it('removes duplicates, matching on title and year together', () => {
    const parsed = parseTitleList(
      ['The Matrix (1999)', 'the matrix (1999)', 'The Matrix (2003)'].join('\n')
    );

    // Same title and year is a duplicate; a different year is a different film.
    assert.equal(parsed.length, 2);
    assert.deepEqual(
      parsed.map((line) => line.year),
      [1999, 2003]
    );
  });

  it('flags set wording without swallowing the title', () => {
    const cases: [string, string][] = [
      ['Pitch Perfect series', 'Pitch Perfect'],
      ['The Bourne trilogy', 'The Bourne'],
      ['John Wick collection', 'John Wick'],
      ['all Harry Potter movies', 'Harry Potter'],
    ];

    for (const [input, expected] of cases) {
      const [line] = parseTitleList(input);

      assert.equal(line.title, expected, `title for "${input}"`);
      assert.equal(line.collectionHint, true, `hint for "${input}"`);
    }
  });

  it('does not flag a title that merely ends in a similar word', () => {
    const [line] = parseTitleList('Hereditary');

    assert.equal(line.collectionHint, undefined);
  });

  it('keeps the original line so the user can see what was matched', () => {
    const [line] = parseTitleList('  [x] The Matrix (1999)  ');

    assert.equal(line.raw, '[x] The Matrix (1999)');
    assert.equal(line.title, 'The Matrix');
  });

  it('returns nothing for text with no titles in it', () => {
    assert.deepEqual(parseTitleList('   \n\n  '), []);
  });
});
