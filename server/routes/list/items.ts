/**
 * Titles on a list, what the current user has marked, and the watched-state
 * suggestions that follow from it.
 */
import TheMovieDb from '@server/api/themoviedb';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import {
  MediaList,
  MediaListItem,
  MediaListMember,
  MediaListWatchSuggestion,
} from '@server/entity/MediaList';
import { MediaRequest } from '@server/entity/MediaRequest';
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import type { User } from '@server/entity/User';
import { featureEnabled } from '@server/lib/features';
import { loadAccessibleList } from '@server/lib/listAccess';
import { notifyListActivity } from '@server/lib/listActivity';
import { refreshWatchSuggestions } from '@server/lib/listWatchSync';
import { getSeriesProgress } from '@server/lib/seriesProgress';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { Router } from 'express';
import { In, IsNull } from 'typeorm';

const listRoutes = Router();

listRoutes.get('/markers', isAuthenticated(), async (req, res, next) => {
  try {
    const userId = req.user?.id as number;

    const owned = await getRepository(MediaList).find({
      select: { id: true },
      where: { ownerId: userId },
    });

    const memberships = await getRepository(MediaListMember).find({
      select: { listId: true },
      where: { userId },
    });

    const listIds = [
      ...new Set([
        ...owned.map((list) => list.id),
        ...memberships.map((member) => member.listId),
      ]),
    ];

    const onLists = listIds.length
      ? await getRepository(MediaListItem).find({
          select: { tmdbId: true, mediaType: true },
          where: { listId: In(listIds) },
        })
      : [];

    // Titles this user will hear about: their own live requests unless muted,
    // plus anything they have explicitly asked to watch.
    const ownRequests = await getRepository(MediaRequest).find({
      where: {
        requestedBy: { id: userId },
        status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
        requesterMuted: false,
      },
      relations: { media: true },
    });

    const watched = await getRepository(MediaRequestWatcher).find({
      where: { userId },
      relations: { request: { media: true } },
    });

    const notify = [...ownRequests, ...watched.map((w) => w.request)]
      .filter((request) => request?.media)
      .map((request) => ({
        tmdbId: request.media.tmdbId,
        mediaType: request.media.mediaType,
      }));

    return res.status(200).json({
      lists: onLists.map((item) => ({
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
      })),
      notify,
    });
  } catch (e) {
    logger.error('Failed to load markers', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Failed to load markers.' });
  }
});

listRoutes.get('/contains', isAuthenticated(), async (req, res, next) => {
  try {
    const userId = req.user?.id as number;
    const tmdbId = Number(req.query.tmdbId);
    const mediaType = req.query.mediaType === 'tv' ? 'tv' : 'movie';

    if (!Number.isFinite(tmdbId)) {
      return next({ status: 400, message: 'A valid tmdbId is required.' });
    }

    const owned = await getRepository(MediaList).find({
      where: { ownerId: userId },
    });
    const memberships = await getRepository(MediaListMember).find({
      where: { userId },
    });

    const accessibleIds = [
      ...owned.map((l) => l.id),
      ...memberships.map((m) => m.listId),
    ];

    if (!accessibleIds.length) {
      return res.status(200).json([]);
    }

    const items = await getRepository(MediaListItem).find({
      where: { listId: In(accessibleIds), tmdbId, mediaType },
    });

    const lists = await getRepository(MediaList).find({
      where: { id: In(items.map((item) => item.listId)) },
    });

    return res.status(200).json(
      items.map((item) => ({
        listId: item.listId,
        listName: lists.find((list) => list.id === item.listId)?.name ?? '',
      }))
    );
  } catch (e) {
    logger.error('Failed to check list membership', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Failed to check lists.' });
  }
});

// Pending removal suggestions for the caller's own lists. Fetched when the
// app loads, which is also when the Tautulli check runs (throttled), so the
// prompt is ready rather than computed while the user waits.

/*
 * Where the viewer is in each series on a list, from their Plex watch history
 * in Tautulli. Each person sees their own position on a shared list.
 */
listRoutes.get<{ listId: string }>(
  '/:listId/progress',
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

      const items = await getRepository(MediaListItem).find({
        select: { tmdbId: true, mediaType: true },
        where: { listId: access.list.id, mediaType: MediaType.TV },
      });

      return res.status(200).json(
        await getSeriesProgress(
          req.user as User,
          items.map((item) => item.tmdbId)
        )
      );
    } catch (e) {
      logger.error('Failed to load series progress', {
        label: 'API',
        errorMessage: e instanceof Error ? e.message : String(e),
      });

      return next({ status: 500, message: 'Unable to load progress.' });
    }
  }
);

