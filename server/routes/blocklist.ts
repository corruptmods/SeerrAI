import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { BlocklistResultsResponse } from '@server/interfaces/api/blocklistInterfaces';
import { removeBlocklistedFromLibrary } from '@server/lib/blocklistRemoval';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { isUniqueViolation } from '@server/utils/isUniqueViolation';
import { withNestedTransaction } from '@server/utils/nestedTransaction';
import { pageOf } from '@server/utils/pagination';
import { Router } from 'express';
import type { EntityManager } from 'typeorm';
import { EntityNotFoundError, In, QueryFailedError } from 'typeorm';
import { z } from 'zod';

const blocklistRoutes = Router();

/*
 * A title taken off the blocklist. One that only exists because it was
 * blocklisted is removed. One with requests or issues is kept and reset
 * instead: removing it would cascade and delete that history, which matters
 * now that titles already requested or downloaded can be blocklisted, one
 * at a time or a whole collection at once.
 */
const releaseBlocklistedMedia = async (
  mediaItem: Media,
  manager: EntityManager = getRepository(Media).manager
) => {
  const [requests, issues] = await Promise.all([
    manager
      .getRepository(MediaRequest)
      .countBy({ media: { id: mediaItem.id } }),
    manager.getRepository(Issue).countBy({ media: { id: mediaItem.id } }),
  ]);

  if (requests || issues) {
    await manager.getRepository(Media).update(mediaItem.id, {
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
    });
  } else {
    await manager.getRepository(Media).remove(mediaItem);
  }
};

export const blocklistAdd = z.object({
  tmdbId: z.coerce.number(),
  mediaType: z.enum([MediaType.MOVIE, MediaType.TV]),
  title: z.coerce.string().optional(),
  /** Ignored: an entry is always credited to whoever adds it. */
  user: z.coerce.number().optional(),
  blocklistedTags: z.string().optional(),
  /**
   * Also remove it from Radarr/Sonarr, deleting its files. Admin only: this
   * is the one blocklist action that destroys data.
   */
  removeFiles: z.boolean().optional(),
  /** Why it was blocklisted. Shown on the blocklist and in the title's history. */
  reason: z.string().trim().max(500).optional(),
});

const blocklistCollectionBody = z
  .object({ reason: z.string().trim().max(500).optional() })
  .optional();

const blocklistGet = z.object({
  search: z.string().optional(),
  filter: z.enum(['all', 'manual', 'blocklistedTags']).optional(),
});

blocklistRoutes.get(
  '/',
  isAuthenticated([Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST], {
    type: 'or',
  }),
  async (req, res, next) => {
    const parsed = blocklistGet.safeParse(req.query);
    if (!parsed.success) {
      return next({ status: 400, message: 'Invalid search or filter.' });
    }
    const { search, filter } = parsed.data;
    const { pageSize: take, skip } = pageOf(req.query, 25);

    try {
      let query = getRepository(Blocklist)
        .createQueryBuilder('blocklist')
        .leftJoinAndSelect('blocklist.user', 'user')
        .where('1 = 1'); // Allow use of andWhere later

      switch (filter) {
        case 'manual':
          query = query.andWhere('blocklist.blocklistedTags IS NULL');
          break;
        case 'blocklistedTags':
          query = query.andWhere('blocklist.blocklistedTags IS NOT NULL');
          break;
      }

      if (search) {
        query = query.andWhere('blocklist.title like :title', {
          title: `%${search}%`,
        });
      }

      const [blocklistedItems, itemsCount] = await query
        .orderBy('blocklist.createdAt', 'DESC')
        .take(take)
        .skip(skip)
        .getManyAndCount();

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(itemsCount / take),
          pageSize: take,
          results: itemsCount,
          page: Math.ceil(skip / take) + 1,
        },
        results: blocklistedItems,
      } as BlocklistResultsResponse);
    } catch (error) {
      logger.error('Something went wrong while retrieving blocklisted items', {
        label: 'Blocklist',
        errorMessage: error.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve blocklisted items.',
      });
    }
  }
);

blocklistRoutes.get(
  '/:id',
  isAuthenticated([Permission.MANAGE_BLOCKLIST], {
    type: 'or',
  }),
  async (req, res, next) => {
    const mediaType = req.query.mediaType;
    if (mediaType !== MediaType.MOVIE && mediaType !== MediaType.TV) {
      return next({
        status: 400,
        message: 'Invalid or missing mediaType query parameter.',
      });
    }

    try {
      const blocklisteRepository = getRepository(Blocklist);

      const blocklistItem = await blocklisteRepository.findOneOrFail({
        where: {
          tmdbId: Number(req.params.id),
          mediaType,
        },
      });

      return res.status(200).send(blocklistItem);
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return next({
          status: 404,
          message: e.message,
        });
      }
      return next({ status: 500, message: e.message });
    }
  }
);

