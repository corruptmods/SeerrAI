import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runRefreshMs } from './refresh';

describe('runRefreshMs', () => {
  it('checks often while a run works, and a held run every 10 seconds', () => {
    assert.equal(
      runRefreshMs(['done', 'running'], { working: 2000, idle: 0 }),
      2000
    );
    assert.equal(runRefreshMs(['queued'], { working: 2000, idle: 0 }), 2000);
    assert.equal(
      runRefreshMs(['done', 'held'], { working: 2000, idle: 0 }),
      10_000
    );
    assert.equal(
      runRefreshMs(['held'], { working: 3000, idle: 30_000 }),
      10_000
    );
  });

  it('otherwise waits as long as the page asks', () => {
    assert.equal(
      runRefreshMs(['done', 'waiting'], { working: 2000, idle: 0 }),
      0
    );
    assert.equal(runRefreshMs([], { working: 3000, idle: 30_000 }), 30_000);
  });
});
