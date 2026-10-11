import type { SeriesType } from '@server/constants/seriesType';
import type { AnimeDecidedBy } from '@server/lib/animeDecision';
import { decideAnime } from '@server/lib/animeDecision';
import type { SonarrSettings } from '@server/lib/settings';
import type { AnimeSignals } from '@server/utils/isAnime';

export interface SonarrRouting {
  /** Whether the series goes to Sonarr as anime, and why. */
  anime: boolean;
  decidedBy: AnimeDecidedBy;
  seriesType: SeriesType;
  rootFolder: string;
  qualityProfile: number;
  languageProfile: number | undefined;
  tags: number[];
}

/**
 * Where a series goes in Sonarr before anything a request itself overrides
 * (a folder, profile or tags chosen for it).
 *
 * Whether it is anime is decided by decideAnime. Anime gets the server's
 * anime folder, profiles, tags and series type, where they are set. A series
 * type set on the request is used as it is (a rule's daily type, say);
 * otherwise the server's own for that kind.
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
