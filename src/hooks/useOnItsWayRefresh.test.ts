import { MediaStatus } from '@server/constants/media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pageRefreshMs } from './useOnItsWayRefresh';

const page = (...mediaInfo: Record<string, unknown>[]) => ({
  page: 1,
  totalPages: 1,
  totalResults: mediaInfo.length,
  results: mediaInfo.map((info, i) => ({
    id: i + 1,
    mediaType: 'movie',
    mediaInfo: info,
  })),
});

describe('how soon a page of titles is read again', () => {
  it('soon while a title on it is downloading', () => {
    assert.equal(
      pageRefreshMs(
        page(
          { status: MediaStatus.AVAILABLE },
          { status: MediaStatus.PROCESSING, downloadStatus: [{}] }
        )
      ),
      15_000
    );
    assert.equal(
      pageRefreshMs(
        page({ status: MediaStatus.UNKNOWN, downloadStatus4k: [{}] })
      ),
      15_000
    );
  });

  it('less often while one is on its way but not downloading', () => {
    assert.equal(
      pageRefreshMs(page({ status: MediaStatus.PROCESSING })),
      30_000
    );
    assert.equal(
      pageRefreshMs(
        page({
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.PROCESSING,
        })
      ),
      30_000
    );
  });

  it('never when everything on it has arrived or was never asked for', () => {
    assert.equal(
      pageRefreshMs(
        page(
          { status: MediaStatus.AVAILABLE, downloadStatus: [] },
          { status: MediaStatus.PENDING },
          {}
        )
      ),
      0
    );
    assert.equal(pageRefreshMs({ results: [] }), 0);
    assert.equal(pageRefreshMs(undefined), 0);
    assert.equal(pageRefreshMs({ status: 500 }), 0);
  });
});
