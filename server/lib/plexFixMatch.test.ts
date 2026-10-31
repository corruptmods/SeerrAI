import type { PlexLibraryItem, PlexMatchResult } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import {
  FIXES_PATH,
  autoFix,
  canFix,
  fixMatch,
  forgetAutoTriedForTests,
  forgetFixesForTests,
  recentFixes,
  setFixTimingForTests,
  undoFix,
} from '@server/lib/plexFixMatch';
import type { PlexMatchProblem } from '@server/lib/plexMatchCheck';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * A wrong Plex match fixed from Seerr AI: looked up in Plex by the id
 * Radarr has, never by name, matched, and read back. A match Plex then
 * shows as another title is put back, and every fix can be undone.
 */

setupTestDb();

const WRONG = 'plex://movie/wrong';
const RIGHT = 'plex://movie/right';

/** Border Feud (2024) in Radarr, matched by Plex to another film. */
const problem = (change: Partial<PlexMatchProblem> = {}): PlexMatchProblem => ({
  kind: 'movie',
  folder: 'Border Feud (2024)',
  expected: {
    title: 'Border Feud',
    year: 2024,
    tmdbId: 846213,
    imdbId: 'tt18381507',
    server: 'Radarr',
    runtime: 109,
    fileRuntime: 109,
  },
  mediaServer: 'Plex',
  matched: {
    title: 'Guerra Fronteriza',
    year: 2024,
    key: '70',
    tmdbId: 1427986,
  },
  reason: 'other',
  ...change,
});

/** What each title Plex can be matched to is, by its guid. */
const TITLES: Record<string, { title: string; year: number; ids: string[] }> = {
  [WRONG]: { title: 'Guerra Fronteriza', year: 2024, ids: ['tmdb://1427986'] },
  [RIGHT]: { title: 'Border Feud', year: 2024, ids: ['tmdb://846213'] },
  'plex://movie/other': {
    title: 'Border Feud',
    year: 2024,
    ids: ['tmdb://5'],
  },
};

const asItem = (guid: string): PlexLibraryItem =>
  ({
    ratingKey: '70',
    librarySectionID: 1,
    title: TITLES[guid].title,
    year: TITLES[guid].year,
    guid,
    type: 'movie',
    Guid: TITLES[guid].ids.map((id) => ({ id })),
    Media: [],
  }) as unknown as PlexLibraryItem;

/** A Plex with item 70 matched to `guid`, offering `results` by search. */
/**
 * A Plex with item 70 matched to `guid`, offering `results` by search. As
 * Plex does, a new match shows its guid, name and year at once, but keeps
 * the old title's ids for `lag` reads (forever, with Infinity) while it
 * fetches the new title's details.
 */
const plexWith = (
  guid: string,
  results: Record<string, PlexMatchResult[]>,
  lag = 0
) => {
  let item = asItem(guid);
  let staleReads = 0;
  let fetched = item;
  const calls: string[] = [];
  mock.method(PlexAPI.prototype, 'getMatchItem', async (key: string) => {
    if (key !== '70') return undefined;
    if (staleReads > 0) {
      staleReads -= 1;
      if (staleReads === 0) item = fetched;
    }
    return item;
  });
  mock.method(PlexAPI.prototype, 'getLibraries', async () => [
    {
      key: '1',
      type: 'movie',
      title: 'Movies',
      agent: 'tv.plex.agents.movie',
      language: 'en-US',
    },
  ]);
  mock.method(
    PlexAPI.prototype,
    'findMatches',
    async (_key: string, term: string, library?: { agent?: string }) => {
      calls.push(`find ${term} (${library?.agent})`);
      return results[term] ?? [];
    }
  );
  mock.method(
    PlexAPI.prototype,
    'setMatch',
    async (_key: string, to: { guid: string }) => {
      calls.push(`match ${to.guid}`);
      fetched = asItem(to.guid);
      if (lag > 0) {
        staleReads = lag;
        item = { ...fetched, Guid: item.Guid };
      } else {
        item = fetched;
      }
    }
  );
  mock.method(PlexAPI.prototype, 'unmatch', async () => {
    calls.push('unmatch');
  });
  return { calls, now: () => item };
};

const offers = (guid: string): PlexMatchResult[] => [
  { guid, name: TITLES[guid].title, year: TITLES[guid].year, score: 100 },
];

beforeEach(async () => {
  setFixTimingForTests(50, 1);
  const settings = getSettings();
  settings.plex.ip = 'plex.invalid';
  settings.main.matchFix = true;
  settings.main.matchFixAuto = false;
  await getRepository(User).update(1, { plexToken: 'token' });
});

afterEach(async () => {
  mock.restoreAll();
  forgetFixesForTests();
  forgetAutoTriedForTests();
  await fs.rm(FIXES_PATH, { force: true });
  const settings = getSettings();
  settings.plex.ip = '';
  settings.main.matchFix = true;
  settings.main.matchFixAuto = false;
});

