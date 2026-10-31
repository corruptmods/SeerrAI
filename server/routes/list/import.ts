/**
 * Turning a pasted written list into titles, and committing the confirmed
 * matches onto a list.
 */
import TheMovieDb from '@server/api/themoviedb';
import TraktAPI, { parseTraktUrl, TraktError } from '@server/api/trakt';
import {
  CANDIDATES_PER_LINE,
  IMPORT_ITEM_LIMIT,
  IMPORT_LINE_LIMIT,
  REQUEST_BATCH_LIMIT,
  RESOLVE_BATCH_LIMIT,
} from '@server/constants/lists';
import { getRepository } from '@server/datasource';
import { MediaList, MediaListItem } from '@server/entity/MediaList';
import type { User } from '@server/entity/User';
import { loadAccessibleList } from '@server/lib/listAccess';
import { listTitle } from '@server/lib/listTitles';
import { requestMissing } from '@server/lib/requestMissing';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import type { ParsedLine } from '@server/utils/parseTitleList';
import { parseTitleList } from '@server/utils/parseTitleList';
import { tmdbImagePath } from '@server/utils/tmdbImagePath';
import { Router } from 'express';
import { In } from 'typeorm';

/**
 * The TMDB titles a written line may mean, best first: a year in the line
 * decides between namesakes, and "… series" puts collections first.
 */
const candidatesFor = async (tmdb: TheMovieDb, line: ParsedLine) => {
  const search = await tmdb.searchMulti({ query: line.title });

  const candidates = search.results
    .filter(
      (
        result
      ): result is typeof result & {
        media_type: 'movie' | 'tv' | 'collection';
      } =>
        result.media_type === 'movie' ||
        result.media_type === 'tv' ||
        result.media_type === 'collection'
    )
    .map((result) => {
      const isMovie = result.media_type === 'movie';
      const isCollection = result.media_type === 'collection';
      const date = isMovie
        ? (result as { release_date?: string }).release_date
        : (result as { first_air_date?: string }).first_air_date;

      return {
        tmdbId: result.id,
        mediaType: result.media_type,
        title: isCollection
          ? ((result as { title?: string; name?: string }).title ??
            (result as { name?: string }).name)
          : isMovie
            ? (result as { title?: string }).title
            : (result as { name?: string }).name,
        year: date ? Number(date.slice(0, 4)) : undefined,
        posterPath: (result as { poster_path?: string | null }).poster_path,
        popularity: (result as { popularity?: number }).popularity ?? 0,
      };
    });

  // A year in the pasted line is a strong signal; prefer an exact match
  // on it, then fall back to whatever TMDB thought was most popular.
  let ranked = line.year
    ? [
        ...candidates.filter((c) => c.year === line.year),
        ...candidates.filter((c) => c.year !== line.year),
      ]
    : candidates;

  // "Harmony Lane series" probably means the set — but "Grey Static
  // series" means a TV show, so a collection is only promoted to the top,
  // never forced. Both readings stay in the list.
  if (line.collectionHint) {
    ranked = [
      ...ranked.filter((c) => c.mediaType === 'collection'),
      ...ranked.filter((c) => c.mediaType !== 'collection'),
    ];
  }

  const shortlist = ranked.slice(0, CANDIDATES_PER_LINE);

  // Tell the user how many films a collection would add, so "Add" is not
  // a surprise.
  const withCounts = await mapWithConcurrency(shortlist, 2, async (c) => {
    if (c.mediaType !== 'collection') {
      return c;
    }

    try {
      const collection = await tmdb.getCollection({
        collectionId: c.tmdbId,
      });

      return { ...c, partCount: (collection.parts ?? []).length };
    } catch (e) {
      logger.debug('Could not read a collection while importing', {
        label: 'API',
        collectionId: c.tmdbId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });

      return { ...c, partCount: 0 };
    }
  });

  return {
    raw: line.raw,
    query: line.title,
    year: line.year,
    collectionHint: line.collectionHint,
    candidates: withCounts,
  };
};

const listRoutes = Router();

