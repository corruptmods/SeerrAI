/*
 * Album covers by MusicBrainz id, keyless and without a MusicBrainz request:
 * the front cover's fixed address redirects to archive.org, or 404s when
 * missing. Served through the image proxy as the `caa` source.
 */

export const COVER_ART_ARCHIVE_URL = 'https://coverartarchive.org';

/** Archive thumbnail sizes; null requests the full-size original. */
export type CoverSize = 250 | 500 | 1200;

/** A release group's front cover path, as the proxy takes it. */
export const albumCoverPath = (
  releaseGroupId: string,
  size: CoverSize | null = 500
): string => `/release-group/${releaseGroupId}/front${size ? `-${size}` : ''}`;

/** One release's front cover path, for ListenBrainz's caa_release_mbid. */
export const releaseCoverPath = (
  releaseId: string,
  size: CoverSize | null = 500
): string => `/release/${releaseId}/front${size ? `-${size}` : ''}`;

/** Absolute album cover URL, for notifications sent outside Seerr. */
export const albumCoverUrl = (
  releaseGroupId: string,
  size: CoverSize | null = 500
): string => `${COVER_ART_ARCHIVE_URL}${albumCoverPath(releaseGroupId, size)}`;

/** The only paths the image proxy forwards to the archive. */
export const COVER_PATH =
  /^\/(?:release-group|release)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/front(?:-(?:250|500|1200))?$/;
