import type { BazarrSearchResult } from '@server/api/bazarr';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type {
  NoneFoundOutcome,
  SubtitleSearchResponse,
} from '@server/interfaces/api/subtitlesInterfaces';
import { featureEnabled } from '@server/lib/features';
import { Permission } from '@server/lib/permissions';
import {
  movieDefault,
  seriesDefault,
  setMovieDefault,
  setSeriesDefault,
} from '@server/lib/plexSubtitles';
import {
  arrIdFor,
  bazarr,
  episodesToTranscribe,
  findEpisode,
  forgetEpisodeHistory,
  movieSubtitles,
  queueMovieTranscription,
  queueSeriesTranscription,
  searchEpisodeOrTranscribe,
  searchMissingMovieOrTranscribe,
  searchMissingSeriesOrTranscribe,
  searchMovieOrTranscribe,
  seriesSubtitles,
  subtitlesReady,
  toSearchResult,
  whisperOn,
  whisperUnavailable,
} from '@server/lib/subtitles';
import transcriber from '@server/lib/transcriber';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import type { NextFunction, Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';

/*
 * A title's subtitles, from Bazarr. Anyone signed in sees them and sets
 * the subtitle their own Plex player starts with; searching, downloading
 * and transcribing are for people who manage requests; deleting a file is
 * for admins. Off (no Bazarr, or the Subtitles switch off) means not found.
 */
const subtitleRoutes = Router();

const notFound = (message: string) => ({ status: 404, message });

subtitleRoutes.use((req, _res, next) => {
  if (!subtitlesReady() || !featureEnabled('subtitles', req.user)) {
    return next(notFound('Subtitles are not set up.'));
  }
  next();
});

const bazarrFailed = (next: NextFunction, e: unknown, what: string) => {
  logger.warn(`Bazarr could not ${what}`, {
    label: 'Subtitles',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  next({ status: 502, message: 'Bazarr did not answer.' });
};

const idParam = (value: string) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
};

type MediaKind = 'movie' | 'tv';
const MEDIA_TYPE: Record<MediaKind, MediaType> = {
  movie: MediaType.MOVIE,
  tv: MediaType.TV,
};

/** The title's Radarr or Sonarr id, or a "not found" already sent. */
const arrId = async (
  kind: MediaKind,
  tmdbIdParam: string,
  next: NextFunction
): Promise<number | undefined> => {
  const tmdbId = idParam(tmdbIdParam);
  const id = tmdbId ? await arrIdFor(MEDIA_TYPE[kind], tmdbId) : undefined;
  if (!id) {
    next(
      notFound(
        kind === 'movie'
          ? 'This movie is not in Radarr.'
          : 'This series is not in Sonarr.'
      )
    );
  }
  return id;
};

type EpisodeParams = {
  tmdbId: string;
  seasonNumber: string;
  episodeNumber: string;
};

/** The series' Sonarr id and Bazarr's episode, or a "not found" sent. */
const episodeOf = async (params: EpisodeParams, next: NextFunction) => {
  const seriesId = await arrId('tv', params.tmdbId, next);
  if (!seriesId) {
    return undefined;
  }
  const season = Number(params.seasonNumber);
  const number = Number(params.episodeNumber);
  const episode =
    Number.isInteger(season) && Number.isInteger(number)
      ? await findEpisode(seriesId, season, number)
      : undefined;
  if (!episode) {
    next(notFound('Bazarr does not have this episode.'));
    return undefined;
  }
  return { seriesId, episode };
};

// ---- What is on disk -------------------------------------------------------

subtitleRoutes.get<{ tmdbId: string }>(
  '/movie/:tmdbId',
  async (req, res, next) => {
    const radarrId = await arrId('movie', req.params.tmdbId, next);
    if (!radarrId) {
      return;
    }
    try {
      const subtitles = await movieSubtitles(radarrId);
      if (!subtitles) {
        return next(notFound('Bazarr does not have this movie.'));
      }
      return res.status(200).json(subtitles);
    } catch (e) {
      return bazarrFailed(next, e, 'list a movie’s subtitles');
    }
  }
);

subtitleRoutes.get<{ tmdbId: string }>(
  '/tv/:tmdbId',
  async (req, res, next) => {
    const seriesId = await arrId('tv', req.params.tmdbId, next);
    if (!seriesId) {
      return;
    }
    try {
      const subtitles = await seriesSubtitles(seriesId);
      if (!subtitles) {
        return next(notFound('Bazarr does not have this series.'));
      }
      return res.status(200).json(subtitles);
    } catch (e) {
      return bazarrFailed(next, e, 'list a series’ subtitles');
    }
  }
);

// ---- Searching and downloading ---------------------------------------------

const manage = isAuthenticated(Permission.MANAGE_REQUESTS);

/*
 * A search for a title's subtitles. Asked with `transcribeIfNone`, a
 * search where no provider has a subtitle the title is missing queues
 * Whisper's transcription of it instead, and says so in `noneFound`.
 */
// The API validator may already have made it a boolean.
const transcribeIfNone = (req: Request) =>
  ['true', '1'].includes(String(req.query.transcribeIfNone));

const searchResponse = (found: {
  results: BazarrSearchResult[];
  noneFound?: NoneFoundOutcome;
}): SubtitleSearchResponse => ({
  results: found.results.map(toSearchResult),
  ...(found.noneFound ? { noneFound: found.noneFound } : {}),
});

subtitleRoutes.get<{ tmdbId: string }>(
  '/movie/:tmdbId/search',
  manage,
  async (req, res, next) => {
    const radarrId = await arrId('movie', req.params.tmdbId, next);
    if (!radarrId) {
      return;
    }
    try {
      const found = transcribeIfNone(req)
        ? await searchMovieOrTranscribe(
            `movie:${idParam(req.params.tmdbId)}`,
            radarrId
          )
        : { results: await bazarr().searchMovie(radarrId) };
      return res.status(200).json(searchResponse(found));
    } catch (e) {
      return bazarrFailed(next, e, 'search for a movie’s subtitles');
    }
  }
);

subtitleRoutes.get<EpisodeParams>(
  '/tv/:tmdbId/season/:seasonNumber/episode/:episodeNumber/search',
  manage,
  async (req, res, next) => {
    const found = await episodeOf(req.params, next);
    if (!found) {
      return;
    }
    try {
      const searched = transcribeIfNone(req)
        ? await searchEpisodeOrTranscribe(
            `tv:${idParam(req.params.tmdbId)}`,
            found.seriesId,
            found.episode
          )
        : {
            results: await bazarr().searchEpisode(
              found.episode.sonarrEpisodeId
            ),
          };
      return res.status(200).json(searchResponse(searched));
    } catch (e) {
      return bazarrFailed(next, e, 'search for an episode’s subtitles');
    }
  }
);

const choiceBody = z.object({
  provider: z.string().min(1),
  subtitle: z.string().min(1),
  hi: z.boolean().default(false),
  forced: z.boolean().default(false),
  originalFormat: z.boolean().default(false),
});

subtitleRoutes.post<{ tmdbId: string }>(
  '/movie/:tmdbId/download',
  manage,
  async (req, res, next) => {
    const choice = choiceBody.safeParse(req.body);
    if (!choice.success) {
      return next({ status: 400, message: 'Choose a search result.' });
    }
    const radarrId = await arrId('movie', req.params.tmdbId, next);
    if (!radarrId) {
      return;
    }
    try {
      await bazarr().downloadMovie(radarrId, choice.data);
      return res.status(204).send();
    } catch (e) {
      return bazarrFailed(next, e, 'download a movie’s subtitle');
    }
  }
);

subtitleRoutes.post<EpisodeParams>(
  '/tv/:tmdbId/season/:seasonNumber/episode/:episodeNumber/download',
  manage,
  async (req, res, next) => {
    const choice = choiceBody.safeParse(req.body);
    if (!choice.success) {
      return next({ status: 400, message: 'Choose a search result.' });
    }
    const found = await episodeOf(req.params, next);
    if (!found) {
      return;
    }
    try {
      await bazarr().downloadEpisode(
        found.seriesId,
        found.episode.sonarrEpisodeId,
        choice.data
      );
      forgetEpisodeHistory(found.episode.sonarrEpisodeId);
      return res.status(204).send();
    } catch (e) {
      return bazarrFailed(next, e, 'download an episode’s subtitle');
    }
  }
);

/*
 * Bazarr's own search for what a title is missing, which can take a long
 * while; whatever it still lacks afterwards is transcribed with Whisper.
 * The title's transcription status follows both.
 */
const searchMissing = (run: () => Promise<number>, what: string) => {
  run().catch((e) =>
    logger.warn(`Bazarr could not search for ${what}`, {
      label: 'Subtitles',
      errorMessage: e instanceof Error ? e.message : String(e),
    })
  );
};

subtitleRoutes.post<{ tmdbId: string }>(
  '/movie/:tmdbId/search-missing',
  manage,
  async (req, res, next) => {
    const radarrId = await arrId('movie', req.params.tmdbId, next);
    if (radarrId) {
      const owner = `movie:${idParam(req.params.tmdbId)}`;
      searchMissing(
        () => searchMissingMovieOrTranscribe(owner, radarrId),
        'a movie’s missing subtitles'
      );
      res.status(202).json({
        ...transcriber.status(owner),
        transcribeAfter: await whisperOn(),
      });
    }
  }
);

subtitleRoutes.post<{ tmdbId: string }>(
  '/tv/:tmdbId/search-missing',
  manage,
  async (req, res, next) => {
    const seriesId = await arrId('tv', req.params.tmdbId, next);
    if (seriesId) {
      const owner = `tv:${idParam(req.params.tmdbId)}`;
      searchMissing(
        () => searchMissingSeriesOrTranscribe(owner, seriesId),
        'a series’ missing subtitles'
      );
      res.status(202).json({
        ...transcriber.status(owner),
        transcribeAfter: await whisperOn(),
      });
    }
  }
);

// ---- Deleting --------------------------------------------------------------

const admin = isAuthenticated(Permission.ADMIN);

subtitleRoutes.delete<{ tmdbId: string; subtitleId: string }>(
  '/movie/:tmdbId/subtitle/:subtitleId',
  admin,
  async (req, res, next) => {
    const radarrId = await arrId('movie', req.params.tmdbId, next);
    if (!radarrId) {
      return;
    }
    try {
      const movie = await bazarr().getMovie(radarrId);
      const subtitle = movie?.subtitles?.find(
        (s) => s.id === Number(req.params.subtitleId)
      );
      // Only a file can be deleted; a track inside the video stays.
      if (!subtitle?.path) {
        return next(notFound('That subtitle file is not there.'));
      }
      await bazarr().deleteMovieSubtitle(radarrId, subtitle);
      return res.status(204).send();
    } catch (e) {
      return bazarrFailed(next, e, 'delete a movie’s subtitle');
    }
  }
);

subtitleRoutes.delete<EpisodeParams & { subtitleId: string }>(
  '/tv/:tmdbId/season/:seasonNumber/episode/:episodeNumber/subtitle/:subtitleId',
  admin,
  async (req, res, next) => {
    const found = await episodeOf(req.params, next);
    if (!found) {
      return;
    }
    const subtitle = found.episode.subtitles?.find(
      (s) => s.id === Number(req.params.subtitleId)
    );
    if (!subtitle?.path) {
      return next(notFound('That subtitle file is not there.'));
    }
    try {
      await bazarr().deleteEpisodeSubtitle(
        found.seriesId,
        found.episode.sonarrEpisodeId,
        subtitle
      );
      forgetEpisodeHistory(found.episode.sonarrEpisodeId);
      return res.status(204).send();
    } catch (e) {
      return bazarrFailed(next, e, 'delete an episode’s subtitle');
    }
  }
);

// ---- Transcribing ----------------------------------------------------------

for (const kind of ['movie', 'tv'] as const) {
  subtitleRoutes.get<{ tmdbId: string }>(
    `/${kind}/:tmdbId/transcription`,
    (req, res) => {
      res
        .status(200)
        .json(transcriber.status(`${kind}:${idParam(req.params.tmdbId) ?? 0}`));
    }
  );
}

subtitleRoutes.post<{ tmdbId: string }>(
  '/movie/:tmdbId/transcription',
  manage,
  async (req, res, next) => {
    const radarrId = await arrId('movie', req.params.tmdbId, next);
    if (!radarrId) {
      return;
    }
    const paused = await whisperUnavailable();
    if (paused) {
      return next({ status: 409, message: paused });
    }
    const owner = `movie:${idParam(req.params.tmdbId)}`;
    const added = queueMovieTranscription(owner, radarrId);
    return res.status(202).json({ added, ...transcriber.status(owner) });
  }
);

const transcribeBody = z.object({
  scope: z.enum(['missing', 'season', 'notTranscribed', 'episode']),
  seasonNumber: z.number().int().min(0).optional(),
  episodeNumber: z.number().int().min(0).optional(),
});

export { episodesToTranscribe };

subtitleRoutes.post<{ tmdbId: string }>(
  '/tv/:tmdbId/transcription',
  manage,
  async (req, res, next) => {
    const body = transcribeBody.safeParse(req.body);
    if (
      !body.success ||
      (body.data.scope !== 'missing' &&
        body.data.scope !== 'notTranscribed' &&
        body.data.seasonNumber === undefined) ||
      (body.data.scope === 'episode' && body.data.episodeNumber === undefined)
    ) {
      return next({ status: 400, message: 'Choose which episodes.' });
    }
    const seriesId = await arrId('tv', req.params.tmdbId, next);
    if (!seriesId) {
      return;
    }
    const paused = await whisperUnavailable();
    if (paused) {
      return next({ status: 409, message: paused });
    }
    try {
      const owner = `tv:${idParam(req.params.tmdbId)}`;
      const added = await queueSeriesTranscription(
        owner,
        seriesId,
        body.data.scope,
        body.data.seasonNumber,
        body.data.episodeNumber
      );
      return res.status(202).json({ added, ...transcriber.status(owner) });
    } catch (e) {
      return bazarrFailed(next, e, 'list a series’ episodes');
    }
  }
);

// ---- The subtitle the viewer's own Plex player starts with -----------------

const ratingKeyOf = async (kind: MediaKind, tmdbIdParam: string) => {
  const tmdbId = idParam(tmdbIdParam);
  if (!tmdbId) {
    return undefined;
  }
  const media = await getRepository(Media).findOne({
    where: { tmdbId, mediaType: MEDIA_TYPE[kind] },
  });
  return media?.ratingKey ?? undefined;
};

const plexFailed = (next: NextFunction, e: unknown) => {
  logger.warn('Plex could not read or set a subtitle choice', {
    label: 'Subtitles',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  next({ status: 502, message: 'Plex did not answer.' });
};

const UNAVAILABLE = { available: false, options: [], selected: 0 };

subtitleRoutes.get<{ tmdbId: string }>(
  '/movie/:tmdbId/plex-default',
  async (req, res, next) => {
    const ratingKey = await ratingKeyOf('movie', req.params.tmdbId);
    if (!ratingKey || !req.user) {
      return res.status(200).json(UNAVAILABLE);
    }
    try {
      return res.status(200).json(await movieDefault(req.user.id, ratingKey));
    } catch (e) {
      return plexFailed(next, e);
    }
  }
);

subtitleRoutes.put<{ tmdbId: string }>(
  '/movie/:tmdbId/plex-default',
  async (req, res, next) => {
    const body = z
      .object({ streamId: z.number().int().min(0) })
      .safeParse(req.body);
    if (!body.success) {
      return next({ status: 400, message: 'Choose a subtitle.' });
    }
    const ratingKey = await ratingKeyOf('movie', req.params.tmdbId);
    if (!ratingKey || !req.user) {
      return next(notFound('This movie is not in Plex.'));
    }
    try {
      const done = await setMovieDefault(
        req.user.id,
        ratingKey,
        body.data.streamId
      );
      if (!done) {
        return next({ status: 409, message: 'Plex did not offer that.' });
      }
      return res.status(204).send();
    } catch (e) {
      return plexFailed(next, e);
    }
  }
);

subtitleRoutes.get<{ tmdbId: string }>(
  '/tv/:tmdbId/plex-default',
  async (req, res, next) => {
    const ratingKey = await ratingKeyOf('tv', req.params.tmdbId);
    if (!ratingKey || !req.user) {
      return res.status(200).json(UNAVAILABLE);
    }
    try {
      return res.status(200).json(await seriesDefault(req.user.id, ratingKey));
    } catch (e) {
      return plexFailed(next, e);
    }
  }
);

subtitleRoutes.put<{ tmdbId: string }>(
  '/tv/:tmdbId/plex-default',
  async (req, res, next) => {
    const body = z
      .object({ language: z.string().regex(/^[a-z]{0,3}$/) })
      .safeParse(req.body);
    if (!body.success) {
      return next({ status: 400, message: 'Choose a language.' });
    }
    const ratingKey = await ratingKeyOf('tv', req.params.tmdbId);
    if (!ratingKey || !req.user) {
      return next(notFound('This series is not in Plex.'));
    }
    try {
      const episodes = await setSeriesDefault(
        req.user.id,
        ratingKey,
        body.data.language
      );
      if (episodes === undefined) {
        return next({ status: 409, message: 'No Plex sign-in to use.' });
      }
      return res.status(202).json({ episodes });
    } catch (e) {
      return plexFailed(next, e);
    }
  }
);

export default subtitleRoutes;
