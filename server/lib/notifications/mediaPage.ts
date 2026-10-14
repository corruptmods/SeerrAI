import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';

/**
 * The page a notification about a title opens: the film's or series' page,
 * or for music the album asked for, or the artist's page when a request
 * asked for several. Music has no TMDB id to build the address from.
 */
export const mediaPagePath = (
  media: Pick<Media, 'mediaType' | 'tmdbId' | 'foreignId'>,
  request?: Pick<MediaRequest, 'albums'>
): string => {
  if (media.mediaType === MediaType.MUSIC) {
    const albums = request?.albums ?? [];
    return albums.length === 1
      ? `/music/album/${albums[0].albumMbid}`
      : `/music/artist/${media.foreignId}`;
  }
  return `/${media.mediaType}/${media.tmdbId}`;
};
