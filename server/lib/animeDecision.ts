import type { SeriesType } from '@server/constants/seriesType';
import { getSettings } from '@server/lib/settings';
import type { AnimeSignals } from '@server/utils/isAnime';
import { isAnime } from '@server/utils/isAnime';

/**
 * Anime detection (utils/isAnime) under this server's setting of which
 * countries' anime is left out (Settings → Services → Anime).
 */
export const detectAnime = (media: AnimeSignals): boolean =>
  isAnime(media, getSettings().main.animeExcludedCountries ?? []);

/** Who decided whether a title is anime. */
export type AnimeDecidedBy = 'title' | 'request' | 'detection';

/**
 * Whether a title is anime, and who said so: the series type on its request
 * (ticked or unticked as Anime by whoever requested it, or set by an
 * override rule), then the title's own setting (set on its page), then anime
 * detection.
 *
 * A request only carries a rule's type that agrees with the title's setting
 * (MediaRequest.request), and saving the setting clears request types that
 * disagree with it (lib/animePlacement), so the latest decision is the one
 * that stands.
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
