import type {
  PlexListDetail,
  PlexListEntry,
  PlexListSummary,
  PlexTitleIds,
} from '@server/api/plexLists';
import PlexListsAPI, { PlexListsError } from '@server/api/plexLists';
import dataSource, { getRepository } from '@server/datasource';
import { MediaList, MediaListItem } from '@server/entity/MediaList';
import { PlexListFollow } from '@server/entity/PlexListFollow';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import type { RequestMissingResult } from '@server/lib/requestMissing';
import { requestMissing } from '@server/lib/requestMissing';
import logger from '@server/logger';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';

/**
 * Plex Lists in Seerr AI: a person's own Plex lists, shown with their titles
 * matched to TMDB, copied into a Seerr AI list, added to from Seerr AI, and,
 * per list, auto-requesting what's added to them on Plex.
 */

const LABEL = 'Plex Lists';

/** How long a person's lists and a list's titles are reused. */
const LISTS_TTL_MS = 60_000;
/** Plex ids and TMDB ids don't change; kept a day, at most this many. */
const IDS_TTL_MS = 24 * 60 * 60 * 1000;
/** Plex may give a new title its TMDB id later: asked again after an hour. */
const NO_IDS_TTL_MS = 60 * 60 * 1000;
const IDS_MAX = 20_000;
/** How often a list with auto-request on is read for new titles. */
const CHECK_EVERY_MS = 10 * 60 * 1000;
/** After Plex refuses a person's sign-in, how long before trying again. */
const REFUSED_RETRY_MS = 60 * 60 * 1000;
/** Title lookups at a time against discover.provider.plex.tv. */
const LOOKUPS_AT_ONCE = 5;

interface Cached<T> {
  at: number;
  value: T;
}

/** By Plex account, so another sign-in on the same person reads afresh. */
const myListsCache = new Map<string, Cached<PlexListSummary[]>>();
const listCache = new Map<string, Cached<PlexListDetail>>();
const idsCache = new Map<string, Cached<PlexTitleIds | null>>();
const plexIdCache = new Map<string, Cached<string | null>>();

const fresh = <T>(entry: Cached<T> | undefined, ttl: number) =>
  entry && Date.now() - entry.at < ttl ? entry : undefined;

/**
 * Map insertion order is age order: entries past `ttl` are dropped from the
 * front as new ones come in, and the oldest go when it's full.
 */
const remember = <K, T>(
  map: Map<K, Cached<T>>,
  key: K,
  value: T,
  ttl: number
) => {
  map.delete(key);
  map.set(key, { at: Date.now(), value });
  for (const [oldKey, entry] of map) {
    if (map.size <= IDS_MAX && Date.now() - entry.at < ttl) break;
    map.delete(oldKey);
  }
};

const listKey = (api: PlexListsAPI, owner: string, slug: string) =>
  `${api.account}:${owner.toLowerCase()}/${slug}`;

/** Forgets what was read of a person's lists, after they change one. */
const forgetLists = (api: PlexListsAPI) => {
  myListsCache.delete(api.account);
  for (const key of listCache.keys()) {
    if (key.startsWith(`${api.account}:`)) listCache.delete(key);
  }
};

/** A title on a Plex list, with what it is in TMDB terms when Plex says. */
export interface PlexListTitle extends PlexListEntry {
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
  /** Plex couldn't be asked what it is just now: try again later. */
  unchecked?: boolean;
}

/** The person's Plex token, or null when they didn't sign in with Plex. */
const tokenOf = async (userId: number): Promise<string | null> => {
  const user = await getRepository(User)
    .createQueryBuilder('user')
    .addSelect('user.plexToken')
    .where('user.id = :userId', { userId })
    .getOne();
  return user?.plexToken || null;
};

/** A Plex Lists client for this person, or null without a Plex sign-in. */
export const plexListsFor = async (
  userId: number
): Promise<PlexListsAPI | null> => {
  const token = await tokenOf(userId);
  return token ? new PlexListsAPI(token) : null;
};

