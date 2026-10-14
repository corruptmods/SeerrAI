import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import { In } from 'typeorm';

/**
 * Fills in, on each music request, whether each album asked for is here
 * yet, for the request cards: a request's own status only says whether it
 * was approved, not which of its albums have arrived. One query for any
 * number of requests; films and series are left as they are.
 */
export const attachAlbumStatuses = async (
  requests: Pick<MediaRequest, 'type' | 'media' | 'albums'>[]
): Promise<void> => {
  const music = requests.filter(
    (request) =>
      request.type === MediaType.MUSIC &&
      request.media?.id &&
      request.albums?.length
  );
  if (!music.length) {
    return;
  }

  const rows = await getRepository(MusicAlbum).find({
    select: { id: true, mediaId: true, mbId: true, status: true },
    where: {
      mediaId: In([...new Set(music.map((request) => request.media.id))]),
    },
  });
  const statusOf = new Map(
    rows.map((row) => [`${row.mediaId}:${row.mbId}`, row.status])
  );

  for (const request of music) {
    for (const album of request.albums) {
      album.albumStatus = statusOf.get(
        `${request.media.id}:${album.albumMbid}`
      );
    }
  }
};