listRoutes.get('/suggestions', isAuthenticated(), async (req, res, next) => {
  try {
    // Turned off: no Tautulli check, and nothing suggested.
    if (!featureEnabled('watchSuggestions', req.user)) {
      return res.status(200).json([]);
    }
    // A Tautulli that is unreachable should cost the user this refresh, not
    // the suggestions already stored from previous checks.
    try {
      await refreshWatchSuggestions(req.user as User);
    } catch (e) {
      logger.debug('Could not refresh watch suggestions', {
        label: 'API',
        userId: req.user?.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }

    const lists = await getRepository(MediaList).find({
      where: { ownerId: req.user?.id as number, watchedSync: true },
    });

    if (!lists.length) {
      return res.status(200).json([]);
    }

    const suggestions = await getRepository(MediaListWatchSuggestion).find({
      where: {
        listId: In(lists.map((list) => list.id)),
        dismissedAt: IsNull(),
      },
    });

    const tmdb = new TheMovieDb();

    const hydrated = await mapWithConcurrency(
      suggestions,
      3,
      async (suggestion) => {
        const base = {
          id: suggestion.id,
          listId: suggestion.listId,
          listName:
            lists.find((list) => list.id === suggestion.listId)?.name ?? '',
          tmdbId: suggestion.item?.tmdbId,
          mediaType: suggestion.item?.mediaType,
        };

        try {
          if (suggestion.item?.mediaType === 'movie') {
            const movie = await tmdb.getMovie({ movieId: base.tmdbId });
            return {
              ...base,
              title: movie.title,
              posterPath: movie.poster_path,
            };
          }

          const tv = await tmdb.getTvShow({ tvId: base.tmdbId });
          return { ...base, title: tv.name, posterPath: tv.poster_path };
        } catch (e) {
          logger.debug('Could not hydrate a list preview', {
            label: 'API',
            tmdbId: base.tmdbId,
            errorMessage: e instanceof Error ? e.message : String(e),
          });

          return base;
        }
      }
    );

    return res.status(200).json(hydrated);
  } catch (e) {
    logger.error('Failed to fetch watch suggestions', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Failed to fetch suggestions.' });
  }
});

listRoutes.post<{ suggestionId: string }>(
  '/suggestions/:suggestionId',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const suggestionRepository = getRepository(MediaListWatchSuggestion);

      const suggestion = await suggestionRepository.findOne({
        where: { id: Number(req.params.suggestionId) },
        relations: { list: true },
      });

      if (!suggestion || suggestion.list?.ownerId !== req.user?.id) {
        return next({ status: 404, message: 'Suggestion not found.' });
      }

      if (req.body.action === 'remove') {
        // Removing the item cascades the suggestion away with it.
        await getRepository(MediaListItem).delete({ id: suggestion.itemId });

        return res.status(200).json({ removed: true });
      }

      // Kept: never suggest this title again for this list.
      suggestion.dismissedAt = new Date();
      await suggestionRepository.save(suggestion);

      return res.status(200).json({ removed: false });
    } catch (e) {
      logger.error('Failed to act on watch suggestion', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to update suggestion.' });
    }
  }
);

// Turns pasted text into candidate matches for review. Deliberately does not
// add anything: automatic title matching gets things wrong, so the user
// confirms before any of it lands on a list.

listRoutes.post<{ listId: string }>(
  '/:listId/item',
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

      const tmdbId = Number(req.body.tmdbId);
      const mediaType = req.body.mediaType === 'tv' ? 'tv' : 'movie';

      if (!Number.isFinite(tmdbId)) {
        return next({ status: 400, message: 'A valid tmdbId is required.' });
      }

      const itemRepository = getRepository(MediaListItem);

      const existing = await itemRepository.findOne({
        where: { listId: access.list.id, tmdbId, mediaType },
      });

      if (!existing) {
        // Store the poster now so the overview and the roulette never depend
        // on a live TMDB lookup to draw artwork.
        let posterPath: string | null = null;

        try {
          const tmdbClient = new TheMovieDb();
          posterPath =
            (mediaType === 'movie'
              ? (await tmdbClient.getMovie({ movieId: tmdbId })).poster_path
              : (await tmdbClient.getTvShow({ tvId: tmdbId })).poster_path) ??
            null;
        } catch (e) {
          // Backfilled on the next overview load.
          logger.debug('Could not store a poster when adding to a list', {
            label: 'API',
            tmdbId,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }

        await itemRepository.save(
          new MediaListItem({
            listId: access.list.id,
            tmdbId,
            mediaType,
            posterPath,
            addedById: req.user?.id,
          })
        );

        // Touch the list so recency ordering reflects activity. Updated by
        // id rather than saving the loaded entity, which would re-persist the
        // relations loaded alongside it.
        await getRepository(MediaList).update(access.list.id, {
          updatedAt: new Date(),
        });

        await notifyListActivity(
          access.list,
          { tmdbId, mediaType },
          'added',
          req.user as User
        );
      }

      return res.status(200).json({ added: true });
    } catch (e) {
      logger.error('Failed to add list item', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to add to list.' });
    }
  }
);

listRoutes.post<{ listId: string }>(
  '/:listId/item/watched',
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

      const tmdbId = Number(req.body.tmdbId);
      const mediaType = req.body.mediaType === 'tv' ? 'tv' : 'movie';
      const watched = req.body.watched !== false;

      if (!Number.isFinite(tmdbId)) {
        return next({ status: 400, message: 'A valid tmdbId is required.' });
      }

      const itemRepository = getRepository(MediaListItem);
      const item = await itemRepository.findOne({
        where: { listId: access.list.id, tmdbId, mediaType },
      });

      if (!item) {
        return next({ status: 404, message: 'Item not on this list.' });
      }

      const wasWatched = !!item.watchedAt;
      item.watchedAt = watched ? new Date() : null;
      item.watchedById = watched ? (req.user?.id ?? null) : null;
      await itemRepository.save(item);

      // Only announce the transition into watched, and only if it changed.
      if (watched && !wasWatched) {
        await notifyListActivity(
          access.list,
          { tmdbId, mediaType },
          'watched',
          req.user as User
        );
      }

      return res.status(200).json({ watched });
    } catch (e) {
      logger.error('Failed to update watched state', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to update watched state.' });
    }
  }
);

listRoutes.delete<{ listId: string }>(
  '/:listId/item',
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

      const tmdbId = Number(req.query.tmdbId);
      const mediaType = req.query.mediaType === 'tv' ? 'tv' : 'movie';

      if (!Number.isFinite(tmdbId)) {
        return next({ status: 400, message: 'A valid tmdbId is required.' });
      }

      const { affected } = await getRepository(MediaListItem).delete({
        listId: access.list.id,
        tmdbId,
        mediaType,
      });

      if (affected) {
        await notifyListActivity(
          access.list,
          { tmdbId, mediaType },
          'removed',
          req.user as User
        );
      }

      return res.status(200).json({ added: false });
    } catch (e) {
      logger.error('Failed to remove list item', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to remove from list.' });
    }
  }
);

export default listRoutes;
