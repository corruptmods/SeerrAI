import type { Feature } from '@server/constants/features';
import { FEATURES } from '@server/constants/features';

/**
 * The features a list of switches shows: all but those left out, and music
 * only once it is there to switch (an admin has set up Lidarr).
 */
export const shownFeatures = (
  hidden: readonly Feature[],
  musicReady: boolean
): Feature[] =>
  FEATURES.filter(
    (feature) =>
      !hidden.includes(feature) && (feature !== 'music' || musicReady)
  );

/**
 * Left out of Settings → Features: music is switched on and off for
 * everyone under Settings → Music, which Features points to instead.
 */
export const NOT_ON_FEATURES_PAGE: readonly Feature[] = ['music'];

/** Left out of Settings → Music, which has the Music switch alone. */
export const NOT_ON_MUSIC_PAGE: readonly Feature[] = FEATURES.filter(
  (feature) => feature !== 'music'
);
