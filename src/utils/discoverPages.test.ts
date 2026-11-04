import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { START_PAGES, listProgress } from './discoverPages';

const page = (totalPages: number, totalResults = totalPages * 20) => ({
  totalPages,
  totalResults,
});

describe('listProgress', () => {
  it('shows the first page while the rest it starts with are asked for', () => {
    const progress = listProgress({
      pages: [page(40)],
      loadingFirst: false,
      size: 1,
      titlesShown: 20,
      shortPages: false,
    });
    assert.equal(progress.starting, true);
    assert.equal(progress.isEmpty, false);
  });

  it('is not empty while those pages are still to come, all hidden so far', () => {
    const progress = listProgress({
      pages: [page(40)],
      loadingFirst: false,
      size: START_PAGES,
      titlesShown: 0,
      shortPages: false,
    });
    assert.equal(progress.isEmpty, false);
    assert.equal(progress.isReachingEnd, false);
  });

  it('is empty once they are in and none is left to show', () => {
    const progress = listProgress({
      pages: [page(40), page(40), page(40)],
      loadingFirst: false,
      size: START_PAGES,
      titlesShown: 0,
      shortPages: false,
    });
    assert.equal(progress.starting, false);
    assert.equal(progress.isEmpty, true);
  });

  it('asks for no more pages than the list has', () => {
    const progress = listProgress({
      pages: [page(2, 31), page(2, 31)],
      loadingFirst: false,
      size: START_PAGES,
      titlesShown: 31,
      shortPages: false,
    });
    assert.equal(progress.starting, false);
    assert.equal(progress.isReachingEnd, true);
  });

  it('keeps going past a short page in the middle of a list', () => {
    const progress = listProgress({
      pages: [page(300, 5990), page(300, 5990), page(300, 5990)],
      loadingFirst: false,
      size: START_PAGES,
      titlesShown: 52,
      shortPages: false,
    });
    assert.equal(progress.isReachingEnd, false);
  });

  it('ends at the last page the server counts', () => {
    const progress = listProgress({
      pages: [page(3, 300), page(3, 300), page(3, 300)],
      loadingFirst: false,
      size: START_PAGES,
      titlesShown: 60,
      shortPages: false,
    });
    assert.equal(progress.isReachingEnd, true);
  });

  it('has nothing more when the first page failed', () => {
    const progress = listProgress({
      pages: undefined,
      loadingFirst: false,
      size: 1,
      titlesShown: 0,
      shortPages: false,
    });
    assert.equal(progress.isEmpty, true);
    assert.equal(progress.isReachingEnd, true);
  });

  it('is neither empty nor ended while the first page loads', () => {
    const progress = listProgress({
      pages: undefined,
      loadingFirst: true,
      size: 1,
      titlesShown: 0,
      shortPages: false,
    });
    assert.deepEqual(progress, {
      starting: false,
      isEmpty: false,
      isReachingEnd: false,
    });
  });
});
