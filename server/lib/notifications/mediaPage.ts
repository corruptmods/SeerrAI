import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';

/**
 * Page a notification opens. Music uses the album for a single-album request,
 * else the artist; it has no TMDB id.
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
