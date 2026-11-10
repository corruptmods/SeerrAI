import ExternalAPI from '@server/api/externalapi';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAxiosError } from 'axios';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Plex's Lists ("My Lists"), read and edited through the screens Plex's own
 * web app uses at luma.plex.tv, with the person's Plex token. Plex doesn't
 * document these, so every reply is checked for the parts used here and a
 * reply without them is an error, never an empty list.
 *
 * Titles are Plex metadata ids; discover.provider.plex.tv gives their TMDB
 * ids, and the TMDB id of a film or series back.
 */

const LUMA = 'https://luma.plex.tv';
const DISCOVER = 'https://discover.provider.plex.tv';
const TIMEOUT_MS = 20_000;

/**
 * A long list comes a page at a time (Plex sends 14 or so to a page); past
 * this many pages, or MAX_ITEMS titles, the rest is not read.
 */
const MAX_PAGES = 200;
export const MAX_ITEMS = 2000;
/** Plex's own limit on a list's name. */
export const MAX_TITLE = 100;

export type PlexListProblem =
  /** Plex refused the sign-in: only signing in again fixes it. */
  | 'auth'
  /** The list isn't there, or isn't this person's. */
  | 'missing'
  /** Plex doesn't have the film or series, so it can't go on a list. */
  | 'unknownTitle'
  /** Plex answered in a shape this doesn't know: Plex changed something. */
  | 'changed'
  /** Plex couldn't be reached, or failed. */
  | 'unavailable';

export class PlexListsError extends Error {
  constructor(
    public readonly problem: PlexListProblem,
    message: string
  ) {
    super(message);
    this.name = 'PlexListsError';
  }
}

const link = z.object({ url: z.string() }).passthrough();

const listSummary = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    subtitle: z.string().optional(),
    link,
    privacy: z.object({ icon: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const pagination = z
  .object({ nextUrl: z.string().optional() })
  .passthrough()
  .optional();

const myListsScreen = z
  .object({
    ui: z
      .object({
        lists: z.array(listSummary).optional(),
        // "1 List": with lists to show, Plex must send them.
        listCount: z.string().optional(),
        pagination,
      })
      .passthrough(),
  })
  .passthrough();

const listItem = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    subtitle: z.string().optional(),
    link: link.optional(),
  })
  .passthrough();

