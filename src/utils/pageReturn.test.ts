import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_RETURN_PAGES,
  openedByReturn,
  readPageState,
  readRowScroll,
  returnTracker,
  savePageState,
  saveRowScroll,
} from './pageReturn';

/** A sessionStorage stand-in. */
const memoryStore = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  };
};

describe('telling a return from a fresh visit', () => {
  it('counts a history step to the page as a return', () => {
    const tracker = returnTracker(() => false);
    tracker.mark('/discover/trending?mediaType=tv');
    tracker.routeStart('/discover/trending?mediaType=tv');
    assert.equal(tracker.cameBack(), true);
  });

  it('counts the next page change as a fresh visit', () => {
    const tracker = returnTracker(() => false);
    tracker.mark('/discover/trending');
    tracker.routeStart('/discover/trending');
    tracker.routeStart('/movie/7001');
    assert.equal(tracker.cameBack(), false);
  });

  it('ignores a history step the app did not follow', () => {
    const tracker = returnTracker(() => false);
    // e.g. a step only between #fragments, then a link to another page.
    tracker.mark('/discover/trending#top');
    tracker.routeStart('/search?query=glasswing');
    assert.equal(tracker.cameBack(), false);
  });

  it('matches an address with or without its fragment', () => {
    const tracker = returnTracker(() => false);
    tracker.mark('/discover/trending#top');
    tracker.routeStart('/discover/trending');
    assert.equal(tracker.cameBack(), true);
  });

  it('goes by how the document opened until the first page change', () => {
    assert.equal(returnTracker(() => true).cameBack(), true);
    assert.equal(returnTracker(() => false).cameBack(), false);
    const tracker = returnTracker(() => true);
    tracker.routeStart('/movie/7001');
    assert.equal(tracker.cameBack(), false);
  });

  it('reads a reload or a back or forward as a return', () => {
    assert.equal(openedByReturn([{ type: 'reload' }]), true);
    assert.equal(openedByReturn([{ type: 'back_forward' }]), true);
    assert.equal(openedByReturn([{ type: 'navigate' }]), false);
    assert.equal(openedByReturn([]), false);
    assert.equal(openedByReturn(undefined), false);
  });
});

describe('where a page was left', () => {
  it('keeps the scroll and the pages loaded', () => {
    const store = memoryStore();
    savePageState('list:/discover/trending', { y: 2400, pages: 6 }, store);
    assert.deepEqual(readPageState('list:/discover/trending', store), {
      y: 2400,
      pages: 6,
    });
    assert.equal(readPageState('list:/discover/movies', store), undefined);
  });

  it('loads no more than a few pages again', () => {
    const store = memoryStore();
    savePageState('list:/discover/tv', { y: 90000, pages: 40 }, store);
    assert.equal(
      readPageState('list:/discover/tv', store)?.pages,
      MAX_RETURN_PAGES
    );
  });

  it('drops a damaged record', () => {
    const store = memoryStore();
    store.setItem('page-return:list:/a', '{not json');
    store.setItem('page-return:list:/b', JSON.stringify({ y: -5, pages: 2 }));
    store.setItem('page-return:list:/c', JSON.stringify({ y: 10, pages: 0 }));
    assert.equal(readPageState('list:/a', store), undefined);
    assert.equal(readPageState('list:/b', store), undefined);
    assert.deepEqual(readPageState('list:/c', store), { y: 10 });
  });

  it('starts fresh when storage is refused', () => {
    const refusing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    assert.doesNotThrow(() => savePageState('home:/', { y: 5 }, refusing));
    assert.equal(readPageState('home:/', refusing), undefined);
    assert.doesNotThrow(() => saveRowScroll('/:trending', 300, refusing));
    assert.equal(readRowScroll('/:trending', refusing), undefined);
  });
});

describe('where a row was scrolled to', () => {
  it('keeps a row scrolled sideways', () => {
    const store = memoryStore();
    saveRowScroll('/:trending', 812.6, store);
    assert.equal(readRowScroll('/:trending', store), 813);
    assert.equal(readRowScroll('/:popular-movies', store), undefined);
  });

  it('forgets a row scrolled back to its start', () => {
    const store = memoryStore();
    saveRowScroll('/:trending', 500, store);
    saveRowScroll('/:trending', 0, store);
    assert.equal(readRowScroll('/:trending', store), undefined);
    assert.equal(store.items.size, 0);
  });
});
