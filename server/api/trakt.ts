import ExternalAPI from '@server/api/externalapi';
import { getAppVersion } from '@server/utils/appVersion';
import { isAxiosError } from 'axios';

/*
 * Reads public Trakt lists and watchlists with only an app Client ID, no
 * sign-in. Each admin creates a Trakt app (developer.trakt.tv/apps) and
 * pastes its Client ID into Settings; Trakt deletes apps unused for 30 days,
 * which regular watchlist sync prevents.
 *
 * Shapes and paths follow Trakt API v2 (github.com/trakt/trakt-api). Since
 * 2026 lists and watchlists are always paged, up to 250 items a page.
 */

const BASE_URL = 'https://api.trakt.tv';
const PAGE_LIMIT = 250;
/** Enough for any real list; stops a runaway one. */
const MAX_PAGES = 20;

export interface TraktIds {
  trakt: number;
  slug?: string;
  imdb?: string | null;
  tmdb?: number | null;
  tvdb?: number | null;
}

interface TraktMedia {
  title: string;
  year?: number | null;
  ids: TraktIds;
}

/** One entry of a list or watchlist. */
export interface TraktListItem {
  rank?: number;
  listed_at?: string;
  type: 'movie' | 'show' | 'season' | 'episode' | string;
  movie?: TraktMedia | null;
  show?: TraktMedia | null;
}

/** A movie or series from Trakt, with the fields Seerr AI uses. */
export interface TraktTitle {
  type: 'movie' | 'show';
  title: string;
  year?: number;
  /** Missing when Trakt could not match the entry to TMDB. */
  tmdbId?: number;
  tvdbId?: number;
  /** When listed, in Unix seconds. */
  listedAt?: number;
}

/** Where a pasted Trakt link points. */
export type TraktSource =
  | { kind: 'list'; user: string; list: string }
  | { kind: 'watchlist'; user: string }
  | { kind: 'listId'; id: string };

export type TraktProblem =
  /** The Client ID was refused, or Trakt has not approved the app. */
  | 'badKey'
  /** The list or watchlist is private, or the user's profile is. */
  | 'private'
  /** No such user or list. */
  | 'notFound'
  | 'rateLimited'
  /** Trakt did not answer, or returned an error. */
  | 'unreachable';

export class TraktError extends Error {
  constructor(
    public readonly problem: TraktProblem,
    message: string
  ) {
    super(message);
    this.name = 'TraktError';
  }
}

/**
 * A Trakt username or list slug. Not dots alone: "." and ".." are path
 * steps and would change the requested address.
 */
const SLUG = /^(?!\.+$)[\w.-]+$/;

/** Validates a username or slug for use in an API path. */
const pathPart = (name: string): string => {
  if (!SLUG.test(name)) {
    throw new TraktError('notFound', `"${name}" is not a Trakt name.`);
  }
  return encodeURIComponent(name);
};

/**
 * Parses a trakt.tv or app.trakt.tv link (scheme optional): a user's list,
 * a user's watchlist, or a list by number. Undefined otherwise, including a
 * private share link, which the API cannot read.
 */
export const parseTraktUrl = (text: string): TraktSource | undefined => {
  const trimmed = text.trim();
  if (!/^(https?:\/\/)?(www\.|app\.)?trakt\.tv\//i.test(trimmed)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    );
  } catch {
    return undefined;
  }
  let parts: string[];
  try {
    parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    // A stray % that decodes to nothing.
    return undefined;
  }

  if (parts[0] === 'users' && parts[1] && SLUG.test(parts[1])) {
    if (parts[2] === 'watchlist' && parts.length === 3) {
      return { kind: 'watchlist', user: parts[1] };
    }
    if (parts[2] === 'lists' && parts[3] && SLUG.test(parts[3])) {
      return { kind: 'list', user: parts[1], list: parts[3] };
    }
  }
  if (parts[0] === 'lists' && parts[1] && /^\d+$/.test(parts[1])) {
    return { kind: 'listId', id: parts[1] };
  }
  return undefined;
};

