import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  KeepNotAllowedError,
  NotScheduledError,
  getDeletingSoon,
  isMaintainerrConfigured,
  keepTitle,
} from '@server/lib/deletingSoon';
import { featureEnabled } from '@server/lib/features';
import logger from '@server/logger';
import { Router } from 'express';
import { In } from 'typeorm';
import { z } from 'zod';

/*
 * What Maintainerr is about to delete, for badges and the home page row, and
 * the Keep button. Open to anyone signed in: seeing what is leaving and
 * asking to keep it are not admin actions. A Keep postpones rather than
 * excludes, so nobody can permanently shield a title from the rules.
 */
const maintainerrRoutes = Router();

/** TMDB ids looked up at once; well under SQLite's 999 bound parameters. */
const LOOKUP_CHUNK = 500;

maintainerrRoutes.get('/deleting', async (req, res, next) => {
  try {
    // Turned off, for everyone or for this person: nothing is shown.
    if (!featureEnabled('deletingSoon', req.user)) {
      return res.status(200).json({ enabled: false, items: [] });
    }
    const items = await getDeletingSoon();

    // Seerr's own media ids, which a card needs for its admin actions. A
    // TMDB id in their place would point those actions at the wrong record.
    // Looked up by TMDB id, a few hundred at a time and per kind: one
    // (tmdbId AND mediaType) OR ... term per title passed SQLite's limit of
    // 1000 once a rule matched that many, and failed for everyone.
    const rows: Pick<Media, 'id' | 'tmdbId' | 'mediaType'>[] = [];
    for (const mediaType of [MediaType.MOVIE, MediaType.TV]) {
      const ids = [
        ...new Set(
          items
            .filter((item) => item.mediaType === mediaType)
            .map((item) => item.tmdbId)
        ),
      ];
      for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
        rows.push(
          ...(await getRepository(Media).find({
            select: ['id', 'tmdbId', 'mediaType'],
            where: { mediaType, tmdbId: In(ids.slice(i, i + LOOKUP_CHUNK)) },
          }))
        );
      }
    }
    const mediaIds = new Map(
      rows.map((row) => [`${row.mediaType}:${row.tmdbId}`, row.id])
    );

    return res.status(200).json({
      enabled: isMaintainerrConfigured(),
      items: items.map((item) => ({
        mediaId: mediaIds.get(`${item.mediaType}:${item.tmdbId}`) ?? null,
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        deleteAt: item.deleteAt.toISOString(),
        showBadge: item.showBadge,
        showInRow: item.showInRow,
        canKeep: item.canKeep,
      })),
    });
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

const keepBody = z.object({
  tmdbId: z.number().int().positive(),
  mediaType: z.enum([MediaType.MOVIE, MediaType.TV]),
});

maintainerrRoutes.post('/keep', async (req, res, next) => {
  if (!isMaintainerrConfigured()) {
    return next({ status: 403, message: 'Maintainerr is not set up.' });
  }
  // Keeping is part of Deleting Soon: off, for everyone or for this person,
  // means off here too, not just a hidden button.
  if (!featureEnabled('deletingSoon', req.user)) {
    return next({ status: 403, message: 'Deleting Soon is turned off.' });
  }

  try {
    const { tmdbId, mediaType } = keepBody.parse(req.body);
    const still = await keepTitle(
      mediaType,
      tmdbId,
      req.user?.displayName ?? `user ${req.user?.id}`,
      req.user?.id
    );

    return res.status(200).json({
      deleteAt: still ? still.deleteAt.toISOString() : null,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return next({ status: 400, message: e.issues[0]?.message });
    }

    if (e instanceof KeepNotAllowedError) {
      return next({ status: 403, message: e.message });
    }

    if (e instanceof NotScheduledError) {
      return next({ status: 404, message: e.message });
    }

    logger.error('Could not keep a title', {
      label: 'Maintainerr',
      errorMessage: e.message,
    });
    return next({
      status: 502,
      message: 'Maintainerr did not accept the request. Try again shortly.',
    });
  }
});

export default maintainerrRoutes;
