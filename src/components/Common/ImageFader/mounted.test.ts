import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mountedImages } from './mounted';

describe('mountedImages', () => {
  it('starts with the image showing and the next one only', () => {
    assert.deepEqual([...mountedImages(0, 6, false)].sort(), [0, 1]);
  });

  it('keeps the one fading out once the images have changed', () => {
    assert.deepEqual([...mountedImages(1, 6, true)].sort(), [0, 1, 2]);
    assert.deepEqual([...mountedImages(0, 6, true)].sort(), [0, 1, 5]);
  });

  it('mounts a single image once, and two without repeats', () => {
    assert.deepEqual([...mountedImages(0, 1, false)], [0]);
    assert.deepEqual([...mountedImages(0, 1, true)], [0]);
    assert.deepEqual([...mountedImages(1, 2, true)].sort(), [0, 1]);
  });

  it('copes with no images at all', () => {
    assert.deepEqual([...mountedImages(0, 0, false)], [0]);
  });
});
