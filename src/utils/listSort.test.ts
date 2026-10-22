import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isListSort, sortListItems } from './listSort';

const items = [
  {
    id: 1,
    title: 'The Mazewright',
    releaseDate: '1999-03-31',
    createdAt: '2026-01-02T00:00:00Z',
  },
  {
    id: 2,
    title: 'aurelin',
    releaseDate: '1979-05-25',
    createdAt: '2026-03-01T00:00:00Z',
  },
  {
    id: 3,
    title: 'Mad Moth 2',
    releaseDate: '1981-12-24',
    createdAt: '2026-02-01T00:00:00Z',
  },
  {
    id: 4,
    title: 'Mad Moth 10',
    releaseDate: '',
    createdAt: '2026-02-15T00:00:00Z',
  },
];
const ids = (list: { id: number }[]) => list.map((i) => i.id);

describe('sortListItems', () => {
  it('shows the most recently added first by default', () => {
    assert.deepEqual(ids(sortListItems(items, 'added-desc')), [2, 4, 3, 1]);
  });

  it('can show the oldest additions first', () => {
    assert.deepEqual(ids(sortListItems(items, 'added-asc')), [1, 3, 4, 2]);
  });

  it('sorts titles ignoring case, a leading article, and by number', () => {
    // aurelin, Mad Moth 2, Mad Moth 10, (The) Mazewright
    assert.deepEqual(ids(sortListItems(items, 'title')), [2, 3, 4, 1]);
  });

  it('puts titles with no release date last in both directions', () => {
    assert.deepEqual(ids(sortListItems(items, 'release-desc')), [1, 3, 2, 4]);
    assert.deepEqual(ids(sortListItems(items, 'release-asc')), [2, 3, 1, 4]);
  });

  it('breaks ties the same way every time', () => {
    const twins = [
      { id: 7, title: 'Same', createdAt: '2026-01-01T00:00:00Z' },
      { id: 9, title: 'Same', createdAt: '2026-01-01T00:00:00Z' },
    ];
    assert.deepEqual(ids(sortListItems(twins, 'title')), [9, 7]);
    assert.deepEqual(ids(sortListItems([...twins].reverse(), 'title')), [9, 7]);
  });

  it('leaves the array it was given alone', () => {
    const copy = [...items];
    sortListItems(items, 'title');
    assert.deepEqual(items, copy);
  });

  it('recognises only the orders it offers', () => {
    assert.equal(isListSort('title'), true);
    assert.equal(isListSort('rating'), false);
    assert.equal(isListSort(null), false);
  });
});