/** The person's Plex lists, briefly cached. */
export const myPlexLists = async (
  userId: number,
  api: PlexListsAPI
): Promise<PlexListSummary[]> => {
  const cached = fresh(myListsCache.get(api.account), LISTS_TTL_MS);
  if (cached) return cached.value;
  const lists = await api.getMyLists();
  remember(myListsCache, api.account, lists, LISTS_TTL_MS);
  return lists;
};

/**
 * One of the person's own Plex lists by owner and slug, or a 'missing'
 * error: only their own lists are read or changed here.
 */
export const ownPlexList = async (
  userId: number,
  api: PlexListsAPI,
  owner: string,
  slug: string
): Promise<PlexListSummary> => {
  const summary = (await myPlexLists(userId, api)).find(
    (list) =>
      list.owner.toLowerCase() === owner.toLowerCase() && list.slug === slug
  );
  if (!summary) {
    throw new PlexListsError('missing', 'That is not one of your Plex lists.');
  }
  return summary;
};

/** A list's titles; `fresh` reads Plex now rather than the last minute's. */
const listDetail = async (
  api: PlexListsAPI,
  summary: PlexListSummary,
  readNow = false
): Promise<PlexListDetail> => {
  const key = listKey(api, summary.owner, summary.slug);
  const cached = !readNow && fresh(listCache.get(key), LISTS_TTL_MS);
  if (cached) return cached.value;
  const detail = await api.getList(summary.owner, summary.slug);
  remember(listCache, key, detail, LISTS_TTL_MS);
  return detail;
};

/**
 * TMDB ids for Plex titles: null when Plex can't place a title, undefined
 * when it couldn't be asked just now (tried again next time, not cached).
 * A refused sign-in stops it: every other lookup would be refused too.
 */
const idsOf = async (
  api: PlexListsAPI,
  plexIds: string[]
): Promise<Map<string, PlexTitleIds | null | undefined>> => {
  const found = new Map<string, PlexTitleIds | null | undefined>();
  const unknown: string[] = [];
  for (const id of new Set(plexIds)) {
    const cached = idsCache.get(id);
    const kept = fresh(cached, cached?.value ? IDS_TTL_MS : NO_IDS_TTL_MS);
    if (kept) found.set(id, kept.value);
    else unknown.push(id);
  }
  await mapWithConcurrency(unknown, LOOKUPS_AT_ONCE, async (id) => {
    try {
      const ids = await api.idsOf(id);
      remember(idsCache, id, ids, IDS_TTL_MS);
      found.set(id, ids);
    } catch (e) {
      if (e instanceof PlexListsError && e.problem === 'auth') throw e;
      found.set(id, undefined);
    }
  });
  return found;
};

/**
 * Starts a Plex list for the person, private, and returns it. Plex can take
 * a moment to show a new list among the person's lists.
 */
