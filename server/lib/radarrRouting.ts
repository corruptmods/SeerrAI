import type { SeriesType } from '@server/constants/seriesType';
import type { AnimeDecidedBy } from '@server/lib/animeDecision';
import { decideAnime } from '@server/lib/animeDecision';
import type { RadarrSettings } from '@server/lib/settings';
import type { AnimeSignals } from '@server/utils/isAnime';

export interface RadarrRouting {
  /** Whether the movie goes to Radarr as anime, and why. */
  anime: boolean;
  decidedBy: AnimeDecidedBy;
  rootFolder: string;
  qualityProfile: number;
  tags: number[];
}

/**
 * Where a movie goes in Radarr before anything a request itself overrides
 * (a folder, profile or tags chosen for it). The movie side of
 * lib/sonarrRouting.
 *
 * Whether it is anime is decided by decideAnime: 'anime' or 'standard' on
 * the request (ticked by whoever requested it, or set by an override rule),
 * then the title's own setting, then anime detection. Anime gets the server's anime folder, profile and tags,
 * where they are set, and its usual ones where they are not, so a server
 * with no anime settings sends every movie as it always has.
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
