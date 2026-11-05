import type { MediaRequestStatus } from '@server/constants/media';
import type AlbumRequest from '@server/entity/AlbumRequest';
import type SongRequest from '@server/entity/SongRequest';

/** An album sent to Lidarr: a requested album or a song's single. */
export interface LidarrTarget {
  /** MusicBrainz release-group id. */
  mbId: string;
  title: string;
}

/**
 * Albums Lidarr fetches for a request: its albums, then its songs' singles,
 * deduplicated, filtered by `statuses` when given. Songs with no single add
 * nothing.
 */
export const lidarrTargets = (
  request: { albums?: AlbumRequest[]; songs?: SongRequest[] },
  statuses?: MediaRequestStatus[]
): LidarrTarget[] => {
  const counts = (status: MediaRequestStatus) =>
    !statuses || statuses.includes(status);
  const targets = new Map<string, LidarrTarget>();
  for (const album of [...(request.albums ?? [])].sort((a, b) => a.id - b.id)) {
    if (counts(album.status) && !targets.has(album.albumMbid)) {
      targets.set(album.albumMbid, {
        mbId: album.albumMbid,
        title: album.title,
      });
    }
  }
  for (const song of [...(request.songs ?? [])].sort((a, b) => a.id - b.id)) {
    if (
      song.singleMbid &&
      counts(song.status) &&
      !targets.has(song.singleMbid)
    ) {
      targets.set(song.singleMbid, {
        mbId: song.singleMbid,
        title: song.singleTitle ?? song.title,
      });
    }
  }
  return [...targets.values()];
};
