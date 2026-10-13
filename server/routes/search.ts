import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbCollectionResult,
  TmdbSearchCollectionResponse,
  TmdbSearchMultiResponse,
} from '@server/api/themoviedb/interfaces';
import Media from '@server/entity/Media';
import { findSearchProvider } from '@server/lib/search';
import logger from '@server/logger';
import { mapSearchResults } from '@server/models/Search';
import { Router } from 'express';

const searchRoutes = Router();

/*
 * TMDB's search across everything never returns collections, so they are
 * searched for on their own. Page N of search holds page N of each. The
 * first page of collections (cached, like every page) says how many there
 * are, so pages past the last one are not asked for at all. A collection
 * search that fails leaves the rest of the search as it was.
 */
const searchCollections = async (
  tmdb: TheMovieDb,
  query: string,
  page: number,
  language: string
): Promise<TmdbSearchCollectionResponse> => {
  try {
    const first = await tmdb.searchCollection({ query, language });

    if (page === 1) {
      return first;
    }

    if (page > first.total_pages) {
      return { ...first, page, results: [] };
    }

    return await tmdb.searchCollection({ query, page, language });
  } catch (e) {
    logger.debug('Collections were left out of search results', {
      label: 'API',
      errorMessage: e.message,
      query,
    });
    return { page, results: [], total_pages: 0, total_results: 0 };
  }
};

const toCollectionResult = (
  collection: TmdbSearchCollectionResponse['results'][number]
): TmdbCollectionResult => ({
  id: collection.id,
  media_type: 'collection',
  title: collection.name,
  original_title: collection.original_name ?? collection.name,
  overview: collection.overview ?? '',
  original_language: collection.original_language ?? '',
  adult: collection.adult ?? false,
  poster_path: collection.poster_path ?? undefined,
  backdrop_path: collection.backdrop_path ?? undefined,
});

searchRoutes.get('/', async (req, res, next) => {
  const queryString = req.query.query as string;
  const searchProvider = findSearchProvider(queryString.toLowerCase());
  let results: TmdbSearchMultiResponse;

  try {
    if (searchProvider) {
      const [id] = queryString
        .toLowerCase()
        .match(searchProvider.pattern) as RegExpMatchArray;
      results = await searchProvider.search({
        id,
        language: (req.query.language as string) ?? req.locale,
        query: queryString,
      });
    } else {
      const tmdb = new TheMovieDb();
      const page = Number(req.query.page) || 1;
      const language = (req.query.language as string) ?? req.locale;

      const [multi, collections] = await Promise.all([
        tmdb.searchMulti({ query: queryString, page, language }),
        searchCollections(tmdb, queryString, page, language),
      ]);

      // Collections lead the page: a franchise's name is usually what was
      // typed. Search goes on for as long as either has more pages.
      results = {
        page,
        total_pages: Math.max(multi.total_pages, collections.total_pages),
        total_results: multi.total_results + collections.total_results,
        results: [
          ...collections.results.map(toCollectionResult),
          ...multi.results,
        ],
      };
    }

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: result.media_type,
      }))
    );

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: mapSearchResults(results.results, media),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve search results.',
    });
  }
});

searchRoutes.get('/keyword', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.searchKeyword({
      query: req.query.query as string,
      page: Number(req.query.page),
    });

    return res.status(200).json(results);
  } catch (e) {
    logger.debug('Something went wrong retrieving keyword search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve keyword search results.',
    });
  }
});

searchRoutes.get('/company', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.searchCompany({
      query: req.query.query as string,
      page: Number(req.query.page),
    });

    return res.status(200).json(results);
  } catch (e) {
    logger.debug('Something went wrong retrieving company search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve company search results.',
    });
  }
});

export default searchRoutes;