const asTitle = (item: TraktListItem): TraktTitle | undefined => {
  const media =
    item.type === 'movie'
      ? item.movie
      : item.type === 'show'
        ? item.show
        : null;
  if (!media?.title) {
    return undefined;
  }
  const listedAt = item.listed_at ? Date.parse(item.listed_at) : NaN;
  return {
    type: item.type as 'movie' | 'show',
    title: media.title,
    year: media.year ?? undefined,
    tmdbId: media.ids?.tmdb ?? undefined,
    tvdbId: media.ids?.tvdb ?? undefined,
    listedAt: Number.isFinite(listedAt)
      ? Math.floor(listedAt / 1000)
      : undefined,
  };
};

class TraktAPI extends ExternalAPI {
  constructor(clientId: string, baseUrl = BASE_URL) {
    super(
      baseUrl,
      {},
      {
        timeout: 20_000,
        headers: {
          'trakt-api-version': '2',
          'trakt-api-key': clientId,
          // Trakt's Cloudflare rejects requests without a User-Agent, and its
          // policy asks apps to name themselves.
          'User-Agent': `SeerrAI/${getAppVersion()}`,
        },
      }
    );
  }

  /** Checks the Client ID with Trakt's cheapest call. */
  public async check(): Promise<void> {
    await this.call(() => this.axios.get('/genres/movies'));
  }

  /** Movies and series on a public list or watchlist, in list order. */
  public async titles(source: TraktSource): Promise<TraktTitle[]> {
    const path =
      source.kind === 'watchlist'
        ? `/users/${pathPart(source.user)}/watchlist/movie,show`
        : source.kind === 'list'
          ? `/users/${pathPart(source.user)}/lists/${pathPart(source.list)}/items/movie,show`
          : `/lists/${encodeURIComponent(source.id)}/items/movie,show`;
    const items: TraktListItem[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await this.call(() =>
        this.axios.get<TraktListItem[]>(path, {
          params: { page, limit: PAGE_LIMIT },
        })
      );
      items.push(...(Array.isArray(response.data) ? response.data : []));
      const pages = Number(response.headers['x-pagination-page-count']);
      if (!Number.isFinite(pages) || page >= pages) {
        break;
      }
    }
    return items.map(asTitle).filter((title): title is TraktTitle => !!title);
  }

  /**
   * The newest titles on a public watchlist, newest first. As with Plex, sync
   * acts on recent additions so a long watchlist isn't requested all at once.
   */
  public async recentWatchlist(
    user: string,
    count = 20
  ): Promise<TraktTitle[]> {
    const path = `/users/${pathPart(user)}/watchlist/movie,show/added/desc`;
    const response = await this.call(() =>
      this.axios.get<TraktListItem[]>(path, {
        params: { page: 1, limit: 100 },
      })
    );
    return (Array.isArray(response.data) ? response.data : [])
      .map(asTitle)
      .filter((title): title is TraktTitle => !!title)
      .sort((a, b) => (b.listedAt ?? 0) - (a.listedAt ?? 0))
      .slice(0, count);
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (e) {
      if (!isAxiosError(e) || !e.response) {
        throw new TraktError(
          'unreachable',
          'Could not reach Trakt. Try again in a while.'
        );
      }
      const status = e.response.status;
      if (status === 403) {
        throw new TraktError(
          'badKey',
          'Trakt did not accept the Client ID. Check it in Settings → Services → Trakt, and that the Trakt app is approved.'
        );
      }
      if (status === 401 || status === 423) {
        throw new TraktError(
          'private',
          'That Trakt list or watchlist is private. Make it public on Trakt, then try again.'
        );
      }
      if (status === 404) {
        throw new TraktError(
          'notFound',
          'Trakt has no such user or list. Check the link.'
        );
      }
      if (status === 429) {
        throw new TraktError(
          'rateLimited',
          'Trakt is limiting requests just now. Try again in a few minutes.'
        );
      }
      throw new TraktError(
        'unreachable',
        `Trakt answered with an error (${status}). Try again in a while.`
      );
    }
  }
}

export default TraktAPI;