const listScreen = z
  .object({
    ui: z
      .object({
        title: z.string(),
        description: z.string().optional(),
        // Plex says ranked as a flag on someone else's list, as the selected
        // option of a picker on your own.
        ranked: z.boolean().optional(),
        ranking: z
          .object({
            selected: z.object({ value: z.boolean() }).passthrough(),
          })
          .passthrough()
          .optional(),
        privacy: z
          .object({
            icon: z.string().optional(),
            selected: z
              .object({
                value: z.string().optional(),
                icon: z.string().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
        itemCountRaw: z.number().optional(),
        list: z.array(listItem),
        pagination,
      })
      .passthrough(),
  })
  .passthrough();

const listPage = z
  .object({ content: z.array(listItem), pagination })
  .passthrough();

const metadataReply = z
  .object({
    MediaContainer: z
      .object({
        Metadata: z
          .array(
            z
              .object({
                ratingKey: z.string().optional(),
                type: z.string(),
                parentRatingKey: z.string().optional(),
                grandparentRatingKey: z.string().optional(),
                Guid: z
                  .array(z.object({ id: z.string() }).passthrough())
                  .optional(),
              })
              .passthrough()
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Who may see a Plex list, in Plex's terms. */
export type PlexListPrivacy =
  | 'ANYONE'
  | 'PLEX'
  | 'FRIENDS_OF_FRIENDS'
  | 'FRIENDS'
  | 'PRIVATE';

const PRIVACIES: PlexListPrivacy[] = [
  'ANYONE',
  'PLEX',
  'FRIENDS_OF_FRIENDS',
  'FRIENDS',
  'PRIVATE',
];

/** Plex marks each privacy with an icon; on your own list, also its value. */
const BY_ICON: Record<string, PlexListPrivacy> = {
  globe: 'ANYONE',
  server: 'PLEX',
  'friend-of-friends': 'FRIENDS_OF_FRIENDS',
  friends: 'FRIENDS',
  'user-private': 'PRIVATE',
};

const privacyOf = (value?: string, icon?: string) =>
  PRIVACIES.find((privacy) => privacy === value) ??
  (icon ? BY_ICON[icon] : undefined);

/** One of a person's Plex lists, as their My Lists page shows it. */
export interface PlexListSummary {
  /** Plex's id for the list, used to edit it. */
  id: string;
  /** Owner and slug, as in watch.plex.tv/u/<owner>/lists/<slug>. */
  owner: string;
  slug: string;
  title: string;
  /** How many titles, from Plex's "4 Items". */
  itemCount?: number;
  privacy?: PlexListPrivacy;
}

/** A title on a Plex list, in the list's order. */
export interface PlexListEntry {
  plexId: string;
  title: string;
  /** The year, when Plex gives one. */
  year?: number;
  /** From Plex's link; undefined when it links to something else. */
  kind?: 'movie' | 'show' | 'part';
}

export interface PlexListDetail {
  title: string;
  description?: string;
  ranked: boolean;
  privacy?: PlexListPrivacy;
  /** Every title, in order, up to MAX_ITEMS. */
  entries: PlexListEntry[];
  /**
   * True when not every title was read: the list is longer than MAX_ITEMS,
   * or Plex says it holds more than it sent.
   */
  truncated: boolean;
}

/** What a Plex title is in TMDB terms. */
export interface PlexTitleIds {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  tvdbId?: number;
}

/** "/u/<owner>/lists/<slug>" from a Plex link, without its query. */
export const parseListPath = (
  url: string
): { owner: string; slug: string } | undefined => {
  const match = url
    .split('?')[0]
    .match(/^(?:https:\/\/watch\.plex\.tv)?\/u\/([^/]+)\/lists\/([^/]+)\/?$/);
  return match
    ? {
        owner: decodeURIComponent(match[1]),
        slug: decodeURIComponent(match[2]),
      }
    : undefined;
};

/** Plex links a film as /movie/…, a series as /show/…, a season deeper. */
const kindOf = (url?: string): PlexListEntry['kind'] => {
  const path = url?.split('?')[0] ?? '';
  if (path.startsWith('/movie/')) return 'movie';
  if (/^\/show\/[^/]+\/?$/.test(path)) return 'show';
  if (path.startsWith('/show/')) return 'part';
  return undefined;
};

/** The number at the start of Plex's "4 Items" or "1,204 Lists". */
const countOf = (label?: string): number =>
  Number(label?.match(/^\s*(\d[\d,. ]*)/)?.[1].replace(/\D/g, '')) || 0;

const yearOf = (subtitle?: string): number | undefined => {
  const year = Number(subtitle?.match(/^\d{4}/)?.[0]);
  return Number.isFinite(year) && year > 1800 ? year : undefined;
};

const toEntry = (item: z.infer<typeof listItem>): PlexListEntry => ({
  plexId: item.id,
  title: item.title,
  year: yearOf(item.subtitle),
  kind: kindOf(item.link?.url),
});

/**
 * Only pages on luma.plex.tv are followed: they get the person's token. A
 * page elsewhere, or a path that could be read as another host, is ''.
 */
const lumaPage = (url?: string): string | undefined => {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, LUMA);
    return parsed.origin === LUMA && !parsed.pathname.startsWith('//')
      ? `${parsed.pathname}${parsed.search}`
      : '';
  } catch {
    return '';
  }
};

const problemOf = (e: unknown): PlexListsError => {
  if (e instanceof PlexListsError) return e;
  if (isAxiosError(e)) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return new PlexListsError('auth', 'Plex refused the sign-in.');
    }
    if (status === 404) {
      return new PlexListsError('missing', 'Plex has no such list.');
    }
    return new PlexListsError(
      'unavailable',
      status ? `Plex answered ${status}.` : `Plex couldn't be reached.`
    );
  }
  return new PlexListsError(
    'unavailable',
    e instanceof Error ? e.message : String(e)
  );
};

const parse = <T>(schema: z.ZodType<T>, data: unknown, what: string): T => {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new PlexListsError(
      'changed',
      `Plex sent ${what} in a form Seerr AI doesn't know.`
    );
  }
  return parsed.data;
};

class PlexListsAPI extends ExternalAPI {
  /** Stands for the Plex account, without its token: caches use it. */
  public readonly account: string;

  constructor(authToken: string) {
    super(
      LUMA,
      {},
      {
        headers: {
          'X-Plex-Token': authToken,
          'X-Plex-Client-Identifier': getSettings().clientId,
          'X-Plex-Product': 'Seerr AI',
        },
        timeout: TIMEOUT_MS,
      }
    );
    this.account = createHash('sha256')
      .update(authToken)
      .digest('hex')
      .slice(0, 24);
  }

  private async read<T>(
    path: string,
    schema: z.ZodType<T>,
    what: string,
    baseURL?: string
  ): Promise<T> {
    try {
      // Paths only, never a whole address: the token goes to baseURL alone.
      const { data } = await this.axios.get(path, {
        ...(baseURL && { baseURL }),
        allowAbsoluteUrls: false,
      });
      return parse(schema, data, what);
    } catch (e) {
      throw problemOf(e);
    }
  }

  /** The person's own lists, newest first as Plex orders them. */
  public async getMyLists(): Promise<PlexListSummary[]> {
    const lists: PlexListSummary[] = [];
    let path: string | undefined = '/api/screen/watchlist/my-lists';

    for (let page = 0; path && page < MAX_PAGES; page++) {
      const screen: z.infer<typeof myListsScreen> = await this.read(
        path,
        myListsScreen,
        'your lists'
      );
      if (!screen.ui.lists && countOf(screen.ui.listCount)) {
        throw new PlexListsError(
          'changed',
          `Plex said there are lists but sent none.`
        );
      }
      for (const list of screen.ui.lists ?? []) {
        const at = parseListPath(list.link.url);
        // Something that isn't one of the person's lists: left out.
        if (!at) {
          logger.debug('Left out a Plex list entry with an unknown link', {
            label: 'Plex Lists',
          });
          continue;
        }
        lists.push({
          id: list.id,
          ...at,
          title: list.title,
          itemCount: countOf(list.subtitle),
          privacy: privacyOf(undefined, list.privacy?.icon),
        });
      }
      path = lumaPage(screen.ui.pagination?.nextUrl);
    }
    // Unread pages would hide lists, and a hidden list looks deleted.
    if (path) {
      throw new PlexListsError('changed', 'Plex sent too many pages of lists.');
    }
    if (path === '') {
      throw new PlexListsError(
        'changed',
        'Plex pointed to the next page somewhere Seerr AI does not follow.'
      );
    }

    return lists;
  }

  /** A list's details and titles, every page of them up to MAX_ITEMS. */
  public async getList(owner: string, slug: string): Promise<PlexListDetail> {
    const screen = await this.read(
      `/api/screen/u/${encodeURIComponent(owner)}/lists/${encodeURIComponent(slug)}`,
      listScreen,
      'a list'
    );
    const { ui } = screen;
    const seen = new Set<string>();
    const entries: PlexListEntry[] = [];
    const take = (items: z.infer<typeof listItem>[]) => {
      for (const item of items) {
        if (entries.length >= MAX_ITEMS) return;
        // Pages can overlap by a title; it's listed once.
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        entries.push(toEntry(item));
      }
    };
    take(ui.list);

    let path = lumaPage(ui.pagination?.nextUrl);
    for (
      let page = 1;
      path && page < MAX_PAGES && entries.length < MAX_ITEMS;
      page++
    ) {
      const next = await this.read(path, listPage, 'a page of a list');
      take(next.content);
      path = lumaPage(next.pagination?.nextUrl);
    }
    if (path === '') {
      throw new PlexListsError(
        'changed',
        'Plex pointed to the next page somewhere Seerr AI does not follow.'
      );
    }

    return {
      title: ui.title,
      description: ui.description || undefined,
      ranked: ui.ranking?.selected.value ?? ui.ranked ?? false,
      privacy: privacyOf(
        ui.privacy?.selected?.value,
        ui.privacy?.selected?.icon ?? ui.privacy?.icon
      ),
      entries,
      truncated: !!path || (ui.itemCountRaw ?? 0) > entries.length,
    };
  }

  /**
   * Starts a list for the person, private: they change who sees it on Plex.
   * Returns where it is.
   */
  public async createList(
    title: string,
    ranked: boolean
  ): Promise<{ owner: string; slug: string }> {
    let data: unknown;
    try {
      ({ data } = await this.axios.post(
        '/api/action/lists',
        { title: title.slice(0, MAX_TITLE), privacy: 'PRIVATE', ranked },
        { allowAbsoluteUrls: false }
      ));
    } catch (e) {
      throw problemOf(e);
    }
    const created = parse(
      z.object({ ui: z.object({ link }).passthrough() }).passthrough(),
      data,
      'the new list'
    );
    const at = parseListPath(created.ui.link.url);
    if (!at) {
      throw new PlexListsError(
        'changed',
        `Plex sent a list link Seerr AI doesn't know.`
      );
    }
    return at;
  }

  /** Adds a title to the end of one of the person's lists, or removes it. */
  public async editList(
    listId: string,
    change: 'add' | 'remove',
    plexId: string
  ): Promise<void> {
    try {
      await this.axios.post(
        `/api/action/lists/${encodeURIComponent(listId)}/edit-items`,
        { changes: [{ [change]: { metadataId: plexId } }] },
        { allowAbsoluteUrls: false }
      );
    } catch (e) {
      throw problemOf(e);
    }
  }

  /** The TMDB ids of a Plex title; a season or episode gives its series. */
  public async idsOf(plexId: string): Promise<PlexTitleIds | null> {
    let key = plexId;
    // A season, then its series: at most two steps up.
    for (let step = 0; step < 3; step++) {
      let reply: z.infer<typeof metadataReply>;
      try {
        reply = await this.read(
          `/library/metadata/${encodeURIComponent(key)}`,
          metadataReply,
          'a title',
          DISCOVER
        );
      } catch (e) {
        if (e instanceof PlexListsError && e.problem === 'missing') {
          return null;
        }
        throw e;
      }
      const item = reply.MediaContainer.Metadata?.[0];
      if (!item) return null;
      if (item.type === 'movie' || item.type === 'show') {
        const guid = (prefix: string) =>
          Number(
            item.Guid?.find((g) => g.id.startsWith(prefix))?.id.slice(
              prefix.length
            )
          ) || undefined;
        const tmdbId = guid('tmdb://');
        if (!tmdbId) return null;
        return {
          tmdbId,
          mediaType: item.type === 'movie' ? 'movie' : 'tv',
          tvdbId: guid('tvdb://'),
        };
      }
      const up =
        item.type === 'season'
          ? item.parentRatingKey
          : item.type === 'episode'
            ? item.grandparentRatingKey
            : undefined;
      if (!up) return null;
      key = up;
    }
    return null;
  }

  /** Plex's id for a TMDB film or series, or null if Plex doesn't have it. */
  public async plexIdOf(
    tmdbId: number,
    mediaType: 'movie' | 'tv'
  ): Promise<string | null> {
    let reply: z.infer<typeof metadataReply>;
    try {
      reply = await this.read(
        `/library/metadata/matches?type=${mediaType === 'movie' ? 1 : 2}&guid=${encodeURIComponent(`tmdb://${tmdbId}`)}`,
        metadataReply,
        'a title',
        DISCOVER
      );
    } catch (e) {
      if (e instanceof PlexListsError && e.problem === 'missing') return null;
      throw e;
    }
    const wanted = mediaType === 'movie' ? 'movie' : 'show';
    return (
      reply.MediaContainer.Metadata?.find(
        (item) => item.type === wanted && item.ratingKey
      )?.ratingKey ?? null
    );
  }
}

export default PlexListsAPI;
