import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';

/**
 * The page a notification about a title opens: the film's or series' page,
 * or for music the album asked for, or the artist's page when a request
 * asked for several or for songs. Music has no TMDB id to build the
 * address from.
 */
export const mediaPagePath = (
  media: Pick<Media, 'mediaType' | 'tmdbId' | 'foreignId'>,
  request?: Pick<MediaRequest, 'albums' | 'songs'>
): string => {
  if (media.mediaType === MediaType.MUSIC) {
    const albums = request?.albums ?? [];
    return albums.length === 1 && !request?.songs?.length
      ? `/music/album/${albums[0].albumMbid}`
      : `/music/artist/${media.foreignId}`;
  }
  return `/${media.mediaType}/${media.tmdbId}`;
};
