import type { MediaRequestStatus } from '@server/constants/media';
import type AlbumRequest from '@server/entity/AlbumRequest';
import type SongRequest from '@server/entity/SongRequest';

/** An album Lidarr is asked for: one requested, or a song's single. */
export interface LidarrTarget {
  /** Its MusicBrainz release-group id. */
  mbId: string;
  title: string;
}

/**
 * What a music request has Lidarr fetch: its albums, and the singles its
 * songs are fetched through, each once, albums first. Only those whose own
 * status is one of `statuses`, when given. A song only on albums brings
 * none.
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