blocklistRoutes.post(
  '/',
  isAuthenticated([Permission.MANAGE_BLOCKLIST], {
    type: 'or',
  }),
  async (req, res, next) => {
    try {
      const body = blocklistAdd.parse(req.body);
      const removeFiles = body.removeFiles;
      // Credited to whoever adds it, whatever the body says. Blank after
      // trimming means no reason, not an empty one.
      const values = {
        tmdbId: body.tmdbId,
        mediaType: body.mediaType,
        title: body.title,
        blocklistedTags: body.blocklistedTags,
        user: req.user,
        reason: body.reason || undefined,
      };

      // Checked before anything is written, so a refused request changes
      // nothing rather than leaving a blocklist entry behind.
      if (removeFiles && !req.user?.hasPermission(Permission.ADMIN)) {
        return next({
          status: 403,
          message: 'Only an admin can remove files while blocklisting.',
        });
      }

      // Also declines its pending and approved requests, files removed or
      // not, so none of them can be approved and sent on afterwards.
      const declinedRequests = await Blocklist.addToBlocklist({
        blocklistRequest: values,
      });

      await recordMediaEvent({
        tmdbId: values.tmdbId,
        mediaType: values.mediaType,
        type: MediaEventType.BLOCKLISTED,
        userId: req.user?.id,
        detail: values.reason,
      });

      if (!removeFiles) {
        return res.status(201).send();
      }

      const removal = await removeBlocklistedFromLibrary(
        values.tmdbId,
        values.mediaType
      );

      if (removal.removedFrom.length) {
        await recordMediaEvent({
          tmdbId: values.tmdbId,
          mediaType: values.mediaType,
          type: MediaEventType.FILES_REMOVED,
          userId: req.user?.id,
          detail: removal.removedFrom.join(', '),
        });
      }

      return res.status(201).json({
        ...removal,
        declinedRequests: declinedRequests + removal.declinedRequests,
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        return;
      }

      // A malformed body — a reason that is too long, say — is the caller's
      // mistake, not a server fault.
      if (error instanceof z.ZodError) {
        return next({ status: 400, message: error.issues[0]?.message });
      }

      if (error instanceof QueryFailedError) {
        // Checked for both engines: this used to test SQLite's errno 19
        // only, so on Postgres a duplicate came back as a vague 409.
        if (isUniqueViolation(error)) {
          return next({ status: 412, message: 'Item already blocklisted' });
        }

        logger.warn('Something wrong with data blocklist', {
          tmdbId: req.body.tmdbId,
          mediaType: req.body.mediaType,
          label: 'Blocklist',
        });
        return next({ status: 409, message: 'Something wrong' });
      }

      return next({ status: 500, message: error.message });
    }
  }
);

blocklistRoutes.post(
  '/collection/:id',
  isAuthenticated([Permission.MANAGE_BLOCKLIST], {
    type: 'or',
  }),
  async (req, res, next) => {
    try {
      const reason = blocklistCollectionBody.parse(req.body)?.reason || null;
      const tmdb = new TheMovieDb();
      const collection = await tmdb.getCollection({
        collectionId: Number(req.params.id),
        language: req.locale,
      });

      const uniqueParts = [
        ...new Map(collection.parts.map((p) => [p.id, p])).values(),
      ];
      const partIds = uniqueParts.map((p) => p.id);
      if (partIds.length === 0) {
        return res.status(201).send();
      }

      await dataSource.transaction(async (em) => {
        const blocklistRepository = em.getRepository(Blocklist);
        const mediaRepository = em.getRepository(Media);

        const [existingBlocklists, existingMedia] = await Promise.all([
          blocklistRepository.find({
            where: { tmdbId: In(partIds), mediaType: MediaType.MOVIE },
          }),
          mediaRepository.find({
            where: { tmdbId: In(partIds), mediaType: MediaType.MOVIE },
          }),
        ]);
        const blocklistByTmdbId = new Map(
          existingBlocklists.map((b) => [b.tmdbId, b])
        );
        const mediaByTmdbId = new Map(existingMedia.map((m) => [m.tmdbId, m]));

        // One film at a time: each insert has a savepoint of its own, and
        // savepoints taken side by side on one transaction would undo each
        // other's work.
        for (const part of uniqueParts) {
          if (blocklistByTmdbId.has(part.id)) {
            continue;
          }

          let blocklist = new Blocklist({
            tmdbId: part.id,
            mediaType: MediaType.MOVIE,
            title: part.title,
            user: req.user,
            reason,
          });

          try {
            // In a savepoint: on Postgres a failed insert aborts the whole
            // transaction otherwise, and the film blocklisted meanwhile by
            // someone else could not be picked up below.
            await withNestedTransaction(em, (nested) =>
              nested.getRepository(Blocklist).save(blocklist)
            );
            await recordMediaEvent(
              {
                tmdbId: part.id,
                mediaType: MediaType.MOVIE,
                type: MediaEventType.BLOCKLISTED,
                userId: req.user?.id,
                detail: reason,
              },
              em
            );
          } catch (error) {
            if (!isUniqueViolation(error)) {
              throw error;
            }
            const row = await blocklistRepository.findOne({
              where: { tmdbId: part.id, mediaType: MediaType.MOVIE },
            });
            if (!row) {
              throw error;
            }
            blocklist = row;
          }

          let media = mediaByTmdbId.get(part.id);
          if (!media) {
            media = new Media({
              tmdbId: part.id,
              status: MediaStatus.BLOCKLISTED,
              status4k: MediaStatus.BLOCKLISTED,
              mediaType: MediaType.MOVIE,
              blocklist: Promise.resolve(blocklist),
            });
          } else {
            media.status = MediaStatus.BLOCKLISTED;
            media.status4k = MediaStatus.BLOCKLISTED;
            media.blocklist = Promise.resolve(blocklist);
          }

          await mediaRepository.save(media);
          await Blocklist.declineOpenRequests(media.id, em);
        }
      });

      return res.status(201).send();
    } catch (e) {
      if (e instanceof z.ZodError) {
        return next({ status: 400, message: e.issues[0]?.message });
      }

      logger.error('Error blocklisting collection', {
        label: 'Blocklist',
        errorMessage: e.message,
        collectionId: req.params.id,
      });
      return next({ status: 500, message: e.message });
    }
  }
);

blocklistRoutes.delete(
  '/:id',
  isAuthenticated([Permission.MANAGE_BLOCKLIST], {
    type: 'or',
  }),
  async (req, res, next) => {
    const mediaType = req.query.mediaType;
    if (mediaType !== MediaType.MOVIE && mediaType !== MediaType.TV) {
      return next({
        status: 400,
        message: 'Invalid or missing mediaType query parameter.',
      });
    }

    try {
      const blocklisteRepository = getRepository(Blocklist);

      const blocklistItem = await blocklisteRepository.findOneOrFail({
        where: {
          tmdbId: Number(req.params.id),
          mediaType,
        },
      });

      await blocklisteRepository.remove(blocklistItem);
      await recordMediaEvent({
        tmdbId: Number(req.params.id),
        mediaType,
        type: MediaEventType.UNBLOCKLISTED,
        userId: req.user?.id,
      });

      const mediaRepository = getRepository(Media);

      const mediaItem = await mediaRepository.findOneOrFail({
        where: {
          tmdbId: Number(req.params.id),
          mediaType: req.query.mediaType as MediaType,
        },
      });

      await releaseBlocklistedMedia(mediaItem);

      return res.status(204).send();
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return next({
          status: 404,
          message: e.message,
        });
      }
      return next({ status: 500, message: e.message });
    }
  }
);

