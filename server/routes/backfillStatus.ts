import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { BackfillStatus } from '@server/interfaces/api/backfillStatus';
import backfill from '@server/lib/backfill/engine';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';
import { In, Not } from 'typeorm';

/*
 * For the person who asked for a title: whether Backfill is looking beyond
 * Sonarr's and Radarr's own search for it, or downloading what it found.
 * Only their own requests, and only that much: what was found, from where,
 * and waiting on whom is for admins.
 */

const backfillStatusRoutes = Router();

backfillStatusRoutes.get('/', async (req, res, next) => {
  try {
    const raw = req.query.tmdbIds as unknown;
    const tmdbIds = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 100);
    if (!tmdbIds.length || !getSettings().backfill.enabled) {
      return res.status(200).json([]);
    }

    // The titles among these that this person has an open request for.
    const own = await getRepository(MediaRequest)
      .createQueryBuilder('request')
      .innerJoin('request.media', 'media')
      .select('media.tmdbId', 'tmdbId')
      .addSelect('media.mediaType', 'mediaType')
      .where('request.requestedBy = :userId', { userId: req.user!.id })
      .andWhere('request.status = :status', {
        status: MediaRequestStatus.APPROVED,
      })
      .andWhere('media.tmdbId IN (:...tmdbIds)', { tmdbIds })
      .getRawMany<{ tmdbId: number | string; mediaType: MediaType }>();
    const asked = new Set(
      own.map(
        (r) =>
          `${r.mediaType === MediaType.MOVIE ? 'movie' : 'series'}:${Number(r.tmdbId)}`
      )
    );
    if (!asked.size) {
      return res.status(200).json([]);
    }

    const rows = (
      await getRepository(BackfillSeries).find({
        where: {
          tmdbId: In([...new Set(own.map((r) => Number(r.tmdbId)))]),
          status: Not(In(['done', 'ignored'])),
        },
      })
    ).filter((row) => asked.has(`${row.kind}:${row.tmdbId}`));
    const jobs = await backfill.withLiveProgress(
      await getRepository(BackfillJob).find({
        where: {
          seriesId: In(rows.map((row) => row.id)),
          status: In(['queued', 'downloading', 'paused', 'importing']),
        },
      })
    );

    const statuses: BackfillStatus[] = rows.map((row) => {
      const job = jobs.find((j) => j.seriesId === row.id);
      return {
        tmdbId: row.tmdbId!,
        mediaType: row.kind === 'movie' ? 'movie' : 'tv',
        ...(job
          ? { state: 'downloading' as const, progress: job.progress }
          : { state: 'looking' as const }),
      };
    });
    return res.status(200).json(statuses);
  } catch (e) {
    logger.error('Could not read Backfill status for requests', {
      label: 'Backfill',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return next({ status: 500, message: 'Something went wrong.' });
  }
});

export default backfillStatusRoutes;
