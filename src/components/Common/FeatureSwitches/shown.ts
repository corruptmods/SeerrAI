import type { Feature } from '@server/constants/features';
import { FEATURES } from '@server/constants/features';

/** The features to show: all but `hidden`, and music once Lidarr is set up. */
export const shownFeatures = (
  hidden: readonly Feature[],
  musicReady: boolean
): Feature[] =>
  FEATURES.filter(
    (feature) =>
      !hidden.includes(feature) && (feature !== 'music' || musicReady)
  );

/** Left out of Settings → Features: music is under Settings → Music. */
export const NOT_ON_FEATURES_PAGE: readonly Feature[] = ['music'];

/** Left out of Settings → Music, which has only the Music switch. */
export const NOT_ON_MUSIC_PAGE: readonly Feature[] = FEATURES.filter(
  (feature) => feature !== 'music'
);
