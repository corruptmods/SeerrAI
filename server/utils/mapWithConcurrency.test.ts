import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * The cap is what stops Plex Discover metadata lookups going out all at once
 * and timing out the watchlist sync (seerr-team/seerr#3235). Everything else
 * in the fork that fans out to an external API relies on it too.
 */
describe('mapWithConcurrency', () => {
  /** Runs `fn` over `items` while recording how many ran at once. */
  const track = async <T, R>(
    items: readonly T[],
    limit: number,
    work: (item: T) => Promise<R>
  ) => {
    let running = 0;
    let peak = 0;

    const results = await mapWithConcurrency(items, limit, async (item) => {
      running++;
      peak = Math.max(peak, running);

      try {
        return await work(item);
      } finally {
        running--;
      }
    });

    return { results, peak };
  };

  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('never runs more than the limit at once', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);

    const { peak } = await track(items, 5, async (i) => {
      await delay(5);

      return i;
    });

    assert.ok(peak <= 5, `ran ${peak} at once, limit was 5`);
    assert.equal(peak, 5, 'and should actually use the full limit');
  });

  it('returns results in input order, not completion order', async () => {
    const items = [40, 5, 30, 1, 20];

    // Deliberately finishing out of order.
    const { results } = await track(items, 3, async (ms) => {
      await delay(ms);

      return ms;
    });

    assert.deepEqual(results, items);
  });

  it('handles an empty list', async () => {
    const { results, peak } = await track([], 5, async () => 1);

    assert.deepEqual(results, []);
    assert.equal(peak, 0);
  });

  it('does not spawn more workers than there are items', async () => {
    const { peak } = await track([1, 2], 10, async (i) => {
      await delay(5);

      return i;
    });

    assert.ok(peak <= 2, `two items should never run ${peak} at once`);
  });

  it('treats a limit below one as serial', async () => {
    const { peak, results } = await track([1, 2, 3], 0, async (i) => {
      await delay(2);

      return i;
    });

    assert.equal(peak, 1, 'a nonsensical limit must not mean unbounded');
    assert.deepEqual(results, [1, 2, 3]);
  });

  it('propagates a failure rather than swallowing it', async () => {
    await assert.rejects(
      () =>
        mapWithConcurrency([1, 2, 3], 2, async (i) => {
          if (i === 2) {
            throw new Error('lookup failed');
          }

          return i;
        }),
      /lookup failed/
    );
  });

  it('runs every item exactly once', async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const seen: number[] = [];

    await mapWithConcurrency(items, 4, async (i) => {
      seen.push(i);

      return i;
    });

    assert.equal(seen.length, items.length);
    assert.equal(new Set(seen).size, items.length, 'no item run twice');
  });
});