blocklistRoutes.delete(
  '/collection/:id',
  isAuthenticated([Permission.MANAGE_BLOCKLIST], {
    type: 'or',
  }),
  async (req, res, next) => {
    try {
      const tmdb = new TheMovieDb();
      const collection = await tmdb.getCollection({
        collectionId: Number(req.params.id),
        language: req.locale,
      });

      await dataSource.transaction(async (em) => {
        const blocklistRepository = em.getRepository(Blocklist);
        const mediaRepository = em.getRepository(Media);

        await Promise.all(
          collection.parts.map(async (part) => {
            const blocklistItem = await blocklistRepository.findOne({
              where: { tmdbId: part.id, mediaType: MediaType.MOVIE },
            });

            if (blocklistItem) {
              await blocklistRepository.remove(blocklistItem);
              await recordMediaEvent({
                tmdbId: blocklistItem.tmdbId,
                mediaType: MediaType.MOVIE,
                type: MediaEventType.UNBLOCKLISTED,
                userId: req.user?.id,
              });

              const mediaItem = await mediaRepository.findOne({
                where: { tmdbId: part.id, mediaType: MediaType.MOVIE },
              });

              if (mediaItem) {
                await releaseBlocklistedMedia(mediaItem, em);
              }
            }
          })
        );
      });

      return res.status(204).send();
    } catch (e) {
      logger.error('Error unblocklisting collection', {
        label: 'Blocklist',
        errorMessage: e.message,
        collectionId: req.params.id,
      });
      return next({ status: 500, message: e.message });
    }
  }
);

export default blocklistRoutes;
