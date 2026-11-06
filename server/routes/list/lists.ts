/** Creating, reading, sharing and deleting lists. */
import TheMovieDb from '@server/api/themoviedb';
import { POSTER_BACKFILL_LIMIT } from '@server/constants/lists';
import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import type { MediaListKind } from '@server/entity/MediaList';
import {
  MediaList,
  MediaListItem,
  MediaListMember,
  MediaListSong,
} from '@server/entity/MediaList';
import { User } from '@server/entity/User';
import { warmTmdbImages } from '@server/lib/imageproxy';
import { limitToLibraries } from '@server/lib/libraryVisibility';
import { loadAccessibleList } from '@server/lib/listAccess';
import { notifyListShared } from '@server/lib/listActivity';
import { listTitle } from '@server/lib/listTitles';
import { musicAllowed, playlistView } from '@server/lib/playlists/view';
import { getSettings } from '@server/lib/settings';
import { watchSource } from '@server/lib/watchHistory';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { Router } from 'express';
import { In, IsNull, Not } from 'typeorm';

const listRoutes = Router();

/** Max posters cache-warmed per list card, and per page. */
const PREVIEWS_WARMED = 9;
const PREVIEWS_WARMED_TOTAL = 90;

/**
 * Posters sent per list card. A card rotates a few at a time, so a long list
 * doesn't need all of them.
 */
const PREVIEWS_PER_LIST = 30;

