import type { SeriesType } from '@server/constants/seriesType';
import { getSettings } from '@server/lib/settings';
import type { AnimeSignals } from '@server/utils/isAnime';
import { isAnime } from '@server/utils/isAnime';

/**
 * Anime detection minus this server's excluded countries (Settings → Services →
 * Anime).
 */
export const detectAnime = (media: AnimeSignals): boolean =>
  isAnime(media, getSettings().main.animeExcludedCountries ?? []);

/** Who decided whether a title is anime. */
export type AnimeDecidedBy = 'title' | 'request' | 'detection';

/** Series type of the newest request with this `is4k` that has one. */
export const requestSeriesType = (
  requests: readonly {
    id: number;
    is4k: boolean;
    seriesType?: SeriesType | null;
  }[],
  is4k: boolean
): SeriesType | null =>
  requests
    .filter((r) => r.is4k === is4k && r.seriesType)
    .sort((a, b) => b.id - a.id)[0]?.seriesType ?? null;

/**
 * Whether a title is anime, and who decided: the request's series type, then
 * the title's own setting, then detection.
 *
 * A request only carries a rule's type that agrees with the title's setting
 * (MediaRequest.request), and saving the setting clears disagreeing request
 * types (lib/animePlacement), so the latest decision stands.
 */
export const decideAnime = (
  media: AnimeSignals,
  requestSeriesType?: SeriesType | null,
  animeSetting?: boolean | null
): { anime: boolean; decidedBy: AnimeDecidedBy } => {
  if (requestSeriesType) {
    return { anime: requestSeriesType === 'anime', decidedBy: 'request' };
  }
  if (animeSetting === true || animeSetting === false) {
    return { anime: animeSetting, decidedBy: 'title' };
  }
  return { anime: detectAnime(media), decidedBy: 'detection' };
};
