import { MediaRequestStatus } from '@server/constants/media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RequestLike } from './ownDeclinedRequests';
import { ownDeclinedRequests } from './ownDeclinedRequests';

let nextId = 1;
const request = (
  status: MediaRequestStatus,
  {
    by = 1,
    is4k = false,
    reason,
    at = '2026-01-01T00:00:00.000Z',
  }: { by?: number; is4k?: boolean; reason?: string | null; at?: string } = {}
): RequestLike => ({
  id: nextId++,
  status,
  is4k,
  createdAt: at,
  requestedBy: { id: by },
  declineReason: reason,
});

/**
 * Which declined requests a person is told about on a title's page: their
 * own latest one, if it was declined with a reason.
 */
describe("a person's declined request on a title page", () => {
  it('names their latest request when it was declined with a reason', () => {
    const declined = request(MediaRequestStatus.DECLINED, {
      reason: 'Already on Netflix',
    });

    assert.deepEqual(ownDeclinedRequests([declined], 1), [
      { reason: 'Already on Netflix', is4k: false },
    ]);
  });

  it('says nothing about a decline without a reason', () => {
    assert.deepEqual(
      ownDeclinedRequests(
        [
          request(MediaRequestStatus.DECLINED, { reason: null }),
          request(MediaRequestStatus.DECLINED, { reason: '' }),
        ],
        1
      ),
      []
    );
  });

  it("never shows someone else's", () => {
    const theirs = request(MediaRequestStatus.DECLINED, {
      by: 2,
      reason: 'Not this one',
    });

    assert.deepEqual(ownDeclinedRequests([theirs], 1), []);
    assert.deepEqual(ownDeclinedRequests([theirs], undefined), []);
  });

  it('is left behind once they ask again', () => {
    const declined = request(MediaRequestStatus.DECLINED, {
      reason: 'Already on Netflix',
      at: '2026-01-01T00:00:00.000Z',
    });
    const again = request(MediaRequestStatus.PENDING, {
      at: '2026-02-01T00:00:00.000Z',
    });

    assert.deepEqual(ownDeclinedRequests([again, declined], 1), []);
  });

  it('tells a 4K request apart from the other', () => {
    const declined4k = request(MediaRequestStatus.DECLINED, {
      is4k: true,
      reason: 'No room for 4K',
      at: '2026-01-01T00:00:00.000Z',
    });
    const approved = request(MediaRequestStatus.APPROVED, {
      at: '2026-02-01T00:00:00.000Z',
    });

    assert.deepEqual(ownDeclinedRequests([approved, declined4k], 1), [
      { reason: 'No room for 4K', is4k: true },
    ]);
  });

  it('takes the later of two made at the same moment by id', () => {
    const declined = request(MediaRequestStatus.DECLINED, {
      reason: 'Older',
    });
    const newer = request(MediaRequestStatus.DECLINED, { reason: 'Newer' });

    assert.deepEqual(ownDeclinedRequests([newer, declined], 1), [
      { reason: 'Newer', is4k: false },
    ]);
  });
});