listRoutes.get('/', isAuthenticated(), async (req, res, next) => {
  try {
    const userId = req.user?.id as number;
    const listRepository = getRepository(MediaList);

    const owned = await listRepository.find({
      where: { ownerId: userId },
      relations: { members: true, items: true },
      order: { updatedAt: 'DESC' },
    });

    const memberships = await getRepository(MediaListMember).find({
      where: { userId },
    });

    const sharedIds = memberships.map((m) => m.listId);
    const shared = sharedIds.length
      ? await listRepository.find({
          where: { id: In(sharedIds) },
          relations: { members: true, items: true },
          order: { updatedAt: 'DESC' },
        })
      : [];

    // Overview artwork. Poster paths are stored on items, so this normally
    // makes no TMDB calls.
    const tmdb = new TheMovieDb();
    const all = [...owned, ...shared];

    // Backfill missing posters, bounded and written back so it happens once.
    // Interleaved across lists so one large list can't use the whole budget
    // and leave other cards blank.
    const queues = all.map((list) =>
      (list.items ?? []).filter((item) => !item.posterPath)
    );
    const missing: MediaListItem[] = [];

    for (
      let round = 0;
      missing.length < POSTER_BACKFILL_LIMIT &&
      queues.some((queue) => queue.length > round);
      round++
    ) {
      for (const queue of queues) {
        if (missing.length >= POSTER_BACKFILL_LIMIT) {
          break;
        }

        if (queue[round]) {
          missing.push(queue[round]);
        }
      }
    }

    if (missing.length) {
      const itemRepository = getRepository(MediaListItem);

      // Fetch in parallel (TMDB is slow) but write in one pass afterwards:
      // writes interleaved with fetches would trigger pg's "client is already
      // executing a query" warning.
      const fetched = await mapWithConcurrency(missing, 4, async (item) => {
        try {
          const { posterPath } = await listTitle(
            tmdb,
            item.tmdbId,
            item.mediaType
          );

          return posterPath ? { item, posterPath } : null;
        } catch (e) {
          // Retried on the next load rather than failing the page; logged so a
          // poster that never resolves doesn't retry silently forever.
          logger.debug('Could not backfill a list poster', {
            label: 'API',
            tmdbId: item.tmdbId,
            errorMessage: e instanceof Error ? e.message : String(e),
          });

          return null;
        }
      });

      for (const entry of fetched) {
        if (!entry) {
          continue;
        }

        entry.item.posterPath = entry.posterPath;
        await itemRepository.update(entry.item.id, {
          posterPath: entry.posterPath,
        });
      }
    }

    const previewsByList = new Map<number, unknown[]>();

    for (const list of all) {
      const items = list.items ?? [];

      // Prefer unwatched titles: a card of finished ones says little.
      const outstanding = items.filter((item) => !item.watchedAt);
      const source = outstanding.length ? outstanding : items;

      previewsByList.set(
        list.id,
        source
          .filter((item) => item.posterPath)
          .slice(0, PREVIEWS_PER_LIST)
          .map((item) => ({ tmdbId: item.tmdbId, posterPath: item.posterPath }))
      );
    }

    // Warm the image cache with card posters as the page goes out. Cards
    // start on posters from anywhere in their lists, so warm a share of each,
    // capped per page.
    if (getSettings().main.cacheImages) {
      const paths = [...previewsByList.values()]
        .flatMap((previews) =>
          (previews as { posterPath: string }[]).slice(0, PREVIEWS_WARMED)
        )
        .slice(0, PREVIEWS_WARMED_TOTAL)
        .map((preview) => `/t/p/w342${preview.posterPath}`);
      setImmediate(() => warmTmdbImages(paths));
    }

    // Playlist cards show their songs' album covers.
    const playlistIds = all.filter((l) => l.kind === 'music').map((l) => l.id);
    const playlistSongs = playlistIds.length
      ? await getRepository(MediaListSong).find({
          select: { listId: true, albumMbid: true, state: true },
          where: { listId: In(playlistIds), state: Not('removed') },
          order: { position: 'ASC' },
        })
      : [];

    return res.status(200).json(
      all.map((list) => ({
        id: list.id,
        name: list.name,
        kind: list.kind ?? 'watch',
        owner: { id: list.owner.id, displayName: list.owner.displayName },
        isOwner: list.ownerId === userId,
        itemCount:
          list.kind === 'music'
            ? playlistSongs.filter((s) => s.listId === list.id).length
            : (list.items ?? []).length,
        covers:
          list.kind === 'music'
            ? [
                ...new Set(
                  playlistSongs
                    .filter((s) => s.listId === list.id && s.albumMbid)
                    .map((s) => s.albumMbid as string)
                ),
              ].slice(0, PREVIEWS_PER_LIST)
            : undefined,
        watchedCount: (list.items ?? []).filter((item) => !!item.watchedAt)
          .length,
        memberCount: (list.members ?? []).length,
        updatedAt: list.updatedAt,
        previews: previewsByList.get(list.id) ?? [],
      }))
    );
  } catch (e) {
    logger.error('Failed to fetch lists', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Failed to fetch lists.' });
  }
});

listRoutes.post('/', isAuthenticated(), async (req, res, next) => {
  try {
    const name = String(req.body.name ?? '').trim();

    if (!name) {
      return next({ status: 400, message: 'A list name is required.' });
    }

    // Playlists only while music is set up and enabled for this user.
    const kind: MediaListKind = req.body.kind === 'music' ? 'music' : 'watch';
    if (kind === 'music' && !musicAllowed(req.user)) {
      return next({ status: 400, message: 'Music is not set up here.' });
    }

    const list = await getRepository(MediaList).save(
      new MediaList({
        name,
        kind,
        ownerId: req.user?.id as number,
        watchedSync: kind === 'watch' && req.body.watchedSync === true,
      })
    );

    return res.status(201).json({
      id: list.id,
      name: list.name,
      kind: list.kind,
      watchedSync: list.watchedSync,
    });
  } catch (e) {
    logger.error('Failed to create list', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Failed to create list.' });
  }
});

listRoutes.get<{ listId: string }>(
  '/:listId',
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
        where: { listId: access.list.id },
        order: { createdAt: 'DESC' },
      });

      const members = await getRepository(MediaListMember).find({
        where: { listId: access.list.id },
      });

      // Items store only a TMDB id, so hydrate them. Bounded concurrency keeps
      // a large list from bursting TMDB; repeat views hit the external-API
      // cache.
      const tmdb = new TheMovieDb();

      const hydrated = await mapWithConcurrency(items, 5, async (item) => {
        const base = {
          id: item.id,
          tmdbId: item.tmdbId,
          mediaType: item.mediaType,
          addedBy: item.addedBy
            ? { id: item.addedBy.id, displayName: item.addedBy.displayName }
            : null,
          watchedAt: item.watchedAt ?? null,
          watchedBy: item.watchedBy
            ? { id: item.watchedBy.id, displayName: item.watchedBy.displayName }
            : null,
          createdAt: item.createdAt,
        };

        try {
          // A series' episode total lets a partially available one show how
          // much is here.
          const found = await listTitle(tmdb, item.tmdbId, item.mediaType);

          return {
            ...base,
            ...found,
            posterPath: item.posterPath ?? found.posterPath,
          };
        } catch (e) {
          // A title TMDB no longer serves stays on the list, with its stored
          // poster.
          logger.debug('Could not hydrate a list item', {
            label: 'API',
            tmdbId: item.tmdbId,
            errorMessage: e instanceof Error ? e.message : String(e),
          });

          return { ...base, posterPath: item.posterPath ?? null };
        }
      });

      // Available episodes per series, from the episode sync's rows: two
      // queries for the page, not one per series and season.
      const availableEpisodes = new Map<number, number>();
      const tvTmdbIds = items
        .filter((item) => item.mediaType === 'tv')
        .map((item) => item.tmdbId);

      if (tvTmdbIds.length) {
        const tvMedia = await getRepository(Media).find({
          where: { tmdbId: In(tvTmdbIds), mediaType: MediaType.TV },
          relations: { seasons: true },
        });
        // None of a series' episodes count for a viewer whose libraries
        // don't hold it.
        await limitToLibraries(tvMedia, req.user);

        // Season id -> series, to attribute one grouped count without another
        // query.
        const seasonOwner = new Map<number, number>();

        for (const entry of tvMedia) {
          availableEpisodes.set(entry.tmdbId, 0);
          if (entry.outsideLibraries) {
            continue;
          }

          for (const season of entry.seasons ?? []) {
            // Specials never count towards availability.
            if (season.seasonNumber >= 1) {
              seasonOwner.set(season.id, entry.tmdbId);
            }
          }
        }

        if (seasonOwner.size) {
          const counts = await getRepository(Episode)
            .createQueryBuilder('episode')
            .select('episode.seasonId', 'seasonId')
            .addSelect('COUNT(*)', 'count')
            .where('episode.seasonId IN (:...seasonIds)', {
              seasonIds: [...seasonOwner.keys()],
            })
            .andWhere('episode.status = :status', {
              status: MediaStatus.AVAILABLE,
            })
            .groupBy('episode.seasonId')
            .getRawMany<{ seasonId: number; count: string }>();

          for (const row of counts) {
            const tmdbId = seasonOwner.get(Number(row.seasonId));

            if (tmdbId !== undefined) {
              availableEpisodes.set(
                tmdbId,
                (availableEpisodes.get(tmdbId) ?? 0) + Number(row.count)
              );
            }
          }
        }
      }

      const media = await Media.getRelatedMedia(
        req.user,
        items.map((item) => ({
          tmdbId: item.tmdbId,
          mediaType: item.mediaType,
        }))
      );

      // Watch sync suggests a title only once everyone on the list can be
      // checked, so tell the owner who can't: anyone without a media server
      // account.
      const source = watchSource();
      const cannotCheck =
        access.isOwner && source
          ? [
              access.list.owner,
              ...members
                .filter((m) => m.acceptedAt)
                .map((m) => m.user)
                .filter((user): user is User => !!user),
            ]
              .filter((user) => !source.viewerOf(user))
              .map((user) => ({ id: user.id, displayName: user.displayName }))
          : [];

      return res.status(200).json({
        id: access.list.id,
        name: access.list.name,
        kind: access.list.kind ?? 'watch',
        playlist:
          access.list.kind === 'music'
            ? await playlistView(access.list)
            : undefined,
        isOwner: access.isOwner,
        // Whether the viewer accepted the list; always true for the owner.
        accepted:
          access.isOwner ||
          members.some((m) => m.userId === req.user?.id && !!m.acceptedAt),
        watchedSync: access.list.watchedSync,
        cannotCheck,
        owner: {
          id: access.list.owner.id,
          displayName: access.list.owner.displayName,
        },
        members: members.map((m) => ({
          id: m.user?.id,
          displayName: m.user?.displayName,
          accepted: !!m.acceptedAt,
        })),
        items: hydrated.map((item) => ({
          ...item,
          availableEpisodes:
            item.mediaType === 'tv'
              ? (availableEpisodes.get(item.tmdbId) ?? 0)
              : undefined,
          mediaInfo: media.find(
            (m) => m.tmdbId === item.tmdbId && m.mediaType === item.mediaType
          ),
        })),
      });
    } catch (e) {
      logger.error('Failed to fetch list', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to fetch list.' });
    }
  }
);

