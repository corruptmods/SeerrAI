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
      [
        '- The Mazewright',
        '• Practical Alchemy',
        '1. Scorch',
        '[x] Brightfall',
      ].join('\n')
    );

    assert.deepEqual(
      parsed.map((line) => line.title),
      ['The Mazewright', 'Practical Alchemy', 'Scorch', 'Brightfall']
    );
  });

  it('reads a year in brackets or bare, and removes it from the title', () => {
    const [bracketed, bare] = parseTitleList(
      'The Mazewright (1999)\nScorch 1995'
    );

    assert.equal(bracketed.title, 'The Mazewright');
    assert.equal(bracketed.year, 1999);
    assert.equal(bare.title, 'Scorch');
    assert.equal(bare.year, 1995);
  });

  it('drops a personal note after a dash', () => {
    const [line] = parseTitleList('Vesperline — want to watch with Jordan');

    assert.equal(line.title, 'Vesperline');
  });

  it('keeps a hyphen that is part of the title', () => {
    const [line] = parseTitleList('Web-Weaver: Fresh New Dawn');

    assert.equal(line.title, 'Web-Weaver: Fresh New Dawn');
  });

  it('ignores section headings and blank lines', () => {
    const parsed = parseTitleList(
      ['Movies:', '', 'The Mazewright', '   ', 'Brightfall'].join('\n')
    );

    assert.deepEqual(
      parsed.map((line) => line.title),
      ['The Mazewright', 'Brightfall']
    );
  });

  it('removes duplicates, matching on title and year together', () => {
    const parsed = parseTitleList(
      [
        'The Mazewright (1999)',
        'the mazewright (1999)',
        'The Mazewright (2003)',
      ].join('\n')
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
      ['Harmony Lane series', 'Harmony Lane'],
      ['The Kessler trilogy', 'The Kessler'],
      ['Rex Calder collection', 'Rex Calder'],
      ['all Milo Thistle movies', 'Milo Thistle'],
    ];

    for (const [input, expected] of cases) {
      const [line] = parseTitleList(input);

      assert.equal(line.title, expected, `title for "${input}"`);
      assert.equal(line.collectionHint, true, `hint for "${input}"`);
    }
  });

  it('does not flag a title that merely ends in a similar word', () => {
    const [line] = parseTitleList('Inheritor');

    assert.equal(line.collectionHint, undefined);
  });

  it('keeps the original line so the user can see what was matched', () => {
    const [line] = parseTitleList('  [x] The Mazewright (1999)  ');

    assert.equal(line.raw, '[x] The Mazewright (1999)');
    assert.equal(line.title, 'The Mazewright');
  });

  it('returns nothing for text with no titles in it', () => {
    assert.deepEqual(parseTitleList('   \n\n  '), []);
  });
});
