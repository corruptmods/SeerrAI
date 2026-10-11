import { MAX_PAGE_SIZE, pageOf } from '@server/utils/pagination';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('pageOf', () => {
  it('uses the default page when none is asked for', () => {
    assert.deepEqual(pageOf({}, 10), { pageSize: 10, skip: 0 });
  });

  it('takes the page asked for', () => {
    assert.deepEqual(pageOf({ take: '25', skip: '50' }, 10), {
      pageSize: 25,
      skip: 50,
    });
  });

  it('never returns more than a hundred rows at once', () => {
    assert.equal(pageOf({ take: '100000' }, 10).pageSize, MAX_PAGE_SIZE);
  });

  it('falls back on nonsense rather than passing it on', () => {
    assert.deepEqual(pageOf({ take: 'lots', skip: '-5' }, 20), {
      pageSize: 20,
      skip: 0,
    });
    assert.equal(pageOf({ take: '0' }, 20).pageSize, 20);
    assert.equal(pageOf({ take: '12.7' }, 20).pageSize, 12);
  });
});