// Turns pasted text into candidate matches for review. Deliberately does not
// add anything: automatic title matching gets things wrong, so the user
// confirms before any of it lands on a list.
listRoutes.post('/import/search', isAuthenticated(), async (req, res, next) => {
  try {
    const text = String(req.body.text ?? '');

    if (!text.trim()) {
      return next({ status: 400, message: 'Nothing to import.' });
    }

    const lines = parseTitleList(text).slice(0, IMPORT_LINE_LIMIT);

    if (!lines.length) {
      return res.status(200).json({ results: [], truncated: false });
    }

    const tmdb = new TheMovieDb();

    const results = await mapWithConcurrency(lines, 4, (line) =>
      candidatesFor(tmdb, line)
    );

    return res.status(200).json({
      results,
      truncated: parseTitleList(text).length > IMPORT_LINE_LIMIT,
    });
  } catch (e) {
    logger.error('Failed to search imported titles', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Failed to read that list.' });
  }
});

/**
 * The films and series on a public Trakt list or watchlist, from a pasted
 * link. Trakt gives TMDB's id for nearly all of them; /import/resolve turns
 * them into matches to review, a batch at a time.
 */
listRoutes.post('/import/trakt', isAuthenticated(), async (req, res) => {
  const source = parseTraktUrl(String(req.body.url ?? ''));
  if (!source) {
    return res.status(400).json({
      message: 'That is not a link to a Trakt list or watchlist.',
      problem: 'notTrakt',
    });
  }
  const clientId = getSettings().trakt.clientId;
  if (!clientId) {
    return res.status(400).json({
      message: 'Trakt is not set up. An admin adds it in Settings → Services.',
      problem: 'notSetUp',
    });
  }
  try {
    const titles = await new TraktAPI(clientId).titles(source);
    return res.status(200).json({
      titles: titles.slice(0, IMPORT_ITEM_LIMIT).map((title) => ({
        mediaType: title.type === 'show' ? 'tv' : 'movie',
        tmdbId: title.tmdbId,
        title: title.title,
        year: title.year,
      })),
      truncated: titles.length > IMPORT_ITEM_LIMIT,
    });
  } catch (e) {
    if (e instanceof TraktError) {
      return res.status(400).json({ message: e.message, problem: e.problem });
    }
    logger.error('Failed to read a Trakt list', {
      label: 'Trakt',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return res
      .status(500)
      .json({ message: 'Failed to read that list.', problem: 'unreachable' });
  }
});

/**
 * Titles known by TMDB id (from Trakt) as matches to review, like a written
 * list's lines: each with its poster, and a search by name for the odd one
 * with no id, or an id TMDB no longer has.
 */
listRoutes.post(
  '/import/resolve',
  isAuthenticated(),
  async (req, res, next) => {
    type Entry = {
      tmdbId?: number;
      mediaType?: string;
      title?: string;
      year?: number;
    };
    const entries: Entry[] = Array.isArray(req.body.items)
      ? (req.body.items as Entry[]).slice(0, RESOLVE_BATCH_LIMIT)
      : [];
    try {
      const tmdb = new TheMovieDb();
      const results = await mapWithConcurrency(entries, 4, async (entry) => {
        const title = String(entry.title ?? '').trim();
        const year = Number.isInteger(entry.year) ? entry.year : undefined;
        const raw = year ? `${title} (${year})` : title;
        const tmdbId = Number(entry.tmdbId);
        if (Number.isInteger(tmdbId) && tmdbId > 0) {
          try {
            const mediaType = entry.mediaType === 'tv' ? 'tv' : 'movie';
            const found = await listTitle(tmdb, tmdbId, mediaType);
            const candidate = {
              tmdbId,
              mediaType,
              title: found.title,
              year: found.releaseDate
                ? Number(found.releaseDate.slice(0, 4))
                : undefined,
              posterPath: found.posterPath ?? null,
            };
            return { raw, query: title, year, candidates: [candidate] };
          } catch (e) {
            logger.debug('A Trakt title is not on TMDB under its id', {
              label: 'Trakt',
              tmdbId,
              errorMessage: e instanceof Error ? e.message : String(e),
            });
          }
        }
        return title
          ? candidatesFor(tmdb, { raw, title, year })
          : { raw, query: title, year, candidates: [] };
      });
      return res.status(200).json({ results });
    } catch (e) {
      logger.error('Failed to match Trakt titles', {
        label: 'Trakt',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      next({ status: 500, message: 'Failed to read that list.' });
    }
  }
);

listRoutes.post<{ listId: string }>(
  '/:listId/import',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const access = await loadAccessibleList(
        Number(req.params.listId),
        req.user?.id as number
      );

      if (!access) {
        return next({ status: 404, message: 'List not found.' });
      }
      // A playlist holds songs; films and series go on a watch list.
      if (access.list.kind === 'music') {
        return next({
          status: 400,
          message: 'Films and series go on a watch list, not a playlist.',
        });
      }

      type ImportEntry = {
        tmdbId?: number | string;
        mediaType?: string;
        posterPath?: string | null;
      };

      const items: ImportEntry[] = Array.isArray(req.body.items)
        ? (req.body.items as ImportEntry[])
        : [];
      const alsoRequest = req.body.request === true;

      if (!items.length) {
        return next({ status: 400, message: 'No titles selected.' });
      }

      const itemRepository = getRepository(MediaListItem);
      const tmdb = new TheMovieDb();
      let added = 0;
      let skipped = 0;
      let requested = 0;
      let requestFailed = 0;
      let notRequested = 0;

      /**
       * Resolve everything to a flat list of titles first, so the writes can
       * be batched. Previously each entry cost an existence check, an insert
       * and an optional request in sequence — a sixty-title import was a
       * hundred and eighty round trips in a row.
       */
      const resolved: {
        tmdbId: number;
        mediaType: 'movie' | 'tv';
        posterPath: string | null;
      }[] = [];

      const collections = items
        .slice(0, IMPORT_ITEM_LIMIT)
        .filter((entry) => entry.mediaType === 'collection');
      const plain = items
        .slice(0, IMPORT_ITEM_LIMIT)
        .filter((entry) => entry.mediaType !== 'collection');

      for (const entry of plain) {
        const tmdbId = Number(entry.tmdbId);

        if (!Number.isFinite(tmdbId)) {
          skipped++;
          continue;
        }

        resolved.push({
          tmdbId,
          mediaType: entry.mediaType === 'tv' ? 'tv' : 'movie',
          // Shown to everyone on the list; only a real TMDB path is kept.
          posterPath: tmdbImagePath(entry.posterPath),
        });
      }

      // A collection stands for its films; expand so the list holds real
      // titles rather than a reference to a set.
      const expanded = await mapWithConcurrency(
        collections,
        3,
        async (entry) => {
          const tmdbId = Number(entry.tmdbId);

          if (!Number.isFinite(tmdbId)) {
            skipped++;
            return [];
          }

          try {
            const collection = await tmdb.getCollection({
              collectionId: tmdbId,
            });

            return (collection.parts ?? []).map((part) => ({
              tmdbId: part.id,
              mediaType: 'movie' as const,
              posterPath: part.poster_path ?? null,
            }));
          } catch (e) {
            // Counted as skipped so the import still reports honestly, but
            // without this the user cannot tell which collection failed.
            logger.warn('Could not expand a collection on import', {
              label: 'API',
              collectionId: tmdbId,
              errorMessage: e instanceof Error ? e.message : String(e),
            });
            skipped++;
            return [];
          }
        }
      );

      // Each film of a collection counts towards the limit like any other
      // title, or a few collections could put thousands on a list at once.
      // Taken in the order they were chosen; the rest are reported skipped.
      for (const part of expanded.flat()) {
        if (resolved.length < IMPORT_ITEM_LIMIT) {
          resolved.push(part);
        } else {
          skipped++;
        }
      }

      // One query for what is already there, rather than one per title.
      const alreadyOnList = resolved.length
        ? await itemRepository.find({
            select: { tmdbId: true, mediaType: true },
            where: {
              listId: access.list.id,
              tmdbId: In(resolved.map((entry) => entry.tmdbId)),
            },
          })
        : [];

      const present = new Set(
        alreadyOnList.map((item) => `${item.mediaType}:${item.tmdbId}`)
      );
      const seen = new Set<string>();
      const toInsert: typeof resolved = [];

      for (const entry of resolved) {
        const key = `${entry.mediaType}:${entry.tmdbId}`;

        // Already on the list, or listed twice in the same import.
        if (present.has(key) || seen.has(key)) {
          skipped++;
          continue;
        }

        seen.add(key);
        toInsert.push(entry);
      }

      if (toInsert.length) {
        await itemRepository.save(
          toInsert.map(
            (entry) =>
              new MediaListItem({
                listId: access.list.id,
                tmdbId: entry.tmdbId,
                mediaType: entry.mediaType,
                posterPath: entry.posterPath,
                addedById: req.user?.id,
              })
          )
        );

        added = toInsert.length;

        /*
         * One at a time. Each request reads and writes several rows and then
         * dispatches to Radarr or Sonarr, so running them in parallel meant
         * concurrent queries on a shared connection — the thing pg warns
         * about — for no real gain, since the dispatch is the slow part and
         * the *arr instances are happier fed steadily anyway.
         */
        // Bounded like "request what's missing": a pasted list of a hundred
        // titles, or a collection or two, would otherwise send a hundred
        // requests to Radarr and Sonarr from one click. The rest stay on the
        // list, where they can be requested in turn.
        const toRequest = alsoRequest
          ? toInsert.slice(0, REQUEST_BATCH_LIMIT)
          : [];
        notRequested = alsoRequest ? toInsert.length - toRequest.length : 0;

        for (const entry of toRequest) {
          const { outcome } = await requestMissing(
            entry.tmdbId,
            entry.mediaType,
            req.user as User
          );
          if (outcome === 'requested') {
            requested++;
          } else if (outcome === 'failed') {
            requestFailed++;
          }
        }
      }

      if (added) {
        // Touch the list so recency ordering reflects the import. Saving the
        // loaded entity would also re-persist whatever relations came with
        // it, which is how sharing broke; only the timestamp needs writing.
        await getRepository(MediaList).update(access.list.id, {
          updatedAt: new Date(),
        });
      }

      return res
        .status(200)
        .json({ added, skipped, requested, requestFailed, notRequested });
    } catch (e) {
      logger.error('Failed to import titles', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to import titles.' });
    }
  }
);

export default listRoutes;