listRoutes.put<{ listId: string }>(
  '/:listId',
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

      if (!access.isOwner) {
        return next({
          status: 403,
          message: 'Only the list owner can change it.',
        });
      }

      if (req.body.name !== undefined) {
        const name = String(req.body.name).trim();

        if (!name) {
          return next({ status: 400, message: 'A list name is required.' });
        }

        access.list.name = name;
      }

      if (typeof req.body.watchedSync === 'boolean') {
        access.list.watchedSync = req.body.watchedSync;
      }

      const listId = access.list.id;
      let newMembers: User[] = [];

      // One transaction, so a list is never left with old members removed and
      // new ones missing.
      const conflict = await dataSource.transaction(async (manager) => {
        if (Array.isArray(req.body.memberIds)) {
          const memberRepository = manager.getRepository(MediaListMember);

          // Membership becomes the supplied ids; the owner is never a member.
          const requested = (req.body.memberIds as unknown[])
            .map(Number)
            .filter((id) => Number.isFinite(id) && id !== access.list.ownerId);

          const users = requested.length
            ? await manager
                .getRepository(User)
                .find({ where: { id: In(requested) } })
            : [];

          // Lock so concurrent saves don't both start from the same members.
          // SQLite already serializes writes.
          if (manager.connection.options.type === 'postgres') {
            await manager
              .getRepository(MediaList)
              .createQueryBuilder('list')
              .select('list.id')
              .where('list.id = :listId', { listId })
              .setLock('pessimistic_write')
              .getOne();
          }

          const previous = await memberRepository.find({ where: { listId } });
          const previousIds = new Set(previous.map((member) => member.userId));

          // The sharing dialog sends who was on the list when it opened. If
          // that changed (someone left), saving would silently re-add them, so
          // refuse and let the owner review.
          if (Array.isArray(req.body.previousMemberIds)) {
            const startedFrom = new Set(
              (req.body.previousMemberIds as unknown[]).map(Number)
            );

            if (
              startedFrom.size !== previousIds.size ||
              [...previousIds].some((id) => !startedFrom.has(id))
            ) {
              return true;
            }
          }

          // Write only the differences, so remaining members keep their rows
          // and acceptance.
          const wanted = new Set(users.map((user) => user.id));
          const removed = previous.filter(
            (member) => !wanted.has(member.userId)
          );

          if (removed.length) {
            await memberRepository.delete({
              id: In(removed.map((member) => member.id)),
            });
          }

          // Compared with existing rows, so re-saving doesn't notify existing
          // members.
          newMembers = users.filter((user) => !previousIds.has(user.id));

          if (newMembers.length) {
            await memberRepository.insert(
              newMembers.map((user) => ({ listId, userId: user.id }))
            );
          }
        }

        await manager.getRepository(MediaList).update(listId, {
          name: access.list.name,
          watchedSync: access.list.watchedSync,
        });

        return false;
      });

      if (conflict) {
        return next({
          status: 409,
          message:
            'Who this list is shared with changed after you opened it. Open Share again to see who is on it now.',
        });
      }

      if (newMembers.length) {
        await notifyListShared(access.list, newMembers, req.user as User);
      }

      return res
        .status(200)
        .json({ id: access.list.id, name: access.list.name });
    } catch (e) {
      logger.error('Failed to update list', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to update list.' });
    }
  }
);

