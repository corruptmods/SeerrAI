import type { SeriesType } from '@server/constants/seriesType';
import type { AnimeDecidedBy } from '@server/lib/animeDecision';
import { decideAnime } from '@server/lib/animeDecision';
import type { RadarrSettings } from '@server/lib/settings';
import type { AnimeSignals } from '@server/utils/isAnime';

export interface RadarrRouting {
  /** Whether the movie goes to Radarr as anime, and why (`decidedBy`). */
  anime: boolean;
  decidedBy: AnimeDecidedBy;
  rootFolder: string;
  qualityProfile: number;
  tags: number[];
}

/**
 * Where a movie goes in Radarr before any request-level override (a chosen
 * folder, profile or tags). The movie side of lib/sonarrRouting.
 *
 * decideAnime decides anime: 'anime' or 'standard' on the request (ticked by
 * the requester or set by an override rule), then the title's own setting,
 * then detection. Anime gets the server's anime folder, profile and tags where
 * set, else the usual ones, so a server without anime settings behaves as
 * before.
 */
export const radarrRouting = (
  movie: AnimeSignals,
  settings: RadarrSettings,
  chosenSeriesType?: SeriesType | null,
  animeSetting?: boolean | null
): RadarrRouting => {
  const { anime, decidedBy } = decideAnime(
    movie,
    chosenSeriesType === 'anime' || chosenSeriesType === 'standard'
      ? chosenSeriesType
      : null,
    animeSetting
  );

  return {
    anime,
    decidedBy,
    rootFolder:
      anime && settings.activeAnimeDirectory
        ? settings.activeAnimeDirectory
        : settings.activeDirectory,
    qualityProfile:
      anime && settings.activeAnimeProfileId
        ? settings.activeAnimeProfileId
        : settings.activeProfileId,
    tags: [
      ...((anime && settings.animeTags?.length
        ? settings.animeTags
        : settings.tags) ?? []),
    ],
  };
};
