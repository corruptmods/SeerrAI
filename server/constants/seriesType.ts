import { MediaType } from '@server/constants/media';

/** How Sonarr numbers and searches for a series' episodes. */
export const SERIES_TYPES = ['standard', 'daily', 'anime'] as const;

export type SeriesType = (typeof SERIES_TYPES)[number];

/** A series type from outside, or null for anything that is not one. */
export const toSeriesType = (value: unknown): SeriesType | null =>
  (SERIES_TYPES as readonly unknown[]).includes(value)
    ? (value as SeriesType)
    : null;

/**
 * A request's series type for its kind of media. Movies keep only whether
 * they are anime, as 'anime' or 'standard'; a movie has no daily type.
 */
export const toSeriesTypeFor = (
  mediaType: MediaType,
  value: unknown
): SeriesType | null => {
  const seriesType = toSeriesType(value);
  return mediaType === MediaType.MOVIE && seriesType === 'daily'
    ? null
    : seriesType;
};
