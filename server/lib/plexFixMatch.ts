import type { PlexLibraryItem, PlexMatchResult } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type { PlexMatchProblem } from '@server/lib/plexMatchCheck';
import { plexIds, sameTitle } from '@server/lib/plexMatchCheck';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { MatchIds } from '@server/utils/plexMatch';
import { fileLooksWrong, fixSearch } from '@server/utils/plexMatch';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/*
 * Fixing a wrong Plex match from Seerr AI, as Plex Web's Fix Match does.
 * The title is looked up in Plex by the id Radarr or Sonarr has for it
 * ("tmdb-123"), never by its name, as two films can share a name and a
 * year. The item is matched to what that finds, then read back: if Plex
 * now has it as another title, the old match is put back. Each fix is
 * kept, so it can be undone.
 */

const LABEL = 'Match Check';

export const FIXES_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/plex-match-fixes.json`
  : path.join(__dirname, '../../config/plex-match-fixes.json');

/** Fixes kept, newest first. */
const KEEP = 50;
const TIMEOUT_MS = 20_000;
/** How long Plex gets to show the new match, and how often it's read. */
let confirmMs = 25_000;
let pollMs = 2_000;

/** For tests: no waiting on Plex. */
export const setFixTimingForTests = (confirm: number, poll: number) => {
  confirmMs = confirm;
  pollMs = poll;
};

/** Who fixed it: an admin's user id, or Seerr AI by itself. */
export type FixBy = 'auto' | number;

interface Titled {
  title: string;
  year?: number;
}

export interface MatchFix {
  id: string;
  at: string;
  by: FixBy;
  kind: 'movie' | 'series';
  folder: string;
  ratingKey: string;
  /** What Radarr or Sonarr has there. */
  expected: Titled;
  from: Titled & { guid: string };
  to: Titled & { guid: string };
  /** Plex's item was read back carrying the id it was fixed by. */
  confirmed: boolean;
  undoneAt?: string;
  undoneBy?: FixBy;
}

export type FixOutcome =
  | { state: 'fixed'; fix: MatchFix }
  /** Plex has it right already. */
  | { state: 'right' }
  /** The item is no longer on Plex. */
  | { state: 'gone' }
  /** Plex found nothing by the ids searched for. */
  | { state: 'notFound'; searched: string[] }
  /** Plex took it as another title, so the old match was put back. */
  | { state: 'putBack'; to: Titled }
  /** Plex didn't show the new match in time. */
  | { state: 'unchanged' };

/**
 * Whether Seerr AI can fix a problem: a film or series on Plex, with an id
 * to look it up by. A film whose file is far off the film's length is
 * likely another film, which fixing the match would only hide.
 */
export const canFix = (p: PlexMatchProblem): boolean =>
  (p.mediaServer ?? 'Plex') === 'Plex' &&
  (p.kind === 'movie' || p.kind === 'series') &&
  !(
    p.kind === 'movie' &&
    p.reason !== 'differentId' &&
    fileLooksWrong(p.expected)
  ) &&
  !!fixSearch(p.kind, p.expected).want;

/** Whether fixing is turned on (Health → Match Check). */
export const fixingOn = (): boolean => getSettings().main.matchFix !== false;

/** Whether new problems are fixed without an admin. */
export const fixingAuto = (): boolean =>
  fixingOn() && getSettings().main.matchFixAuto === true;

const plexClient = async (): Promise<PlexAPI> => {
  const admin = await getRepository(User).findOne({
    select: { id: true, plexToken: true },
    where: { id: 1 },
  });
  if (!admin?.plexToken || !getSettings().plex.ip) {
    throw new Error('Plex is not set up.');
  }
  return new PlexAPI({ plexToken: admin.plexToken, timeout: TIMEOUT_MS });
};

/** The agent and language of the item's library, for Fix Match's search. */
const libraryOf = async (
  plex: PlexAPI,
  item: PlexLibraryItem
): Promise<{ agent?: string; language?: string } | undefined> => {
  if (item.librarySectionID === undefined) return undefined;
  try {
    const library = (await plex.getLibraries()).find(
      (l) => String(l.key) === String(item.librarySectionID)
    );
    return library
      ? { agent: library.agent, language: library.language }
      : undefined;
  } catch {
    return undefined;
  }
};

/** A result whose year agrees, give or take one, when both have one. */
const pick = (
  results: PlexMatchResult[],
  expected: Titled
): PlexMatchResult | undefined =>
  results.find(
    (r) =>
      !!r.guid &&
      !!r.name &&
      (!expected.year || !r.year || Math.abs(r.year - expected.year) <= 1)
  );

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The same ids, all of them: Plex hasn't fetched the new title's yet. */
const sameIds = (a: MatchIds, b: MatchIds): boolean =>
  a.tmdbId === b.tmdbId && a.tvdbId === b.tvdbId && a.imdbId === b.imdbId;

/**
 * The item once Plex has fetched the new title's details. Plex shows the
 * new match (its guid, name and year) at once, but its ids (tmdb://,
 * imdb://) stay the old title's until it has fetched the new one's, which
 * takes a few seconds or more: until then they say nothing about the new
 * match. `fresh` is whether they had changed by the time it stopped
 * looking.
 */
const readBack = async (
  plex: PlexAPI,
  ratingKey: string,
  guid: string,
  kind: 'movie' | 'series',
  expected: PlexMatchProblem['expected'],
  before: MatchIds
): Promise<{ item?: PlexLibraryItem; fresh: boolean }> => {
  const freshNow = (item?: PlexLibraryItem) =>
    !!item &&
    item.guid === guid &&
    !sameIds(plexIds(item), before) &&
    sameTitle(kind, expected, plexIds(item)) !== undefined;
  const until = Date.now() + confirmMs;
  let item = await plex.getMatchItem(ratingKey);
  while (Date.now() < until && !freshNow(item)) {
    await wait(pollMs);
    item = await plex.getMatchItem(ratingKey);
  }
  return { item, fresh: freshNow(item) };
};

/** Puts an item back as it was: its old match, or none. */
const putBack = async (
  plex: PlexAPI,
  ratingKey: string,
  from: MatchFix['from']
) => {
  if (!from.guid || from.guid.startsWith('local://')) {
    await plex.unmatch(ratingKey);
  } else {
    await plex.setMatch(ratingKey, {
      guid: from.guid,
      name: from.title,
      year: from.year,
    });
  }
};

let fixes: MatchFix[] | undefined;
let writing: Promise<void> = Promise.resolve();

const readFixes = async (): Promise<MatchFix[]> => {
  if (!fixes) {
    try {
      fixes = JSON.parse(await fs.readFile(FIXES_PATH, 'utf-8')) as MatchFix[];
    } catch {
      fixes = [];
    }
  }
  return fixes;
};

const saveFixes = (next: MatchFix[]): Promise<void> => {
  fixes = next.slice(0, KEEP);
  const kept = JSON.stringify(fixes);
  writing = writing
    .then(() => fs.writeFile(FIXES_PATH, kept))
    .catch((e: unknown) => {
      logger.warn('Could not keep the list of match fixes', {
        label: LABEL,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    });
  return writing;
};

/** For tests: forgets the fixes kept in memory. */
export const forgetFixesForTests = () => {
  fixes = undefined;
};

/** The fixes made lately, newest first. */
export const recentFixes = async (limit = 10): Promise<MatchFix[]> =>
  (await readFixes()).slice(0, limit);

/** Fixes one problem in Plex: looked up by id, matched, read back. */
export const fixMatch = async (
  problem: PlexMatchProblem,
  by: FixBy
): Promise<FixOutcome> => {
  if (!canFix(problem)) {
    throw new Error('Seerr AI can’t fix this match.');
  }
  const kind = problem.kind as 'movie' | 'series';
  const { expected } = problem;
  const ratingKey = problem.matched.key;
  const plex = await plexClient();
  const item = await plex.getMatchItem(ratingKey);
  if (!item) return { state: 'gone' };
  if (sameTitle(kind, expected, plexIds(item))) return { state: 'right' };

  const library = await libraryOf(plex, item);
  const { want, also } = fixSearch(kind, expected);
  const searched: string[] = [];
  let chosen: PlexMatchResult | undefined;
  for (const id of [want, also]) {
    if (!id) continue;
    const term = `${id.name}-${id.id}`;
    searched.push(term);
    chosen = pick(await plex.findMatches(ratingKey, term, library), expected);
    if (chosen) break;
  }
  if (!chosen) return { state: 'notFound', searched };

  const from = { guid: item.guid, title: item.title, year: item.year };
  await plex.setMatch(ratingKey, {
    guid: chosen.guid,
    name: chosen.name,
    year: chosen.year,
  });
  const { item: after, fresh } = await readBack(
    plex,
    ratingKey,
    chosen.guid,
    kind,
    expected,
    plexIds(item)
  );
  if (!after || after.guid !== chosen.guid) return { state: 'unchanged' };
  // Judged by its ids only once they are the new title's: the old title's
  // would always read as another title.
  const same = fresh ? sameTitle(kind, expected, plexIds(after)) : undefined;
  if (same === false) {
    await putBack(plex, ratingKey, from);
    logger.warn(
      `Match Check: Plex took "${problem.folder}" as ${after.title}, not ${expected.title}; its old match was put back`,
      { label: LABEL, ratingKey }
    );
    return { state: 'putBack', to: { title: after.title, year: after.year } };
  }

  const fix: MatchFix = {
    id: randomUUID(),
    at: new Date().toISOString(),
    by,
    kind,
    folder: problem.folder,
    ratingKey,
    expected: { title: expected.title, year: expected.year },
    from,
    to: {
      guid: chosen.guid,
      title: after.title || chosen.name,
      year: after.year ?? chosen.year,
    },
    confirmed: same === true,
  };
  await saveFixes([fix, ...(await readFixes())]);
  logger.info(
    `Match Check: fixed "${problem.folder}" in Plex: ${from.title} is now ${fix.to.title}`,
    { label: LABEL, ratingKey, by }
  );
  return { state: 'fixed', fix };
};

/** Problems an automatic fix didn't put right, and when: not tried daily. */
const autoTried = new Map<string, number>();
const AUTO_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** For tests: forgets which problems were tried. */
export const forgetAutoTriedForTests = () => autoTried.clear();

/**
 * A fix made without an admin, for a problem with `key`: one that didn't
 * work isn't tried again for a week, and a failure is logged, not thrown.
 */
export const autoFix = async (
  problem: PlexMatchProblem,
  key: string
): Promise<FixOutcome | undefined> => {
  if (!fixingAuto() || !canFix(problem)) return undefined;
  const tried = autoTried.get(key);
  if (tried && Date.now() - tried < AUTO_RETRY_MS) return undefined;
  try {
    const outcome = await fixMatch(problem, 'auto');
    if (outcome.state === 'fixed' || outcome.state === 'right') {
      autoTried.delete(key);
    } else {
      autoTried.set(key, Date.now());
    }
    return outcome;
  } catch (e) {
    autoTried.set(key, Date.now());
    logger.warn(`Match Check: could not fix "${problem.folder}" in Plex`, {
      label: LABEL,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
};

/** Puts a fix back as Plex had it before. */
export const undoFix = async (id: string, by: FixBy): Promise<MatchFix> => {
  const all = await readFixes();
  const fix = all.find((f) => f.id === id);
  if (!fix) throw new Error('That fix is not listed any more.');
  if (fix.undoneAt) throw new Error('That fix was undone already.');
  const plex = await plexClient();
  if (!(await plex.getMatchItem(fix.ratingKey))) {
    throw new Error('It is no longer on Plex.');
  }
  await putBack(plex, fix.ratingKey, fix.from);
  const undone: MatchFix = {
    ...fix,
    undoneAt: new Date().toISOString(),
    undoneBy: by,
  };
  await saveFixes(all.map((f) => (f.id === id ? undone : f)));
  logger.info(
    `Match Check: undid the fix of "${fix.folder}" in Plex: back to ${fix.from.title}`,
    { label: LABEL, ratingKey: fix.ratingKey, by }
  );
  return undone;
};
