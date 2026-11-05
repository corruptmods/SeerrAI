import { MediaType } from '@server/constants/media';

/** How Sonarr numbers and searches for a series' episodes. */
export const SERIES_TYPES = ['standard', 'daily', 'anime'] as const;

export type SeriesType = (typeof SERIES_TYPES)[number];

/** A series type from untrusted input, or null if invalid. */
export const toSeriesType = (value: unknown): SeriesType | null =>
  (SERIES_TYPES as readonly unknown[]).includes(value)
    ? (value as SeriesType)
    : null;

/**
 * A request's series type for its media type. Movies only keep anime or not
 * ('anime' or 'standard'); they have no daily type.
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
