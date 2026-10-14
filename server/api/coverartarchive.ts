/*
 * The Cover Art Archive: album covers by MusicBrainz id. No key, and no
 * MusicBrainz request: an album's front cover is at a fixed address, which
 * redirects to archive.org, or answers 404 when there is none. Covers reach
 * people through the image proxy, as the `caa` source.
 */

export const COVER_ART_ARCHIVE_URL = 'https://coverartarchive.org';

/** The sizes the archive makes; null asks for the full-size original. */
export type CoverSize = 250 | 500 | 1200;

/** A release group's (an album's) front cover path, as the proxy takes it. */
export const albumCoverPath = (
  releaseGroupId: string,
  size: CoverSize | null = 500
): string => `/release-group/${releaseGroupId}/front${size ? `-${size}` : ''}`;

/** One release's front cover path, for ListenBrainz's caa_release_mbid. */
export const releaseCoverPath = (
  releaseId: string,
  size: CoverSize | null = 500
): string => `/release/${releaseId}/front${size ? `-${size}` : ''}`;

/** The address of an album's cover, for notifications sent outside Seerr. */
export const albumCoverUrl = (
  releaseGroupId: string,
  size: CoverSize | null = 500
): string => `${COVER_ART_ARCHIVE_URL}${albumCoverPath(releaseGroupId, size)}`;

/** What the image proxy lets through to the archive, and nothing else. */
export const COVER_PATH =
  /^\/(?:release-group|release)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/front(?:-(?:250|500|1200))?$/;
