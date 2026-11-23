import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type { AgentTool, TitleRef } from '@server/lib/agent/tools/base';
import { ToolError, readTitleRef } from '@server/lib/agent/tools/base';
import autofix from '@server/lib/autofix';
import backfill from '@server/lib/backfill/engine';
import { subtitlesReady } from '@server/lib/subtitles';
import { z } from 'zod';

/*
 * Subtitles for a library title, through Auto-fix as the admin: searched
 * for with Bazarr's providers (replacing those there, or only what is
 * missing), or transcribed from the audio with Whisper. Only subtitle files
 * change, so there is no approval step.
 */

/** The Seerr title a Sonarr or Radarr title is, if Seerr has it. */
const mediaOf = async (title: TitleRef): Promise<Media | null> => {
  const mediaType = title.kind === 'movie' ? MediaType.MOVIE : MediaType.TV;
  const media = getRepository(Media);
  const byService = await media.findOne({
    where: [
      {
        mediaType,
        serviceId: title.serverId,
        externalServiceId: title.arrId,
      },
      {
        mediaType,
        serviceId4k: title.serverId,
        externalServiceId4k: title.arrId,
      },
    ],
  });
  if (byService) return byService;
  if (title.kind === 'movie') {
    const movie = await backfill
      .radarrFor(title.serverId)
      .getMovieDetail(title.arrId);
    return media.findOne({ where: { mediaType, tmdbId: movie.tmdbId } });
  }
  const series = await backfill
    .sonarrFor(title.serverId)
    .getSeriesDetail(title.arrId);
  return media.findOne({
    where: series.tmdbId
      ? { mediaType, tmdbId: series.tmdbId }
      : { mediaType, tvdbId: series.tvdbId },
  });
};

export const fixSubtitles: AgentTool = {
  name: 'fix_subtitles',
  askOnly: true,
  acts: true,
  unavailable: () =>
    subtitlesReady()
      ? null
      : 'Bazarr is not set up, so subtitles cannot be fixed or transcribed.',
  description:
    "Gets subtitles for a movie or series through Bazarr, when the admin asks for subtitles to be fixed, replaced or made. Without season and episode it covers a whole series (specials aside); with season only, that season. replace: true replaces the subtitles there with another provider's (each episode in turn, in the background), false only fills what is missing. transcribe: true makes subtitles from the audio with Whisper instead, even where subtitles exist; redo: true also transcribes again what was transcribed before. language: a two-letter code, when the admin names one. Only subtitle files change; nothing to approve.",
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'A series or movie reference.',
      },
      season: { type: 'integer' },
      episode: { type: 'integer' },
      language: { type: 'string', description: 'Like en or es.' },
      replace: { type: 'boolean' },
      transcribe: { type: 'boolean' },
      redo: { type: 'boolean' },
    },
    required: ['title'],
  },
  async run(state, input) {
    const args = z
      .object({
        season: z.coerce.number().int().min(0).optional(),
        episode: z.coerce.number().int().min(0).optional(),
        language: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z]{2}$/)
          .optional(),
        replace: z.boolean().optional(),
        transcribe: z.boolean().optional(),
        redo: z.boolean().optional(),
      })
      .parse(input);
    const title = readTitleRef(input.title);
    if (title.kind === 'album') {
      throw new ToolError('Music has no subtitles.');
    }
    if (args.episode !== undefined && args.season === undefined) {
      throw new ToolError('Give the season the episode is in.');
    }
    const media = await mediaOf(title);
    if (!media) {
      throw new ToolError(
        'Seerr does not have this title, so its subtitles cannot be fixed here.'
      );
    }
    const tv = title.kind === 'series';
    const result = await autofix.run({
      kind: args.transcribe ? 'transcribe' : 'subtitles',
      media,
      seasonNumber: tv ? args.season : undefined,
      episodeNumber: tv ? args.episode : undefined,
      language: args.language,
      replace: args.replace,
      all: !!(args.replace || args.transcribe || args.redo),
      redo: args.redo,
      user: state.user,
    });
    if (!result.ok) throw new ToolError(result.message);
    return result.message;
  },
};
