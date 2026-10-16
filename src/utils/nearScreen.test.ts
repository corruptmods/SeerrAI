import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isOnScreen, pictureLoading } from './nearScreen';

describe('isOnScreen', () => {
  const box = (top: number, left: number, size = 100) => ({
    top,
    bottom: top + size,
    left,
    right: left + size,
  });

  it('is on a screen it overlaps', () => {
    assert.equal(isOnScreen(box(10, 10), 390, 844), true);
    assert.equal(isOnScreen(box(-50, 10), 390, 844), true, 'partly above');
    assert.equal(isOnScreen(box(800, 350), 390, 844), true, 'in a corner');
  });

  it('is not, below or above the screen', () => {
    assert.equal(isOnScreen(box(844, 10), 390, 844), false);
    assert.equal(isOnScreen(box(1500, 10), 390, 844), false);
    assert.equal(isOnScreen(box(-100, 10), 390, 844), false);
  });

  it('is not, further along a row than the screen is wide', () => {
    assert.equal(isOnScreen(box(10, 390), 390, 844), false);
    assert.equal(isOnScreen(box(10, -100), 390, 844), false);
  });
});

describe('pictureLoading', () => {
  it('leaves a picture outside any card as it asked', () => {
    assert.deepEqual(pictureLoading(null), { loading: undefined });
    assert.deepEqual(pictureLoading(null, { loading: 'lazy' }), {
      loading: 'lazy',
    });
  });

  it('leaves it to the browser until the card is near the screen', () => {
    assert.deepEqual(pictureLoading({ near: false, onScreen: false }), {
      loading: 'lazy',
    });
  });

  it('loads it at once when the card is near, without jumping the queue', () => {
    assert.deepEqual(pictureLoading({ near: true, onScreen: false }), {
      loading: 'eager',
    });
  });

  it('loads it first when the card was already on the screen', () => {
    assert.deepEqual(pictureLoading({ near: true, onScreen: true }), {
      loading: 'eager',
      fetchPriority: 'high',
    });
  });

  it('always loads one the page needs at once, first', () => {
    for (const nearness of [null, { near: false, onScreen: false }]) {
      assert.deepEqual(pictureLoading(nearness, { urgent: true }), {
        loading: 'eager',
        fetchPriority: 'high',
      });
    }
  });

  it('keeps a picture asked for eagerly eager', () => {
    assert.deepEqual(
      pictureLoading({ near: false, onScreen: false }, { loading: 'eager' }),
      { loading: 'eager' }
    );
  });
});
