import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import blocklistedTagsProcessor from '@server/job/blocklistedTagsProcessor';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/*
 * Process Blocklisted Tags: titles a tag matches are blocklisted once and kept
 * as they are, rather than deleted and recreated on every run.
 */

/** Movie TMDB ids each keyword finds; TV finds none. */
let byKeyword: Record<string, number[]> = {};
let failing = false;

const page = (ids: number[]) => ({
  page: 1,
  total_pages: 1,
  total_results: ids.length,
  results: ids.map((id) => ({ id, title: `Film ${id}` })),
});

// Assigned in the constructor, so a prototype accessor takes them over.
for (const [name, value] of [
  [
    'getDiscoverMovies',
    async ({ keywords }: { keywords: string }) => {
      if (failing) throw new Error('TMDB is down');
      return page(byKeyword[keywords] ?? []);
    },
  ],
  ['getDiscoverTv', async () => page([])],
] as const) {
  Object.defineProperty(TheMovieDb.prototype, name, {
    configurable: true,
    set() {},
    get() {
      return value;
    },
  });
}
TheMovieDb.prototype.getKeywordDetails = async ({ keywordId }) =>
  ({ id: keywordId, name: `keyword ${keywordId}` }) as Awaited<
    ReturnType<TheMovieDb['getKeywordDetails']>
  >;

setupTestDb();

beforeEach(() => {
  const settings = getSettings();
  settings.main.blocklistedTags = '901,902';
  settings.main.blocklistedTagsLimit = 1;
  byKeyword = { '901': [700501, 700502], '902': [700502] };
  failing = false;
});

const run = () => runWithMockTimers(() => blocklistedTagsProcessor.run());
const movie = (tmdbId: number) =>
  getRepository(Media).findOne({
    where: { tmdbId, mediaType: MediaType.MOVIE },
  });
const entry = (tmdbId: number) =>
  getRepository(Blocklist).findOne({
    where: { tmdbId, mediaType: MediaType.MOVIE },
  });

describe('Process Blocklisted Tags', () => {
  it('keeps a matched title as it is from run to run', async () => {
    await run();
    const first = await movie(700501);
    assert.equal(first?.status, MediaStatus.BLOCKLISTED);
    assert.equal((await entry(700502))?.blocklistedTags, ',901,902,');

    await run();
    const again = await movie(700501);
    assert.equal(again?.id, first?.id);
    assert.equal(again?.createdAt.getTime(), first?.createdAt.getTime());
  });

  it('leaves a title already in the library alone', async () => {
    await getRepository(Media).save(
      new Media({
        tmdbId: 700501,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      })
    );
    await run();
    assert.equal((await movie(700501))?.status, MediaStatus.AVAILABLE);
    assert.equal(await entry(700501), null);
  });

  it('removes a title once no tag matches it, and drops a tag that no longer does', async () => {
    await run();
    getSettings().main.blocklistedTags = '902';
    await run();
    assert.equal(await movie(700501), null);
    assert.equal(await entry(700501), null);
    assert.equal((await entry(700502))?.blocklistedTags, ',902,');
  });

  it('removes nothing when a lookup failed', async () => {
    await run();
    failing = true;
    await run();
    assert.ok(await entry(700501));
    assert.ok(await entry(700502));
  });
});