describe('fixing a wrong Plex match', () => {
  it('matches it to what Plex finds by the id Radarr has, and keeps the fix to undo', async () => {
    const plex = plexWith(WRONG, { 'tmdb-846213': offers(RIGHT) });

    const outcome = await fixMatch(problem(), 2);
    assert.equal(outcome.state, 'fixed');
    assert.deepEqual(plex.calls, [
      'find tmdb-846213 (tv.plex.agents.movie)',
      `match ${RIGHT}`,
    ]);
    assert.equal(plex.now().guid, RIGHT);

    const [fix] = await recentFixes();
    assert.equal(fix.by, 2);
    assert.equal(fix.confirmed, true, 'read back with the TMDB id');
    assert.deepEqual(fix.from, {
      guid: WRONG,
      title: 'Guerra Fronteriza',
      year: 2024,
    });
    assert.equal(fix.to.title, 'Border Feud');

    const undone = await undoFix(fix.id, 2);
    assert.ok(undone.undoneAt);
    assert.equal(plex.now().guid, WRONG, 'back as Plex had it');
    await assert.rejects(undoFix(fix.id, 2), /undone already/);
  });

  it('looks it up by its IMDb id when TMDB finds nothing, never by its name', async () => {
    const plex = plexWith(WRONG, { 'imdb-tt18381507': offers(RIGHT) });
    const outcome = await fixMatch(problem(), 2);
    assert.equal(outcome.state, 'fixed');
    assert.deepEqual(plex.calls, [
      'find tmdb-846213 (tv.plex.agents.movie)',
      'find imdb-tt18381507 (tv.plex.agents.movie)',
      `match ${RIGHT}`,
    ]);
  });

  it('says so when Plex finds nothing, and changes nothing', async () => {
    const plex = plexWith(WRONG, {});
    const outcome = await fixMatch(problem(), 2);
    assert.deepEqual(outcome, {
      state: 'notFound',
      searched: ['tmdb-846213', 'imdb-tt18381507'],
    });
    assert.ok(!plex.calls.some((c) => c.startsWith('match')));
    assert.equal((await recentFixes()).length, 0);
  });

  it('waits for Plex to fetch the new title before judging it', async () => {
    const plex = plexWith(WRONG, { 'tmdb-846213': offers(RIGHT) }, 3);
    const outcome = await fixMatch(problem(), 2);
    assert.equal(outcome.state, 'fixed');
    assert.equal(
      outcome.state === 'fixed' && outcome.fix.confirmed,
      true,
      'confirmed once its ids were the new title’s'
    );
    assert.deepEqual(
      plex.calls.filter((c) => c.startsWith('match')),
      [`match ${RIGHT}`],
      'never put back'
    );
  });

  it('never puts a match back over the old title’s ids, however long Plex takes', async () => {
    const plex = plexWith(WRONG, { 'tmdb-846213': offers(RIGHT) }, Infinity);
    const outcome = await fixMatch(problem(), 2);
    assert.equal(outcome.state, 'fixed');
    assert.equal(outcome.state === 'fixed' && outcome.fix.confirmed, false);
    assert.equal(plex.now().guid, RIGHT);
    assert.deepEqual(
      plex.calls.filter((c) => c.startsWith('match')),
      [`match ${RIGHT}`]
    );
  });

  it('puts the old match back when Plex takes it as another title', async () => {
    const plex = plexWith(
      WRONG,
      { 'tmdb-846213': offers('plex://movie/other') },
      2
    );
    const outcome = await fixMatch(problem(), 2);
    assert.equal(outcome.state, 'putBack');
    assert.deepEqual(plex.calls.slice(-2), [
      'match plex://movie/other',
      `match ${WRONG}`,
    ]);
    assert.equal(plex.now().guid, WRONG);
    assert.equal((await recentFixes()).length, 0);
  });

  it('leaves alone what Plex has right already, or no longer has', async () => {
    const plex = plexWith(RIGHT, { 'tmdb-846213': offers(RIGHT) });
    assert.deepEqual(await fixMatch(problem(), 2), { state: 'right' });
    assert.deepEqual(
      await fixMatch(
        problem({ matched: { ...problem().matched, key: '71' } }),
        2
      ),
      { state: 'gone' }
    );
    assert.equal(plex.calls.length, 0);
  });

  it('won’t fix a film whose file is another film’s length, music, or another server’s', () => {
    assert.equal(canFix(problem()), true);
    assert.equal(
      canFix(
        problem({
          expected: { ...problem().expected, runtime: 90, fileRuntime: 21 },
        })
      ),
      false,
      'replaced in Radarr instead'
    );
    assert.equal(canFix(problem({ mediaServer: 'Jellyfin' })), false);
    assert.equal(canFix(problem({ kind: 'music' })), false);
  });
});

describe('fixing a wrong Plex match by itself', () => {
  it('is off until it is turned on, and a fix that didn’t work isn’t tried again for a while', async () => {
    const plex = plexWith(WRONG, {});
    assert.equal(await autoFix(problem(), 'k'), undefined);
    assert.equal(plex.calls.length, 0);

    getSettings().main.matchFixAuto = true;
    assert.equal((await autoFix(problem(), 'k'))?.state, 'notFound');
    const asked = plex.calls.length;
    assert.equal(await autoFix(problem(), 'k'), undefined);
    assert.equal(plex.calls.length, asked);

    getSettings().main.matchFix = false;
    assert.equal(
      await autoFix(problem(), 'other'),
      undefined,
      'nor with fixing off'
    );
  });

  it('keeps a fix it made as its own', async () => {
    getSettings().main.matchFixAuto = true;
    plexWith(WRONG, { 'tmdb-846213': offers(RIGHT) });
    assert.equal((await autoFix(problem(), 'k'))?.state, 'fixed');
    const [fix] = await recentFixes();
    assert.equal(fix.by, 'auto');
  });
});