listRoutes.delete<{ listId: string }>(
  '/:listId',
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

      if (!access.isOwner) {
        return next({
          status: 403,
          message: 'Only the list owner can delete it.',
        });
      }

      await getRepository(MediaList).remove(access.list);

      return res.status(204).send();
    } catch (e) {
      logger.error('Failed to delete list', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to delete list.' });
    }
  }
);

/*
 * A member accepts a shared list. They see it once shared, but their watch
 * history is used for it (watch sync, room picks) only after accepting:
 * anyone can add anyone, which isn't consent to share what they watch.
 */
listRoutes.post<{ listId: string }>(
  '/:listId/membership',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const userId = req.user?.id as number;
      const access = await loadAccessibleList(
        Number(req.params.listId),
        userId
      );

      if (!access) {
        return next({ status: 404, message: 'List not found.' });
      }

      if (access.isOwner) {
        return next({
          status: 400,
          message: 'The owner does not need to accept their own list.',
        });
      }

      // Accepting again keeps the first acceptance time.
      await getRepository(MediaListMember).update(
        { listId: access.list.id, userId, acceptedAt: IsNull() },
        { acceptedAt: new Date() }
      );

      return res.status(204).send();
    } catch (e) {
      logger.error('Failed to accept list', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to accept list.' });
    }
  }
);

/*
 * A member leaves (or declines) a shared list, so nobody can force a list
 * into someone's view. The owner deletes their list instead.
 */
listRoutes.delete<{ listId: string }>(
  '/:listId/membership',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const userId = req.user?.id as number;
      const access = await loadAccessibleList(
        Number(req.params.listId),
        userId
      );

      if (!access) {
        return next({ status: 404, message: 'List not found.' });
      }

      if (access.isOwner) {
        return next({
          status: 400,
          message: 'The owner cannot leave their own list; delete it instead.',
        });
      }

      await getRepository(MediaListMember).delete({
        listId: access.list.id,
        userId,
      });

      return res.status(204).send();
    } catch (e) {
      logger.error('Failed to leave list', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to leave list.' });
    }
  }
);

export default listRoutes;