export const createPlexList = async (
  userId: number,
  api: PlexListsAPI,
  title: string,
  ranked: boolean
): Promise<PlexListSummary> => {
  const at = await api.createList(title, ranked);
  for (let attempt = 0; ; attempt++) {
    forgetLists(api);
    try {
      return await ownPlexList(userId, api, at.owner, at.slug);
    } catch (e) {
      if (
        attempt >= 3 ||
        !(e instanceof PlexListsError && e.problem === 'missing')
      ) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
};

/** A list's titles in order, matched to TMDB. */
export const plexListTitles = async (
  api: PlexListsAPI,
  summary: PlexListSummary,
  readNow = false
): Promise<{ detail: PlexListDetail; titles: PlexListTitle[] }> => {
  const detail = await listDetail(api, summary, readNow);
  const ids = await idsOf(
    api,
    detail.entries.map((entry) => entry.plexId)
  );
  return {
    detail,
    titles: detail.entries.map((entry) => {
      const match = ids.get(entry.plexId);
      return match
        ? { ...entry, tmdbId: match.tmdbId, mediaType: match.mediaType }
        : match === undefined
          ? { ...entry, unchecked: true }
          : entry;
    }),
  };
};

/** Plex's id for a TMDB film or series, cached. */
const plexIdOf = async (
  api: PlexListsAPI,
  tmdbId: number,
  mediaType: 'movie' | 'tv'
): Promise<string | null> => {
  const key = `${mediaType}:${tmdbId}`;
  const cached = plexIdCache.get(key);
  const kept = fresh(cached, cached?.value ? IDS_TTL_MS : NO_IDS_TTL_MS);
  if (kept) return kept.value;
  const id = await api.plexIdOf(tmdbId, mediaType);
  remember(plexIdCache, key, id, IDS_TTL_MS);
  return id;
};

/** Throws 'unknownTitle' when Plex doesn't have the film or series. */
export const plexHasTitle = async (
  api: PlexListsAPI,
  tmdbId: number,
  mediaType: 'movie' | 'tv'
): Promise<void> => {
  if (!(await plexIdOf(api, tmdbId, mediaType))) {
    throw new PlexListsError('unknownTitle', 'Plex does not have this title.');
  }
};

/**
 * The person's Plex lists, each saying whether it has this title. A list
 * that couldn't be read just now is left out rather than failing the rest.
 */
export const plexListsWith = async (
  userId: number,
  api: PlexListsAPI,
  tmdbId: number,
  mediaType: 'movie' | 'tv'
): Promise<{ summary: PlexListSummary; contains: boolean }[]> => {
  const lists = await myPlexLists(userId, api);
  if (!lists.length) return [];
  const plexId = await plexIdOf(api, tmdbId, mediaType);
  const read = await mapWithConcurrency(lists, 3, async (summary) => {
    try {
      return {
        summary,
        contains:
          !!plexId &&
          (await listDetail(api, summary)).entries.some(
            (entry) => entry.plexId === plexId
          ),
      };
    } catch (e) {
      if (e instanceof PlexListsError && e.problem === 'auth') throw e;
      logger.debug('Could not read a Plex list for Add to List', {
        label: LABEL,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  });
  return read.filter(
    (list): list is { summary: PlexListSummary; contains: boolean } => !!list
  );
};

/**
 * Adds a TMDB title to one of the person's Plex lists, or takes it off. A
 * title Plex doesn't have can't go on a Plex list. Added to a list with
 * auto-request on, it's requested now, as an addition on Plex would be at
 * the next check; the result says how that went.
 */
export const changePlexList = async (
  user: User,
  api: PlexListsAPI,
  summary: PlexListSummary,
  change: 'add' | 'remove',
  tmdbId: number,
  mediaType: 'movie' | 'tv'
): Promise<RequestMissingResult | undefined> => {
  const plexId = await plexIdOf(api, tmdbId, mediaType);
  if (!plexId) {
    throw new PlexListsError('unknownTitle', 'Plex does not have this title.');
  }
  // Read now: it may have changed on Plex in the last minute.
  const detail = await listDetail(api, summary, true);
  const there = detail.entries.some((entry) => entry.plexId === plexId);
  // Already as asked, unless the list was too long to read to the end.
  if ((change === 'add') === there && (there || !detail.truncated)) {
    return undefined;
  }
  try {
    await api.editList(summary.id, change, plexId);
  } finally {
    forgetLists(api);
  }
  if (change === 'remove') return undefined;

  const follow = await getRepository(PlexListFollow).findOne({
    where: { userId: user.id, plexListId: summary.id },
  });
  if (!follow || !autoRequests(user, mediaType)) return undefined;
  const result = await requestMissing(tmdbId, mediaType, user, {
    isAutoRequest: true,
  });
  // Refused for now: the next check tries again.
  if (!result.retryLater) await markHandled(follow.id, [plexId]);
  return result;
};

/**
 * The titles that are films or series in TMDB terms, each once: a series and
 * a season of it on the same list are the series once.
 */
export const onceEach = (titles: PlexListTitle[]): PlexListTitle[] => {
  const seen = new Set<string>();
  return titles.filter((title) => {
    if (!title.tmdbId || !title.mediaType) return false;
    const key = `${title.mediaType}:${title.tmdbId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Adds titles to a follow's handled ones, in the database as it is now: a
 * follow turned off meanwhile stays off.
 */
const markHandled = async (followId: number, plexIds: string[]) => {
  const follows = getRepository(PlexListFollow);
  const now = await follows.findOne({ where: { id: followId } });
  if (!now) return;
  const add = plexIds.filter((id) => !now.handled.includes(id));
  if (!add.length) return;
  await follows.update(followId, { handled: [...now.handled, ...add] });
};

/**
 * Makes a Seerr AI watch list from a Plex list: its name and the titles
 * matched to TMDB, in the Plex list's order. Returns the new list and how
 * many titles couldn't be matched.
 */
export const copyPlexList = async (
  user: User,
  api: PlexListsAPI,
  summary: PlexListSummary
): Promise<{ list: MediaList; added: number; unmatched: number }> => {
  const { detail, titles } = await plexListTitles(api, summary);
  const matched = onceEach(titles);

  // Lists show newest first, so the first title gets the latest time.
  const start = Date.now();
  const list = await dataSource.transaction(async (manager) => {
    const created = await manager.save(
      new MediaList({
        name: detail.title.trim() || summary.slug,
        kind: 'watch',
        ownerId: user.id,
        watchedSync: false,
      })
    );
    if (matched.length) {
      await manager.save(
        matched.map(
          (title, index) =>
            new MediaListItem({
              listId: created.id,
              tmdbId: title.tmdbId as number,
              mediaType: title.mediaType as 'movie' | 'tv',
              addedById: user.id,
              createdAt: new Date(start - index * 1000),
            })
        ),
        { chunk: 200 }
      );
    }
    return created;
  });

  return {
    list,
    added: matched.length,
    unmatched: titles.filter((title) => !title.tmdbId).length,
  };
};

/** Whether this person may have titles auto-requested, by kind. */
const autoRequests = (user: User, mediaType: 'movie' | 'tv'): boolean =>
  user.hasPermission(
    [
      Permission.AUTO_REQUEST,
      mediaType === 'movie'
        ? Permission.AUTO_REQUEST_MOVIE
        : Permission.AUTO_REQUEST_TV,
    ],
    { type: 'or' }
  );

/** Whether this person may turn auto-request on for a Plex list at all. */
export const mayAutoRequest = (user: User): boolean =>
  autoRequests(user, 'movie') || autoRequests(user, 'tv');

/**
 * Turns auto-request on or off for one of the person's Plex lists. Turned
 * on, what's on the list now counts as dealt with: only titles added later
 * are requested.
 */
export const setPlexListAutoRequest = async (
  userId: number,
  api: PlexListsAPI,
  summary: PlexListSummary,
  on: boolean
): Promise<void> => {
  const follows = getRepository(PlexListFollow);
  const existing = await follows.findOne({
    where: { userId, plexListId: summary.id },
  });
  if (!on) {
    if (existing) await follows.remove(existing);
    return;
  }
  if (existing) return;
  const detail = await listDetail(api, summary, true);
  try {
    await follows.insert(
      new PlexListFollow({
        userId,
        plexListId: summary.id,
        owner: summary.owner,
        slug: summary.slug,
        handled: detail.entries.map((entry) => entry.plexId),
        checkedAt: new Date(),
      })
    );
  } catch (e) {
    // Turned on twice at once: the other one did it.
    if (await follows.exists({ where: { userId, plexListId: summary.id } })) {
      return;
    }
    throw e;
  }
};

/**
 * The person's Plex lists with auto-request on, by Plex's list id, with why
 * the last check failed when it did.
 */
export const autoRequestedLists = async (
  userId: number
): Promise<Map<string, { problem?: string | null }>> =>
  new Map(
    (
      await getRepository(PlexListFollow).find({
        where: { userId },
        select: { plexListId: true, problem: true },
      })
    ).map((follow) => [follow.plexListId, { problem: follow.problem }])
  );

class PlexListSync {
  public running = false;
  /** When Plex last refused each person's sign-in. */
  private refusedAt = new Map<number, number>();

  /**
   * Requests what's been added to the Plex lists with auto-request on. Run
   * with watchlist sync; each list is read at most every CHECK_EVERY_MS.
   */
  public async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = (
        await getRepository(PlexListFollow).find({ order: { userId: 'ASC' } })
      ).filter(
        (follow) =>
          !follow.checkedAt ||
          Date.now() - follow.checkedAt.getTime() >= CHECK_EVERY_MS
      );
      const byUser = new Map<number, PlexListFollow[]>();
      for (const follow of due) {
        byUser.set(follow.userId, [
          ...(byUser.get(follow.userId) ?? []),
          follow,
        ]);
      }
      // One person's failure doesn't skip the people after them.
      for (const [userId, theirs] of byUser) {
        const refused = this.refusedAt.get(userId);
        if (refused && Date.now() - refused < REFUSED_RETRY_MS) continue;
        try {
          await this.syncUser(userId, theirs);
        } catch (e) {
          logger.warn('Could not check Plex lists for new titles', {
            label: LABEL,
            userId,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async syncUser(userId: number, follows: PlexListFollow[]) {
    const user = await getRepository(User).findOne({ where: { id: userId } });
    const api = await plexListsFor(userId);
    if (!user || !api) return;
    // The person's lists as they are now, to find each by its id.
    myListsCache.delete(api.account);

    for (const follow of follows) {
      try {
        await this.syncList(user, api, follow);
        this.refusedAt.delete(userId);
      } catch (e) {
        const problem =
          e instanceof PlexListsError
            ? e.message
            : 'The list could not be checked.';
        // Only a follow still there: one turned off meanwhile stays off.
        await getRepository(PlexListFollow).update(follow.id, {
          checkedAt: new Date(),
          problem,
        });
        logger.warn('Could not check a Plex list for new titles', {
          label: LABEL,
          userId,
          plexListId: follow.plexListId,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        // Plex refused the sign-in: the other lists would fail the same way.
        if (e instanceof PlexListsError && e.problem === 'auth') {
          this.refusedAt.set(userId, Date.now());
          return;
        }
      }
    }
  }

  private async syncList(
    user: User,
    api: PlexListsAPI,
    follow: PlexListFollow
  ) {
    const follows = getRepository(PlexListFollow);
    // By Plex's id for the list, which a rename doesn't change; another list
    // given its old name isn't it.
    const summary = (await myPlexLists(user.id, api)).find(
      (list) => list.id === follow.plexListId
    );
    if (!summary) {
      // Not among the person's lists. Gone only if its page is gone too:
      // a list Plex left out of a reply isn't taken for deleted.
      try {
        await api.getList(follow.owner, follow.slug);
      } catch (e) {
        if (e instanceof PlexListsError && e.problem === 'missing') {
          await follows.delete(follow.id);
          return;
        }
        throw e;
      }
      throw new PlexListsError(
        'missing',
        'The list is no longer among your Plex lists.'
      );
    }

    const { detail, titles } = await plexListTitles(api, summary, true);
    const onList = new Set(titles.map((title) => title.plexId));
    // Titles taken off the list are forgotten, so putting one back counts
    // as adding it; only when the whole list was read.
    const kept = detail.truncated
      ? follow.handled
      : follow.handled.filter((id) => onList.has(id));
    const handled = new Set(kept);
    const done: string[] = [];

    for (const title of titles) {
      if (handled.has(title.plexId)) continue;
      // Plex can't say what it is yet, or couldn't be asked: next check.
      if (!title.tmdbId || !title.mediaType) continue;
      if (!autoRequests(user, title.mediaType)) {
        done.push(title.plexId);
        continue;
      }
      const result = await requestMissing(title.tmdbId, title.mediaType, user, {
        isAutoRequest: true,
      });
      // Refused for now (the request limit, or a failure): next check.
      if (result.retryLater) continue;
      done.push(title.plexId);
      if (result.outcome === 'requested') {
        logger.info('Requested a title added to a Plex list', {
          label: LABEL,
          userId: user.id,
          mediaTitle: title.title,
        });
      }
    }

    // Written as it is now, so a follow turned off meanwhile stays off, and
    // titles a Seerr AI add marked meanwhile are kept.
    const now = await follows.findOne({ where: { id: follow.id } });
    if (!now) return;
    const latest = new Set([...kept, ...done]);
    for (const id of now.handled) {
      if (!follow.handled.includes(id)) latest.add(id);
    }
    await follows.update(follow.id, {
      owner: summary.owner,
      slug: summary.slug,
      handled: [...latest],
      checkedAt: new Date(),
      problem: null,
    });
  }
}

export const plexListSync = new PlexListSync();
