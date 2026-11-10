import type SonarrAPI from '@server/api/servarr/sonarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * A season can be requested once TMDB announces it, before TheTVDB (and so
 * Sonarr) lists it. Sonarr then has nothing to monitor, and a series set to
 * monitor no new seasons never picks it up. Such seasons are marked when sent;
 * the Sonarr scan keeps them coming instead of reading them as abandoned, and
 * monitors and searches them once Sonarr lists them.
 */

/**
 * Marks the request's seasons Sonarr doesn't list as waiting for it, and
 * clears the mark on those it now lists. Returns the waiting season numbers.
 */
export const markAwaitingSonarr = async (
  request: Pick<MediaRequest, 'id' | 'seasons'>,
  series: Pick<SonarrSeries, 'seasons'>
): Promise<number[]> => {
  const listed = new Set(series.seasons.map((season) => season.seasonNumber));
  const waiting = request.seasons.filter(
    (season) => !listed.has(season.seasonNumber)
  );
  const ready = request.seasons.filter((season) =>
    listed.has(season.seasonNumber)
  );
  const repository = getRepository(SeasonRequest);
  if (waiting.length) {
    await repository.update(
      { id: In(waiting.map((season) => season.id)) },
      { awaitingSonarr: true }
    );
    logger.info(
      'Sonarr does not list a requested season yet; it will be monitored once it does',
      {
        label: 'Media Request',
        requestId: request.id,
        seasons: waiting.map((season) => season.seasonNumber),
      }
    );
  }
  if (ready.length) {
    await repository.update(
      { id: In(ready.map((season) => season.id)), awaitingSonarr: true },
      { awaitingSonarr: false }
    );
  }
  return waiting.map((season) => season.seasonNumber);
};

/**
 * For one series on one Sonarr server: monitors and searches the waiting
 * seasons Sonarr now lists, and returns every waiting season number, listed or
 * not, so the scan counts them as coming. On any failure they stay waiting.
 */
export const settleAwaitingSeasons = async ({
  sonarr,
  series,
  tmdbId,
  serverId,
  is4k,
}: {
  sonarr: SonarrAPI;
  series: SonarrSeries;
  tmdbId: number;
  serverId: number;
  is4k: boolean;
}): Promise<Set<number>> => {
  const coming = new Set<number>();
  const media = await getRepository(Media).findOne({
    where: { tmdbId, mediaType: MediaType.TV },
  });
  if (!media) {
    return coming;
  }

  const waiting = (
    await getRepository(SeasonRequest).find({
      where: {
        awaitingSonarr: true,
        request: {
          media: { id: media.id },
          status: MediaRequestStatus.APPROVED,
          is4k,
        },
      },
      relations: { request: true },
    })
  ).filter(
    // A request for another server of the same kind is that server's.
    (season) =>
      season.request.serverId == null || season.request.serverId === serverId
  );
  waiting.forEach((season) => coming.add(season.seasonNumber));

  const listed = new Map(
    series.seasons.map((season) => [season.seasonNumber, season])
  );
  const ready = waiting.filter((season) => listed.has(season.seasonNumber));
  const seriesId = series.id;
  if (!ready.length || !seriesId) {
    return coming;
  }

  try {
    const unmonitored = ready
      .map((season) => season.seasonNumber)
      .filter((number) => !listed.get(number)?.monitored);
    if (unmonitored.length) {
      await sonarr.monitorSeasons(seriesId, unmonitored);
      // Loaded lazily: the subscriber imports most of the server.
      const { applySeasonMonitoring } =
        await import('@server/subscriber/MediaRequestSubscriber');
      const requestIds = [
        ...new Set(
          ready
            .filter((season) => unmonitored.includes(season.seasonNumber))
            .map((season) => season.request.id)
        ),
      ];
      for (const request of await getRepository(MediaRequest).find({
        where: { id: In(requestIds) },
        relations: { media: true },
      })) {
        await applySeasonMonitoring(sonarr, seriesId, request);
      }
    }
    await getRepository(SeasonRequest).update(
      { id: In(ready.map((season) => season.id)) },
      { awaitingSonarr: false }
    );
    logger.info('Sonarr now lists a requested season; it is monitored', {
      label: 'Sonarr Scan',
      tmdbId,
      seasons: ready.map((season) => season.seasonNumber),
    });
  } catch (e) {
    logger.warn('Could not monitor a requested season Sonarr now lists', {
      label: 'Sonarr Scan',
      tmdbId,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
  return coming;
};
