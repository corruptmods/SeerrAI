import ExternalAPI from '@server/api/externalapi';
import { getAppVersion } from '@server/utils/appVersion';
import { isAxiosError } from 'axios';

/*
 * Trakt, read with only an app's Client ID: public lists and public
 * watchlists, nobody signing in. Each admin makes their own Trakt app
 * (developer.trakt.tv/apps) and pastes its Client ID into Settings; Trakt
 * deletes apps unused for 30 days, which the watchlist sync's regular use
 * prevents.
 *
 * Shapes and paths are Trakt's API v2 as its own contract describes them
 * (github.com/trakt/trakt-api). Since 2026 lists and watchlists are paged
 * even when no page is asked for, up to 250 items a page.
 */

const BASE_URL = 'https://api.trakt.tv';
const PAGE_LIMIT = 250;
/** Enough for any real list or watchlist; a runaway one stops here. */
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

/** A film or series from Trakt, with what Seerr AI needs of it. */
export interface TraktTitle {
  type: 'movie' | 'show';
  title: string;
  year?: number;
  /** Missing for the odd entry Trakt could not match to TMDB. */
  tmdbId?: number;
  tvdbId?: number;
  /** When it went on the list, in seconds since 1970. */
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
  /** Trakt did not answer, or answered with an error of its own. */
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

const SLUG = /^[\w.-]+$/;

/**
 * Reads a link from trakt.tv or app.trakt.tv (or the same without the
 * scheme): a user's list, a user's watchlist, or a list by its number.
 * Undefined for anything else, including a list's private share link, which
 * the API cannot read.
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
  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));

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
          // Trakt's Cloudflare turns away requests with no User-Agent, and
          // its policy asks apps to name themselves.
          'User-Agent': `SeerrAI/${getAppVersion()}`,
        },
      }
    );
  }

  /** Whether the Client ID is accepted, with the cheapest call Trakt has. */
  public async check(): Promise<void> {
    await this.call(() => this.axios.get('/genres/movies'));
  }

  /** The films and series on a public list or watchlist, in list order. */
  public async titles(source: TraktSource): Promise<TraktTitle[]> {
    const path =
      source.kind === 'watchlist'
        ? `/users/${encodeURIComponent(source.user)}/watchlist/movie,show`
        : source.kind === 'list'
          ? `/users/${encodeURIComponent(source.user)}/lists/${encodeURIComponent(source.list)}/items/movie,show`
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
   * The titles most recently put on someone's public watchlist, newest
   * first: as for Plex, sync acts on recent additions, so a long-kept
   * watchlist is not requested all at once.
   */
  public async recentWatchlist(
    user: string,
    count = 20
  ): Promise<TraktTitle[]> {
    const response = await this.call(() =>
      this.axios.get<TraktListItem[]>(
        `/users/${encodeURIComponent(user)}/watchlist/movie,show/added/desc`,
        { params: { page: 1, limit: 100 } }
      )
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
