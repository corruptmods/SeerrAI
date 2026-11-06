import { MediaStatus } from '@server/constants/media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardRequestable, outsideLibraries } from './outsideLibraries';

describe('titles outside the viewer’s libraries', () => {
  it('are told apart by copy', () => {
    const media = { outsideLibraries: true };
    assert.equal(outsideLibraries(media), true);
    assert.equal(outsideLibraries(media, true), false);
    assert.equal(outsideLibraries({ outsideLibraries4k: true }, true), true);
    assert.equal(outsideLibraries(undefined), false);
  });

  it('offer no Request on a card', () => {
    assert.equal(cardRequestable(MediaStatus.UNKNOWN, true), false);
    assert.equal(cardRequestable(undefined, true), false);
  });

  it('leave cards of other titles as they were', () => {
    assert.equal(cardRequestable(undefined), true);
    assert.equal(cardRequestable(MediaStatus.UNKNOWN), true);
    assert.equal(cardRequestable(MediaStatus.DELETED), true);
    assert.equal(cardRequestable(MediaStatus.AVAILABLE), false);
    assert.equal(cardRequestable(MediaStatus.PENDING), false);
  });
});
