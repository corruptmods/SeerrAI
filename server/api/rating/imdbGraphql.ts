import ExternalAPI from '@server/api/externalapi';
import type { IMDBRating } from '@server/api/rating/imdbRadarrProxy';
import cacheManager from '@server/lib/cache';

interface IMDBTitleResponse {
  data?: {
    title: {
      id: string;
      titleText?: { text: string } | null;
      ratingsSummary?: {
        aggregateRating: number | null;
        voteCount: number | null;
      } | null;
    } | null;
  };
  errors?: { message: string }[];
}

const TITLE_RATING_QUERY = `query TitleRating($id: ID!) {
  title(id: $id) {
    id
    titleText { text }
    ratingsSummary { aggregateRating voteCount }
  }
}`;

/** The rating in a reply, or null when the title has none (yet). */
export const ratingFromResponse = (
  imdbId: string,
  response: IMDBTitleResponse
): IMDBRating | null => {
  const title = response.data?.title;
  const rating = title?.ratingsSummary?.aggregateRating;
  if (!title || title.id !== imdbId || typeof rating !== 'number') {
    return null;
  }
  return {
    title: title.titleText?.text ?? '',
    url: `https://www.imdb.com/title/${imdbId}`,
    criticsScore: rating,
    criticsScoreCount: title.ratingsSummary?.voteCount ?? 0,
  };
};

/**
 * IMDb user ratings for any title, series included, from the API IMDb's own
 * site uses. Radarr's proxy (IMDBRadarrProxy) only knows movies, so series
 * ratings come from here. Like that proxy it is best-effort: unofficial, and
 * for limited non-commercial use, which a private Seerr is.
 */
class IMDBGraphQL extends ExternalAPI {
  constructor() {
    super(
      'https://api.graphql.imdb.com',
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        nodeCache: cacheManager.getCache('imdb').data,
        timeout: 10000,
      }
    );
  }

  public async getRatings(imdbId: string): Promise<IMDBRating | null> {
    if (!/^tt\d+$/.test(imdbId)) {
      return null;
    }
    const body = { query: TITLE_RATING_QUERY, variables: { id: imdbId } };
    try {
      const response = await this.post<IMDBTitleResponse>(
        '/',
        body,
        undefined,
        43200
      );
      if (response.errors?.length && !response.data?.title) {
        // GraphQL reports failures in a successful reply: don't keep it.
        this.removeCache('/', { data: body });
        throw new Error(response.errors[0].message);
      }
      return ratingFromResponse(imdbId, response);
    } catch (e) {
      throw new Error(
        `[IMDB GRAPHQL API] Failed to retrieve ratings: ${e.message}`,
        { cause: e }
      );
    }
  }
}

export default IMDBGraphQL;
