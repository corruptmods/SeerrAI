/**
 * Creating, reading, sharing and deleting lists themselves.
 */
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
import { loadAccessibleList } from '@server/lib/listAccess';
import { notifyListShared } from '@server/lib/listActivity';
import { musicAllowed, playlistView } from '@server/lib/playlists/view';
import { getSettings } from '@server/lib/settings';
import { watchSource } from '@server/lib/watchHistory';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { Router } from 'express';
import { In, IsNull, Not } from 'typeorm';

const listRoutes = Router();

/** Posters warmed for each list card, and for the whole page at most. */
const PREVIEWS_WARMED = 9;
const PREVIEWS_WARMED_TOTAL = 90;

/**
 * Posters sent for each list card. A card rotates through a few at a time,
 * so a list of hundreds does not need hundreds of them in the page.
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

    // Artwork for the overview. Poster paths are stored on the item, so this
    // normally costs no TMDB calls at all — fetching one per title is what
    // limited a card to rotating through a fixed handful.
    const tmdb = new TheMovieDb();
    const all = [...owned, ...shared];

    // Fill in anything added before posters were stored, or that failed at
    // the time. Bounded, and written back so it only happens once.
    //
    // Interleaved across lists rather than taken in order: a single large
    // list would otherwise consume the whole budget and leave every other
    // card with blank tiles until later loads.
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

      /*
       * Fetch in parallel — TMDB is the slow part — but write in one pass
       * afterwards. Interleaving writes with the fetches meant several
       * database calls in flight at once, which is what pg's "client is
       * already executing a query" warning objects to.
       */
      const fetched = await mapWithConcurrency(missing, 4, async (item) => {
        try {
          const posterPath =
            item.mediaType === 'movie'
              ? (await tmdb.getMovie({ movieId: item.tmdbId })).poster_path
              : (await tmdb.getTvShow({ tvId: item.tmdbId })).poster_path;

          return posterPath ? { item, posterPath } : null;
        } catch (e) {
          // Left for the next load rather than failing the page, but a poster
          // that never resolves would otherwise retry forever in silence.
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

      // Prefer titles still to watch: a card showing only finished things
      // tells you nothing at a glance.
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

    // The cards' posters, into the image cache as the page goes out, so
    // they are there when it is drawn. Cards open on posters from anywhere
    // in their lists, so a good share of each, within a cap for the page.
    if (getSettings().main.cacheImages) {
      const paths = [...previewsByList.values()]
        .flatMap((previews) =>
          (previews as { posterPath: string }[]).slice(0, PREVIEWS_WARMED)
        )
        .slice(0, PREVIEWS_WARMED_TOTAL)
        .map((preview) => `/t/p/w342${preview.posterPath}`);
      setImmediate(() => warmTmdbImages(paths));
    }

    // A playlist's card shows its songs' album covers.
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

    // A playlist only while music is set up and on for this person.
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

// Which of the caller's accessible lists already contain a title. Registered
// before "/:listId" so the literal path is matched first.
// Everything the current user has marked, in one request. Cards need this to
// badge posters, and a lookup per card would be dozens of requests per page —
// SWR de-duplicates this single key across every card instead.

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

      // Items store only a tmdb id, so hydrate them for display. Bounded
      // concurrency keeps a large list from bursting TMDB; responses are
      // served from Seerr's existing external-API cache on repeat views.
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
          if (item.mediaType === 'movie') {
            const movie = await tmdb.getMovie({ movieId: item.tmdbId });

            return {
              ...base,
              title: movie.title,
              posterPath: item.posterPath ?? movie.poster_path,
              releaseDate: movie.release_date,
            };
          }

          const tv = await tmdb.getTvShow({ tvId: item.tmdbId });

          return {
            ...base,
            title: tv.name,
            posterPath: item.posterPath ?? tv.poster_path,
            releaseDate: tv.first_air_date,
            // Total real episodes, ignoring specials, so a partially
            // available show can say how much of it is actually here.
            totalEpisodes: (tv.seasons ?? [])
              .filter((season) => season.season_number > 0)
              .reduce(
                (total, season) => total + (season.episode_count ?? 0),
                0
              ),
          };
        } catch (e) {
          // A title TMDB no longer serves still belongs on the list, and the
          // stored poster means it still has artwork.
          logger.debug('Could not hydrate a list item', {
            label: 'API',
            tmdbId: item.tmdbId,
            errorMessage: e instanceof Error ? e.message : String(e),
          });

          return { ...base, posterPath: item.posterPath ?? null };
        }
      });

      // How many episodes of each series are actually available, from the
      // rows the episode sync maintains.
      //
      // Two queries for the whole page rather than one Media lookup per
      // series plus one Episode count per season — a list of twenty shows
      // with five seasons each was over a hundred round trips.
      const availableEpisodes = new Map<number, number>();
      const tvTmdbIds = items
        .filter((item) => item.mediaType === 'tv')
        .map((item) => item.tmdbId);

      if (tvTmdbIds.length) {
        const tvMedia = await getRepository(Media).find({
          where: { tmdbId: In(tvTmdbIds), mediaType: MediaType.TV },
          relations: { seasons: true },
        });

        // Season id -> the series it belongs to, so one grouped count can be
        // attributed back without another query.
        const seasonOwner = new Map<number, number>();

        for (const entry of tvMedia) {
          availableEpisodes.set(entry.tmdbId, 0);

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

      // Watch sync only suggests a title once everyone on the list can be
      // checked, so the owner is told who cannot be: anyone without an
      // account on the media server.
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
        // Whether the viewer has accepted the list. The owner always has.
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

      // One change: if any part fails, none of it is kept, so a list is never
      // left with its old members removed and the new ones missing.
      const conflict = await dataSource.transaction(async (manager) => {
        if (Array.isArray(req.body.memberIds)) {
          const memberRepository = manager.getRepository(MediaListMember);

          // Membership is set to the ids supplied. The owner is never a
          // member of their own list.
          const requested = (req.body.memberIds as unknown[])
            .map(Number)
            .filter((id) => Number.isFinite(id) && id !== access.list.ownerId);

          const users = requested.length
            ? await manager
                .getRepository(User)
                .find({ where: { id: In(requested) } })
            : [];

          // Two saves at once must not both work from the same members.
          // SQLite runs one write at a time already.
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

          // The sharing dialog says who was on the list when it opened. If
          // that has changed since (someone left), saving it would quietly
          // put them back, so it is refused and the owner looks again.
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

          // Only the differences are written, so people who stay on the list
          // keep their rows, and with them whether they have accepted it.
          const wanted = new Set(users.map((user) => user.id));
          const removed = previous.filter(
            (member) => !wanted.has(member.userId)
          );

          if (removed.length) {
            await memberRepository.delete({
              id: In(removed.map((member) => member.id)),
            });
          }

          // Worked out against the rows already there, so re-saving the
          // sharing dialog does not notify people who were already on it.
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
 * Someone a list was shared with accepts it. They can see a list as soon as
 * it is shared, but their watch history is only used for it (watch sync,
 * picks for a room) once they accept: anyone can add anyone to a list, and
 * that alone is not agreeing to share what they watch.
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

      // Accepting again keeps the first time.
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
 * Someone a list was shared with can leave it, which is also how they turn
 * it down: anyone could otherwise put a list in someone's view for good.
 * The owner deletes their list instead.
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

// Anyone who can see a list can curate it; membership is the owner's call.

export default listRoutes;
