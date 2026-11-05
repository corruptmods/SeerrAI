import type { SeriesType } from '@server/constants/seriesType';
import type { AnimeDecidedBy } from '@server/lib/animeDecision';
import { decideAnime } from '@server/lib/animeDecision';
import type { SonarrSettings } from '@server/lib/settings';
import type { AnimeSignals } from '@server/utils/isAnime';

export interface SonarrRouting {
  /** Whether the series goes to Sonarr as anime, and why (`decidedBy`). */
  anime: boolean;
  decidedBy: AnimeDecidedBy;
  seriesType: SeriesType;
  rootFolder: string;
  qualityProfile: number;
  languageProfile: number | undefined;
  tags: number[];
}

/**
 * Where a series goes in Sonarr before any request-level override (a chosen
 * folder, profile or tags).
 *
 * decideAnime decides anime. Anime gets the server's anime folder, profiles,
 * tags and series type where set. A series type on the request (e.g. a
 * rule's daily type) is used as is; otherwise the server's for that kind.
 */
export const sonarrRouting = (
  series: AnimeSignals,
  settings: SonarrSettings,
  chosenSeriesType?: SeriesType | null,
  animeSetting?: boolean | null
): SonarrRouting => {
  const { anime, decidedBy } = decideAnime(
    series,
    chosenSeriesType,
    animeSetting
  );

  return {
    anime,
    decidedBy,
    seriesType:
      chosenSeriesType ??
      (anime
        ? (settings.animeSeriesType ?? 'anime')
        : (settings.seriesType ?? 'standard')),
    rootFolder:
      anime && settings.activeAnimeDirectory
        ? settings.activeAnimeDirectory
        : settings.activeDirectory,
    qualityProfile:
      anime && settings.activeAnimeProfileId
        ? settings.activeAnimeProfileId
        : settings.activeProfileId,
    languageProfile:
      anime && settings.activeAnimeLanguageProfileId
        ? settings.activeAnimeLanguageProfileId
        : settings.activeLanguageProfileId,
    tags: [...((anime ? settings.animeTags : settings.tags) ?? [])],
  };
};
